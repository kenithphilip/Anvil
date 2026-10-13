// The terms check: read both sides, compare, and store the flags.
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md sections 5 (comparison) and 9.2 (the
// tables).
//
//   runTermsCheck           one run on one order. Writes one
//                           order_term_checks row and its order_term_flags,
//                           and supersedes the previous check. Idempotent:
//                           a run that would store what the current check
//                           already holds writes nothing.
//   runTermsAfterReconcile  the server trigger at the end of the quote
//                           reconcile. Never throws and never fails the
//                           reconcile; it has its own time budget.
//   readTermsView           what GET /api/orders/terms returns, with each
//                           flag's decision history and the decisions the
//                           caller may make.
//
// A re-run carries a decision forward to the new flag only when the clause
// and the text hash of both sides are unchanged (section 5.4), and only when
// the person who decided could still make that decision at the new severity.
// Otherwise the flag reopens and the old decision stays in its history.
//
// The mode (tenant_settings.terms_check_mode, migration 250):
//   off     nothing is run, written or shown (the default).
//   shadow  run and stored; shown only to an admin who asks for it
//           (include_shadow), so precision is measured before anyone acts.
//   on      run, stored and shown.
//
// Before migration 250 is applied, every entry point raises
// MIGRATION_NOT_APPLIED (HTTP 409) naming 250_order_terms.sql, and the
// reconcile trigger skips the step. The mode is a discriminator: a database
// without it is never read as "off" or as "on" (section 9.4).
//
// Every query is scoped to ctx.tenantId, and nothing runs without one.

import { recordEvent } from "../audit.js";
import { CLAUSE_TAXONOMY, SEVERITY_LEVELS } from "./taxonomy.js";
import { checkFingerprint, compareTerms, effectivePolicy, needsDecision, sortFlags } from "./compare.js";
import {
  customerBaseline, mergeBaseline, normalizePassResult, poClausesFromExtraction, quoteClauses,
} from "./sides.js";
import { labelled } from "./labels.js";
import { loadTermsPass } from "./terms-pass-hook.js";
import {
  OPEN_DECISIONS, allowedDecisions, decisionView, historyByFlag, mayDecide, readDecisions,
} from "./decisions.js";
import {
  TERMS_MIGRATION, isMissingTermsSchema, migrationNotApplied, migrationErrorBody, termsDbError,
} from "./errors.js";

export { TERMS_MIGRATION, isMissingTermsSchema, migrationNotApplied, migrationErrorBody };

export const TERMS_MODES = Object.freeze(["off", "shadow", "on"]);
export const TERMS_TRIGGERS = Object.freeze(["reconcile", "manual", "quote_attached"]);

// Upper bound on how long the reconcile waits for the terms step. The
// reconcile is stored by then; this caps only the caller's wait.
export const TERMS_AFTER_RECONCILE_BUDGET_MS = 10000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── errors ──────────────────────────────────────────────────────────────────

const tenantRequired = () => {
  const err = new Error("terms check: no tenant in context");
  err.status = 403;
  return err;
};

const fail = termsDbError;

// ── reads ───────────────────────────────────────────────────────────────────

// The tenant's mode and effective policy. No settings row is "off". A value
// outside the three modes is "off" too: the check runs only when a tenant
// turned it on.
export const readTermsSettings = async (svc, tenantId) => {
  if (!tenantId) throw tenantRequired();
  const r = await svc.from("tenant_settings")
    .select("terms_check_mode, terms_policy")
    .eq("tenant_id", tenantId).maybeSingle();
  if (r.error) throw fail("tenant_settings", r.error);
  const mode = TERMS_MODES.includes(r.data?.terms_check_mode) ? r.data.terms_check_mode : "off";
  return { mode, policy: effectivePolicy(r.data?.terms_policy || null) };
};

const ORDER_COLUMNS = [
  "id", "status", "po_number", "po_date", "customer_id", "quote_id", "quote_number", "result",
  "incoterm_code", "delivery_terms",
  "source_document_id:preflight_payload->>source_document_id",
  "extraction_run_id:preflight_payload->>extraction_run_id",
].join(", ");

const readOrder = async (svc, tenantId, orderId) => {
  if (!orderId) return null;
  const r = await svc.from("orders").select(ORDER_COLUMNS)
    .eq("tenant_id", tenantId).eq("id", orderId).maybeSingle();
  if (r.error) throw new Error("orders read: " + r.error.message);
  return r.data || null;
};

// The current check: the newest one not superseded.
export const readCurrentCheck = async (svc, tenantId, orderId) => {
  const r = await svc.from("order_term_checks").select("*")
    .eq("tenant_id", tenantId).eq("order_id", orderId).is("superseded_at", null)
    .order("created_at", { ascending: false }).limit(1);
  if (r.error) throw fail("order_term_checks", r.error);
  return (r.data || [])[0] || null;
};

export const readFlags = async (svc, tenantId, checkId) => {
  const r = await svc.from("order_term_flags").select("*")
    .eq("tenant_id", tenantId).eq("check_id", checkId);
  if (r.error) throw fail("order_term_flags", r.error);
  return r.data || [];
};

// The PO document: the one the intake stamped on the order, else the order's
// first purchase_order attachment. order_documents has no tenant_id, so it is
// read only for an order id that came from this tenant's own query.
const poDocumentOf = async (svc, order) => {
  if (order.source_document_id && UUID_RE.test(order.source_document_id)) return order.source_document_id;
  const r = await svc.from("order_documents").select("document_id")
    .eq("order_id", order.id).eq("role", "purchase_order").limit(1);
  if (r.error) return null;
  return (r.data || [])[0]?.document_id || null;
};

const readCustomer = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  const r = await svc.from("customers").select("id, default_payment_terms, default_incoterms")
    .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  if (r.error) throw new Error("customers read: " + r.error.message);
  return r.data || null;
};

