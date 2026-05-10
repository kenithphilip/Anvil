// Format-template marketplace engine. Bet 2.
//
// Three public entry points consumed by the HTTP endpoints + the
// dispatcher's L3.5 step:
//
//   publishTemplate(svc, ctx, opts)
//     Takes a customer_format_templates id, validates every
//     safeguard, redacts, and inserts a customer_format_templates_global
//     row. Returns { ok, global_id, report } on success or
//     { ok: false, blocked_by, reasons[] } on rejection.
//
//   findGlobalCandidates(svc, { kind, fingerprint, bodyText })
//     Scores every status='approved' row against the supplied
//     fingerprint + body text. Returns the top N (default 5)
//     sorted by combined score.
//
//   applyGlobalTemplate(svc, ctx, { globalId, customerId, bodyText })
//     Walks the global template's anchors against bodyText, returns
//     the known-fields shape the dispatcher hints to L4 + the
//     normalized customer block.  Writes a template_imports row in
//     hint mode by default.
//
// Safeguards applied across this file:
//
//   - Triple-gate opt-in (tenant + customer + per-template).
//   - k-anonymity >= 5 on publish.
//   - Regex safety: validateAnchorSafety on every anchor at publish
//     time, AND safeMatch (input-cap + capture-span cap) on every
//     match at apply time.
//   - PII redaction on labels + total strip of sample_value.
//   - Rate limit: max 10 publications per tenant per day.
//   - Three confirmed abuse reports auto-suspend the publisher.
//
// Pure aside from DB I/O; no LLM calls.

import { validateAnchorSafety, safeMatch } from "./regex-safety.js";
import { redactTemplateForPublication, isBlockingReport } from "./redact.js";

const K_ANONYMITY_THRESHOLD = 5;
const MIN_ANCHORS = 3;
const MAX_MISS_RATE = 0.10;
const PUBLISH_DAILY_CAP_DEFAULT = 10;
const HINT_THRESHOLD = 0.7;
const HINT_SILENT_THRESHOLD = 0.5;
const TOP_N_CANDIDATES = 5;

// ---- helpers ---------------------------------------------------

const finitePct = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  // Clamp into [0, 1] so an upstream bug (e.g. cosine returning a
  // negative or > 1 value due to numeric drift) cannot push the
  // combined score outside the documented range.
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const distinct = (arr) => Array.from(new Set(arr || []));

// Jaccard similarity over the fingerprint's token set.
const jaccard = (a, b) => {
  const A = new Set((a || []).map(String));
  const B = new Set((b || []).map(String));
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
};