// Where grounding says each filled field came from (#582). Best effort: the
// equals-master rule in sides.js still keeps a master value off the PO side
// when this is unavailable.
const readRunProvenance = async (svc, tenantId, runId) => {
  if (!runId || !UUID_RE.test(runId)) return null;
  try {
    const r = await svc.from("extraction_runs").select("provenance:normalized_extract->_provenance")
      .eq("tenant_id", tenantId).eq("id", runId).maybeSingle();
    if (r.error || !r.data) return null;
    return r.data.provenance && typeof r.data.provenance === "object" ? r.data.provenance : null;
  } catch { return null; }
};

const QUOTE_COLUMNS = [
  "id", "quote_number", "status", "ingest_source", "source_document_id", "terms", "validity_days",
  "expires_at", "sent_at", "created_at", "template_id", "incoterm", "delivery_terms", "validity_text",
  "terms_snapshot", "terms_snapshot_at",
].join(", ");

const TEMPLATE_COLUMNS = "id, updated_at, payment_terms_clause, delivery_terms_clause, warranty_clause, penalty_clause, cancellation_clause";

// The templates our own quotes render with: the quote's template, else the
// tenant's default quotation template (as quotes/pdf.js resolves it). Best
// effort: a database without document_templates has no template clauses.
const readTemplates = async (svc, tenantId, quotes) => {
  const byId = new Map();
  let fallback = null;
  const own = quotes.filter((q) => !q.ingest_source);
  if (!own.length) return { byId, fallback };
  try {
    const ids = [...new Set(own.map((q) => q.template_id).filter(Boolean))];
    if (ids.length) {
      const r = await svc.from("document_templates").select(TEMPLATE_COLUMNS).eq("tenant_id", tenantId).in("id", ids);
      if (!r.error) for (const t of r.data || []) byId.set(t.id, t);
    }
    if (own.some((q) => !q.template_id || !byId.has(q.template_id))) {
      const d = await svc.from("document_templates").select(TEMPLATE_COLUMNS)
        .eq("tenant_id", tenantId).eq("doc_type", "quotation").eq("is_default", true).eq("is_active", true)
        .limit(1);
      if (!d.error) fallback = (d.data || [])[0] || null;
    }
  } catch { /* no template clauses */ }
  return { byId, fallback };
};

// The baseline quotes: every quote that priced a line in the reconcile
// (quotes_used, most lines first, so the primary is first). An order that was
// never reconciled falls back to its linked quote.
const readBaselineQuotes = async (svc, tenantId, order) => {
  const used = order.result?.quoteReconciliation?.quotes_used;
  let ids = Array.isArray(used) ? used.map((q) => q && q.quote_id).filter(Boolean) : [];
  if (!ids.length && order.quote_id) ids = [order.quote_id];
  ids = [...new Set(ids.map(String))].filter((id) => UUID_RE.test(id));
  if (!ids.length) return [];
  const r = await svc.from("quotes").select(QUOTE_COLUMNS).eq("tenant_id", tenantId).in("id", ids);
  if (r.error) throw fail("quotes read", r.error, { quoteColumns: true });
  const byId = new Map((r.data || []).map((q) => [String(q.id), q]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean);
  const templates = await readTemplates(svc, tenantId, rows);
  return rows.map((q, i) => ({
    quote_id: q.id,
    quote_number: q.quote_number || null,
    primary: i === 0,
    clauses: quoteClauses(q, {
      template: q.ingest_source ? null : (q.template_id && templates.byId.get(q.template_id)) || templates.fallback,
    }).map((c) => ({ ...c, quote_number: q.quote_number || null })),
  }));
};

// ── the PO side ─────────────────────────────────────────────────────────────

const NOT_READ_FALLBACK = "the terms reader has not run on this tenant, and extraction found no payment terms or incoterm";

const readPoSide = async (svc, ctx, order, { termsPass, mode, previous, customer }) => {
  const documentId = await poDocumentOf(svc, order);
  if (typeof termsPass === "function") {
    const r = await termsPass({ svc, ctx, orderId: order.id, documentId, kind: "po", mode, previous });
    return { ...normalizePassResult(r), documentId, from: "terms_pass" };
  }
  const provenance = await readRunProvenance(svc, ctx.tenantId, order.extraction_run_id);
  const ex = poClausesFromExtraction({ order, runProvenance: provenance, customer });
  return {
    // Extraction reads header fields, not the PO's terms and conditions, so
    // this is at most a partial read. Nothing read at all is not_read.
    status: ex.clauses.length ? "partial" : "not_read",
    text_source: null,
    clauses: ex.clauses,
    baseline: ex.baseline,
    segmenter: null,
    dropped_unverified: 0,
    prompt_version: null,
    model: null,
    reason: ex.clauses.length ? null : NOT_READ_FALLBACK,
    documentId,
    from: "extraction",
  };
};

// ── one run ─────────────────────────────────────────────────────────────────

// Returns { status, mode, check?, flags? }:
//   off        the tenant's mode is off; nothing was read or written
//   not_found  no such order in this tenant
//   unchanged  the current check already holds this result; nothing written
//   checked    a new check and its flags were written
// Throws MIGRATION_NOT_APPLIED before migration 250, and on a database error.
//
// opts: trigger (reconcile | manual | quote_attached), termsPass (inject the
// PR 11 pass; default: the hook), settings (already read).
export const runTermsCheck = async (svc, ctx, orderId, opts = {}) => {
  if (!ctx || !ctx.tenantId) throw tenantRequired();
  const tenantId = ctx.tenantId;
  const settings = opts.settings || await readTermsSettings(svc, tenantId);
  const mode = settings.mode;
  if (mode === "off") return { status: "off", mode };
  const order = await readOrder(svc, tenantId, orderId);
  if (!order) return { status: "not_found", mode };
  const previous = await readCurrentCheck(svc, tenantId, order.id);
  const customer = await readCustomer(svc, tenantId, order.customer_id);
  const termsPass = opts.termsPass !== undefined ? opts.termsPass : await loadTermsPass();
  const po = await readPoSide(svc, ctx, order, { termsPass, mode, previous, customer });
  const quotes = await readBaselineQuotes(svc, tenantId, order);
  const flags = compareTerms({
    poStatus: po.status,
    poClauses: po.clauses,
    quotes,
    baseline: mergeBaseline(po.baseline, customerBaseline(customer)),
    policy: settings.policy,
    poDate: order.po_date || null,
    notReadReason: po.reason,
  });

  const check = {
    tenant_id: tenantId,
    order_id: order.id,
    trigger: TERMS_TRIGGERS.includes(opts.trigger) ? opts.trigger : "manual",
    po_document_id: po.documentId || null,
    po_text_source: po.text_source,
    po_terms_status: po.status,
    po_clauses: po.clauses,
    segmenter: po.segmenter,
    dropped_unverified: po.dropped_unverified,
    quote_ids: quotes.map((q) => q.quote_id),
    policy_version: settings.policy.version,
    prompt_version: po.prompt_version,
    model: po.model,
    created_by: ctx.user?.id || null,
  };

  const prevFlags = previous ? await readFlags(svc, tenantId, previous.id) : [];
  if (previous && checkFingerprint(previous, prevFlags) === checkFingerprint(check, flags)) {
    return { status: "unchanged", mode, check: previous, flags: prevFlags };
  }

  const ins = await svc.from("order_term_checks").insert(check).select("*").single();
  if (ins.error) throw fail("order_term_checks insert", ins.error);
  const saved = ins.data;
  // The new check must not become current without its flags and their
  // carried decisions: a current check with no flags reads as "no
  // deviations", and a dropped decision reopens a flag someone closed. On a
  // failure the new check is set aside and the previous one stays current.
  const setAside = () => svc.from("order_term_checks").update({ superseded_at: new Date().toISOString() })
    .eq("tenant_id", tenantId).eq("id", saved.id);
  let savedFlags = [];
  let carried = 0;
  if (flags.length) {
    const fi = await svc.from("order_term_flags")
      .insert(flags.map((f) => ({ ...f, tenant_id: tenantId, order_id: order.id, check_id: saved.id })))
      .select("*");
    if (fi.error) {
      await setAside();
      throw fail("order_term_flags insert", fi.error);
    }
    savedFlags = fi.data || [];
    try {
      carried = await carryDecisions(svc, tenantId, order.id, settings.policy, prevFlags, savedFlags);
    } catch (err) {
      await setAside();
      throw err;
    }
  }

  // Supersede every other current check of this order, and their flags.
  const nowIso = new Date().toISOString();
  const cur = await svc.from("order_term_checks").select("id")
    .eq("tenant_id", tenantId).eq("order_id", order.id).is("superseded_at", null);
  if (cur.error) throw fail("order_term_checks", cur.error);
  const older = (cur.data || []).map((r) => r.id).filter((id) => id !== saved.id);
  if (older.length) {
    const u1 = await svc.from("order_term_checks").update({ superseded_at: nowIso })
      .eq("tenant_id", tenantId).in("id", older);
    if (u1.error) throw fail("order_term_checks supersede", u1.error);
    const u2 = await svc.from("order_term_flags").update({ superseded_at: nowIso })
      .eq("tenant_id", tenantId).in("check_id", older).is("superseded_at", null);
    if (u2.error) throw fail("order_term_flags supersede", u2.error);
  }
  return { status: "checked", mode, check: saved, flags: savedFlags, carried };
};

// Carry each decision from the previous check to the new flag with the same
// clause and the same text hash (both sides' wording unchanged). Only when
// the person who decided may still make that decision at the new severity: a
// re-rated policy that lifts a warn flag to high does not keep an engineer's
// accept. Returns how many were carried. The carried row keeps the original
// reason, person and time, and names the row it came from.
const carryDecisions = async (svc, tenantId, orderId, policy, prevFlags, newFlags) => {
  if (!prevFlags.length || !newFlags.length) return 0;
  const history = historyByFlag(await readDecisions(svc, tenantId, prevFlags.map((f) => f.id)));
  const rows = [];
  for (const nf of newFlags) {
    const old = prevFlags.find((pf) => (pf.clause ?? null) === (nf.clause ?? null)
      && pf.text_hash && pf.text_hash === nf.text_hash && (history.get(pf.id) || []).length);
    if (!old) continue;
    const cur = history.get(old.id)[0];
    const clausePolicy = nf.clause ? policy.clauses[nf.clause] : null;
    if (!mayDecide({ role: cur.decided_role }, cur.decision, nf.severity, clausePolicy)) continue;
    rows.push({
      tenant_id: tenantId, order_id: orderId, flag_id: nf.id, decision: cur.decision, reason: cur.reason,
      decided_by: cur.decided_by || null, decided_role: cur.decided_role || null,
      decided_at: cur.decided_at, carried_from: cur.id,
    });
  }
  if (!rows.length) return 0;
  const ins = await svc.from("order_term_decisions").insert(rows);
  if (ins.error) throw fail("order_term_decisions carry", ins.error);
  return rows.length;
};

// ── the reconcile trigger ───────────────────────────────────────────────────

// Run the check at the end of the quote reconcile. Call it AFTER the
// reconcile is stored. It never throws: before migration 250 it is skipped
// cleanly, and a failure or a run past the budget is an event on the order.
// The reconcile runs once per payload hash, so this does too, and a re-run
// with nothing new writes nothing.
export const runTermsAfterReconcile = async (svc, ctx, orderId, opts = {}) => {
  if (!ctx || !ctx.tenantId || !orderId) return { status: "skipped", reason: "no tenant or order" };
  const trigger = opts.trigger || "reconcile";
  const budgetMs = opts.budgetMs != null ? opts.budgetMs : TERMS_AFTER_RECONCILE_BUDGET_MS;
  const started = Date.now();
  let timer = null;
  let out;
  try {
    const run = runTermsCheck(svc, ctx, orderId, { trigger, termsPass: opts.termsPass });
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "timeout" }), budgetMs); });
    out = await Promise.race([run, late]);
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return { status: "skipped", reason: "migration_250_not_applied" };
    out = { status: "failed", error: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (out.status === "failed" || out.status === "timeout") {
    console.warn("[terms] " + trigger + " check " + out.status + " for order " + orderId + (out.error ? ": " + out.error : ""));
    try {
      await recordEvent(ctx, {
        caseId: orderId, eventType: "terms_check_" + out.status, objectType: "order", objectId: orderId,
        detail: { trigger, error: out.error || null, budget_ms: budgetMs, severity: "warn" },
        durationMs: Date.now() - started,
      });
    } catch { /* the console line above is the fallback record */ }
  }
  return out;
};