// Cosine similarity over two numeric vectors keyed by token. The
// vectors are sparse maps `{ token: weight }`.
const cosine = (a, b) => {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const k of Object.keys(a)) {
    const va = Number(a[k]) || 0;
    na += va * va;
    if (k in b) dot += va * (Number(b[k]) || 0);
  }
  for (const k of Object.keys(b)) {
    const vb = Number(b[k]) || 0;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

// Combine fingerprint similarity + anchor hit-rate. Per the plan
// doc: total = 0.4 * fp_score + 0.6 * anchor_hit.
export const combinedScore = ({ fingerprint_score, anchor_hit_rate }) =>
  Math.max(0, Math.min(1,
    0.4 * finitePct(fingerprint_score) + 0.6 * finitePct(anchor_hit_rate),
  ));

// Score a single global candidate against a local fingerprint +
// body text. anchor_hit_rate = fraction of anchors whose pattern
// matches somewhere in bodyText. Exported for tests.
export const scoreCandidate = ({ candidate, localFingerprint, bodyText }) => {
  const fpTokens = localFingerprint?.tokens || [];
  const fpVec    = localFingerprint?.vec || {};
  const candTokens = candidate.fingerprint?.tokens || [];
  const candVec    = candidate.fingerprint?.vec || {};
  const jaccardSim = jaccard(fpTokens, candTokens);
  const cosineSim  = cosine(fpVec, candVec);
  const fingerprint_score = 0.5 * jaccardSim + 0.5 * cosineSim;

  const anchors = candidate.anchors || [];
  let hits = 0;
  for (const a of anchors) {
    const r = safeMatch(a.pattern || "", bodyText || "");
    if (r.ok && r.match) hits++;
  }
  const anchor_hit_rate = anchors.length === 0 ? 0 : hits / anchors.length;
  const score = combinedScore({ fingerprint_score, anchor_hit_rate });
  return {
    global_id: candidate.id,
    fingerprint_score,
    anchor_hit_rate,
    score,
  };
};

// ---- publish ---------------------------------------------------

// Stage-1 checks return a structured report so the UI can show
// exactly what blocked publication. We never silently drop fields.
const runStage1Checks = ({ template, tenantSettings, customer, anchorReports }) => {
  const failures = [];
  // 1. Tenant-level opt-in.
  if (!tenantSettings?.template_marketplace_publisher_optin) {
    failures.push({ check: "tenant_not_opted_in", fatal: true });
  }
  if (tenantSettings?.template_marketplace_publisher_suspended_at) {
    failures.push({ check: "publisher_suspended", fatal: true,
      suspended_at: tenantSettings.template_marketplace_publisher_suspended_at });
  }
  // 2. Per-customer opt-in (default TRUE = block). This is the
  //    customer-level "do not publish" flag; must be FALSE to allow.
  if (customer?.do_not_publish_templates !== false) {
    failures.push({ check: "customer_do_not_publish", fatal: true });
  }
  // 3. k-anonymity threshold.
  const k = (template.sample_doc_hashes || []).length;
  if (k < K_ANONYMITY_THRESHOLD) {
    failures.push({
      check: "k_anonymity_below_threshold",
      fatal: true,
      have: k, need: K_ANONYMITY_THRESHOLD,
    });
  }
  // 4. Minimum anchor count.
  if ((template.anchors || []).length < MIN_ANCHORS) {
    failures.push({
      check: "anchor_count_below_min",
      fatal: true,
      have: (template.anchors || []).length, need: MIN_ANCHORS,
    });
  }
  // 5. Per-anchor regex safety. anchorReports is the list of
  //    validateAnchorSafety outputs we already ran upstream.
  const unsafeAnchors = anchorReports.filter((r) => !r.ok);
  if (unsafeAnchors.length > 0) {
    failures.push({
      check: "anchor_regex_unsafe",
      fatal: true,
      details: unsafeAnchors,
    });
  }
  // 6. Miss-rate sanity. Template must actually work on its own
  //    publisher's documents.
  const hit = Number(template.hit_count) || 0;
  const miss = Number(template.miss_count) || 0;
  const total = hit + miss;
  if (total >= 5) {        // only enforce once we have decent volume
    const missRate = miss / total;
    if (missRate > MAX_MISS_RATE) {
      failures.push({
        check: "miss_rate_too_high",
        fatal: true,
        miss_rate: Number(missRate.toFixed(3)),
        max: MAX_MISS_RATE,
      });
    }
  }
  return { failures };
};

// Has the publisher published more than the daily cap?
const overPublishCap = async (svc, tenantId, cap) => {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const r = await svc.from("template_publications")
    .select("id")
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  if (r.error) return { over: false, count: 0 };
  return { over: (r.data || []).length >= cap, count: (r.data || []).length };
};

// Replay verification: run the redacted anchors against the
// publisher's last 5 source documents (via extraction_runs). If
// the extracted values differ from the operator-confirmed
// normalized_extract on those runs, reject the publication. This
// catches deliberately mis-extracting templates.
const replayVerification = async (svc, { tenantId, customerId, redactedAnchors }) => {
  const runs = await svc.from("extraction_runs")
    .select("id, normalized_extract")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(5);
  if (runs.error || !(runs.data || []).length) {
    return { ok: true, runs_examined: 0, mismatches: [] };
  }
  const mismatches = [];
  for (const run of runs.data) {
    const text = run.normalized_extract?.raw_text || "";
    for (const a of redactedAnchors) {
      const m = safeMatch(a.pattern, text);
      if (!m.ok || !m.match) continue;
      const expected = readField(run.normalized_extract, a.field);
      if (expected == null) continue;
      const got = m.match.captured;
      if (String(got).trim() !== String(expected).trim()) {
        mismatches.push({
          run_id: run.id,
          field: a.field,
          expected: String(expected).slice(0, 80),
          got: String(got).slice(0, 80),
        });
      }
    }
  }
  return {
    ok: mismatches.length === 0,
    runs_examined: runs.data.length,
    mismatches,
  };
};

// Read a dot-path field from normalized_extract.
const readField = (obj, path) => {
  if (!obj) return null;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
};

// Publish entry point. ctx is the auth context; opts has
// `template_id`, optional `anonymise` (default true), optional
// `tenant_settings` + `customer` (pre-fetched).
export const publishTemplate = async (svc, ctx, opts) => {
  const tenantId = ctx.tenantId;
  const templateId = opts.template_id;
  if (!tenantId || !templateId) {
    return { ok: false, blocked_by: "input", reasons: ["tenant_id or template_id missing"] };
  }
  // Fetch the source template if not provided.
  let template = opts.template;
  if (!template) {
    const r = await svc.from("customer_format_templates").select("*")
      .eq("tenant_id", tenantId).eq("id", templateId).maybeSingle();
    if (r.error) return { ok: false, blocked_by: "db", reasons: [r.error.message] };
    if (!r.data) return { ok: false, blocked_by: "not_found", reasons: ["template_not_found"] };
    template = r.data;
  }
  if (template.status !== "active") {
    return { ok: false, blocked_by: "template_not_active", reasons: ["status=" + template.status] };
  }
  // Fetch settings + customer if not provided.
  const settings = opts.tenant_settings || await loadSettings(svc, tenantId);
  const customer = opts.customer || await loadCustomer(svc, tenantId, template.customer_id);

  // Rate limit.
  const cap = Number(settings?.template_marketplace_publish_daily_cap) || PUBLISH_DAILY_CAP_DEFAULT;
  const limit = await overPublishCap(svc, tenantId, cap);
  if (limit.over) {
    return {
      ok: false,
      blocked_by: "rate_limit",
      reasons: ["daily_cap_" + cap + "_reached_today_" + limit.count],
    };
  }

  // 1. Redact.
  const { redacted, report: redactReport } = redactTemplateForPublication(template);
  if (isBlockingReport(redactReport)) {
    return {
      ok: false,
      blocked_by: "redaction",
      reasons: ["pii_detected"],
      redaction_report: redactReport,
    };
  }
  // 2. Per-anchor safety.
  const anchorReports = [...(redacted.anchors || []), ...(redacted.line_anchors || [])]
    .map((a) => ({ anchor: a, ...validateAnchorSafety(a) }));
  // 3. Stage-1 checks.
  const { failures } = runStage1Checks({
    template, tenantSettings: settings, customer, anchorReports,
  });
  if (failures.length > 0) {
    return {
      ok: false,
      blocked_by: "stage1",
      reasons: failures,
      redaction_report: redactReport,
    };
  }
  // 4. Replay verification.
  const replay = await replayVerification(svc, {
    tenantId,
    customerId: template.customer_id,
    redactedAnchors: [...(redacted.anchors || []), ...(redacted.line_anchors || [])],
  });
  if (!replay.ok) {
    return {
      ok: false,
      blocked_by: "replay_verification",
      reasons: ["mismatched_extracts"],
      replay,
    };
  }
  // 5. Choose approval kind: verified publisher gets auto-approve,
  //    first-time publisher gets pending_review.
  const isVerified = !!settings?.template_marketplace_publisher_verified_at;
  const approvalKind = isVerified ? "auto" : "human";
  const newStatus = isVerified ? "approved" : "pending_review";
  // 6. Insert.
  const insertRow = {
    kind: template.kind,
    fingerprint: opts.fingerprint || {},
    anchors: redacted.anchors,
    line_anchors: redacted.line_anchors,
    publisher_tenant_id: opts.anonymise === false ? tenantId : null,
    publisher_display: opts.anonymise === false
      ? (opts.publisher_display || "Anvil tenant")
      : "Anonymous",
    anonymise_publisher: opts.anonymise !== false,
    status: newStatus,
    approval_kind: approvalKind,
    reviewed_by: isVerified ? ctx.user?.id || null : null,
    reviewed_at: isVerified ? new Date().toISOString() : null,
    k_anonymity: (template.sample_doc_hashes || []).length,
    source_template_id: templateId,
    redaction_report: redactReport,
    regex_safety_report: { anchor_reports: anchorReports.map((r) => ({
      field: r.anchor?.field, ok: r.ok, reasons: r.reasons,
    })) },
    replay_verification: replay,
  };
  const ins = await svc.from("customer_format_templates_global")
    .insert(insertRow)
    .select("*").maybeSingle();
  if (ins.error) {
    return { ok: false, blocked_by: "db", reasons: [ins.error.message] };
  }
  // Publication audit row.
  await svc.from("template_publications").insert({
    tenant_id: tenantId,
    template_id: templateId,
    global_id: ins.data.id,
    customer_id: template.customer_id,
    published_by: ctx.user?.id || null,
    redaction_report: redactReport,
    regex_safety_report: insertRow.regex_safety_report,
    anonymise_publisher: insertRow.anonymise_publisher,
    k_anonymity: insertRow.k_anonymity,
    status: newStatus === "approved" ? "approved" : "submitted",
  });
  return {
    ok: true,
    global_id: ins.data.id,
    status: ins.data.status,
    approval_kind: approvalKind,
    report: {
      redaction: redactReport,
      anchor_safety: anchorReports.map((r) => ({ field: r.anchor?.field, ok: r.ok, reasons: r.reasons })),
      replay,
      k_anonymity: insertRow.k_anonymity,
    },
  };
};

const loadSettings = async (svc, tenantId) => {
  const r = await svc.from("tenant_settings").select("*")
    .eq("tenant_id", tenantId).maybeSingle();
  return r?.data || null;
};
const loadCustomer = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  const r = await svc.from("customers")
    .select("id, do_not_publish_templates")
    .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  return r?.data || null;
};

// ---- match -----------------------------------------------------

// findGlobalCandidates: score every status='approved' global row
// for `kind` against `localFingerprint` + `bodyText`. Returns top
// TOP_N_CANDIDATES.
export const findGlobalCandidates = async (svc, { kind, localFingerprint, bodyText }) => {
  const r = await svc.from("customer_format_templates_global")
    .select("id, kind, fingerprint, anchors, line_anchors, publisher_display, anonymise_publisher, hit_count, miss_count")
    .eq("kind", kind || "po")
    .eq("status", "approved")
    .limit(500);
  if (r.error) return [];
  const scored = (r.data || []).map((cand) =>
    scoreCandidate({ candidate: cand, localFingerprint, bodyText }),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_N_CANDIDATES);
};

// ---- apply -----------------------------------------------------

// Apply a single global template's anchors against bodyText. Builds
// a known-fields shape compatible with the existing
// templates.applyTemplate output so the dispatcher's hints.knownFields
// path can use it without modification.
//
// Default mode is HINT: the L4 LLM still runs, and the global
// template's extracted values are passed as known-fields hints. The
// caller can promote to skip_llm only after the template_imports
// row's operator_confirmed_count crosses the tenant threshold.
export const applyGlobalTemplate = async (svc, ctx, opts) => {
  const tenantId = ctx.tenantId;
  const { globalId, customerId, bodyText, score, fingerprint_score, anchor_hit_rate, useMode } = opts;
  const g = await svc.from("customer_format_templates_global")
    .select("*").eq("id", globalId).eq("status", "approved").maybeSingle();
  if (g.error || !g.data) {
    return { used: false, reason: "global_not_approved" };
  }
  const tpl = g.data;
  const known = { customer: {} };
  const hitFields = [];
  const confidences = {};
  for (const a of tpl.anchors || []) {
    const r = safeMatch(a.pattern, bodyText || "");
    if (!r.ok || !r.match) continue;
    const path = String(a.field).split(".");
    if (path.length === 2 && path[0] === "customer") {
      known.customer[path[1]] = r.match.captured;
      hitFields.push(a.field);
      // Per-field confidence floor: global templates fire at
      // tenant default 0.85 in hint mode, full skip_llm bumps to
      // 0.95 since the operator already vouched.
      confidences[a.field] = useMode === "skip_llm" ? 0.95 : 0.85;
    }
  }
  if (hitFields.length === 0) {
    return { used: false, reason: "no_anchor_matched" };
  }
  // Write a template_imports row.
  const impIns = await svc.from("template_imports").insert({
    tenant_id: tenantId,
    customer_id: customerId || null,
    global_id: globalId,
    match_score: Number((score ?? 0).toFixed(3)),
    fingerprint_score: fingerprint_score != null ? Number(fingerprint_score.toFixed(3)) : null,
    anchor_hit_rate: anchor_hit_rate != null ? Number(anchor_hit_rate.toFixed(3)) : null,
    use_mode: useMode || "hint",
  }).select("id").maybeSingle();
  // Bump the global hit_count (best-effort; failure is non-fatal).
  void svc.from("customer_format_templates_global")
    .update({ hit_count: (tpl.hit_count || 0) + 1 })
    .eq("id", globalId);
  return {
    used: true,
    global_id: globalId,
    use_mode: useMode || "hint",
    import_id: impIns?.data?.id || null,
    normalized: known,
    confidences,
    hits: hitFields,
  };
};