// ── the read model ──────────────────────────────────────────────────────────

const countBySeverity = (flags) => Object.fromEntries(SEVERITY_LEVELS.map((s) => [s, flags.filter((f) => f.severity === s).length]));

// Where a flag stands:
//   display              below decide_at_or_above; shown, not decided
//   undecided            needs a decision and has none
//   amendment_requested  the current decision asks the customer to amend; the
//                        flag stays open
//   decided              accepted, rejected or not a deviation
export const flagState = (needs, current) => {
  if (current) return OPEN_DECISIONS.has(current.decision) ? "amendment_requested" : "decided";
  return needs ? "undecided" : "display";
};

// A flag as the API returns it: both sides labelled with their provenance,
// the clause's name, whether it needs a decision, its decision history
// (newest first) and the decisions this caller may make.
export const flagView = (f, policy, { history = [], ctx = null } = {}) => ({
  id: f.id,
  clause: f.clause,
  clause_label: f.clause ? CLAUSE_TAXONOMY[f.clause]?.label || f.clause : "PO terms",
  outcome: f.outcome,
  direction: f.direction || null,
  severity: f.severity,
  method: f.method || "rule",
  needs_decision: needsDecision(policy, f.severity),
  po: labelled(f.po),
  quote: labelled(f.quote),
  baseline: labelled(f.baseline),
  rationale: f.rationale || null,
  text_hash: f.text_hash || null,
  created_at: f.created_at || null,
  state: flagState(needsDecision(policy, f.severity), history[0] || null),
  decision: decisionView(history[0] || null),
  decisions: history.map(decisionView),
  allowed: ctx ? allowedDecisions(ctx, f, policy) : [],
});