// Compute whether the consumer tenant should escalate from hint
// mode to skip_llm for a given global template. The promotion is
// triggered after N operator-confirmed imports (default 5 per
// tenant setting). The promotion is per (tenant, global_id), not
// global, so trust is built per-template per-consumer.
export const shouldPromoteToSkipLlm = async (svc, { tenantId, globalId, threshold }) => {
  const r = await svc.from("template_imports")
    .select("operator_confirmed_count")
    .eq("tenant_id", tenantId)
    .eq("global_id", globalId);
  if (r.error) return false;
  const total = (r.data || [])
    .reduce((acc, row) => acc + (Number(row.operator_confirmed_count) || 0), 0);
  return total >= (Number(threshold) || 5);
};

// ---- revoke / abuse handling -----------------------------------

// Mark a global template revoked. publisher-initiated OR super-
// admin from a confirmed abuse report. Increments the publisher's
// revoke_count; if it crosses 3, auto-suspends the publisher.
export const revokeTemplate = async (svc, { globalId, reason, by_user_id, super_admin }) => {
  const r = await svc.from("customer_format_templates_global")
    .select("*").eq("id", globalId).maybeSingle();
  if (r.error || !r.data) return { ok: false, error: "not_found" };
  const tpl = r.data;
  await svc.from("customer_format_templates_global").update({
    status: "revoked",
    rejection_reason: reason || null,
    reviewed_by: by_user_id || null,
    reviewed_at: new Date().toISOString(),
  }).eq("id", globalId);
  // Mark consumer imports as reverted.
  await svc.from("template_imports").update({
    reverted_at: new Date().toISOString(),
    revert_reason: reason || "publisher_revoked",
  }).eq("global_id", globalId).is("reverted_at", null);
  // Reputation hit when revoke came from super-admin (i.e. abuse
  // confirmed by review).
  if (super_admin && tpl.publisher_tenant_id) {
    const sRes = await svc.from("tenant_settings").select("template_marketplace_publisher_revoke_count")
      .eq("tenant_id", tpl.publisher_tenant_id).maybeSingle();
    const next = (Number(sRes?.data?.template_marketplace_publisher_revoke_count) || 0) + 1;
    const patch = { template_marketplace_publisher_revoke_count: next };
    if (next >= 3) {
      patch.template_marketplace_publisher_suspended_at = new Date().toISOString();
    }
    await svc.from("tenant_settings").update(patch)
      .eq("tenant_id", tpl.publisher_tenant_id);
  }
  return { ok: true, global_id: globalId, status: "revoked" };
};

export const __consts = {
  K_ANONYMITY_THRESHOLD, MIN_ANCHORS, MAX_MISS_RATE,
  PUBLISH_DAILY_CAP_DEFAULT, HINT_THRESHOLD, HINT_SILENT_THRESHOLD,
  TOP_N_CANDIDATES,
};
export const __test = {
  jaccard, cosine, combinedScore, scoreCandidate, finitePct,
  runStage1Checks, distinct, readField,
};