export const checkView = (c) => (c ? {
  id: c.id,
  trigger: c.trigger,
  created_at: c.created_at || null,
  created_by: c.created_by || null,
  po_document_id: c.po_document_id || null,
  po_terms_status: c.po_terms_status,
  po_text_source: c.po_text_source || null,
  // The terms pass stamps its prompt version; the extraction fallback
  // does not.
  po_source: c.prompt_version ? "terms_pass" : "extraction",
  segmenter: c.segmenter || null,
  dropped_unverified: c.dropped_unverified || 0,
  clause_count: Array.isArray(c.po_clauses) ? c.po_clauses.length : 0,
  quote_ids: c.quote_ids || [],
  policy_version: c.policy_version ?? null,
  prompt_version: c.prompt_version || null,
  model: c.model || null,
} : null);

// What GET /api/orders/terms returns. opts.includeShadow: the caller is an
// admin who asked to see a shadow-mode check. The endpoint enforces who may
// ask; this only honours it.
export const readTermsView = async (svc, ctx, orderId, opts = {}) => {
  if (!ctx || !ctx.tenantId) throw tenantRequired();
  const tenantId = ctx.tenantId;
  const settings = opts.settings || await readTermsSettings(svc, tenantId);
  const { mode, policy } = settings;
  const base = {
    order_id: orderId,
    mode,
    shadow: mode === "shadow",
    visible: false,
    policy: { version: policy.version, decide_at_or_above: policy.decide_at_or_above },
    check: null,
    po_clauses: [],
    flags: [],
    counts: { total: 0, needs_decision: 0, undecided: 0, amendment_requested: 0, decided: 0, by_severity: countBySeverity([]) },
  };
  if (mode === "off") return { status: "ok", view: base };
  if (mode === "shadow" && !opts.includeShadow) return { status: "ok", view: { ...base, hidden: true } };
  const order = await svc.from("orders").select("id").eq("tenant_id", tenantId).eq("id", orderId).maybeSingle();
  if (order.error) throw new Error("orders read: " + order.error.message);
  if (!order.data) return { status: "not_found" };
  const check = await readCurrentCheck(svc, tenantId, orderId);
  if (!check) return { status: "ok", view: { ...base, visible: true } };
  const rows = sortFlags(await readFlags(svc, tenantId, check.id));
  const history = historyByFlag(await readDecisions(svc, tenantId, rows.map((f) => f.id)));
  const flags = rows.map((f) => flagView(f, policy, { history: history.get(f.id) || [], ctx }));
  const inState = (st) => flags.filter((f) => f.state === st).length;
  return {
    status: "ok",
    view: {
      ...base,
      visible: true,
      check: checkView(check),
      po_clauses: (check.po_clauses || []).map(labelled),
      flags,
      counts: {
        total: flags.length,
        needs_decision: flags.filter((f) => f.needs_decision).length,
        undecided: inState("undecided"),
        amendment_requested: inState("amendment_requested"),
        decided: inState("decided"),
        by_severity: countBySeverity(flags),
      },
    },
  };
};
