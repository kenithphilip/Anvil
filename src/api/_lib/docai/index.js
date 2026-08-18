// Document AI v2 dispatcher.
//
// Each adapter exposes:
//   isConfigured(settings) -> boolean
//   extract({ url, bytes, filename, mime, settings, customerId, hints }) ->
//     { ok, status, raw, normalized, confidences, error, latency_ms }
//
// The dispatcher picks the first configured adapter from the
// tenant's docai_provider_order, runs it, and falls back to the
// next on failure or low-confidence. On every successful extraction
// it folds in the per-customer prompt-overrides bundle so an
// adapter that supports few-shot context (Claude path) leverages
// the operator-correction history.

import * as reducto from "./reducto.js";
import * as azureDI from "./azure_di.js";
import * as unstructured from "./unstructured.js";
import * as excel from "./excel.js";
import * as claudeAdapter from "./claude.js";
import * as gaeb from "./gaeb.js";
import * as docling from "./docling.js";
import * as marker from "./marker.js";
import * as gemini from "./gemini.js";
import * as office from "./office.js";
import * as llamaparse from "./llamaparse.js";
import * as openrouterAdapter from "./openrouter.js";
import { conformLines } from "./line-schema.js";
import { allowedToCall, recordCall } from "../cost_guard.js";
import { serviceClient } from "../supabase.js";
import { rankAdaptersForCustomer } from "./adapter-learning.js";
import { readPdfBias, composeOrderWithBias } from "./pdf-metadata.js";

const ADAPTERS = {
  reducto,
  azure_di: azureDI,
  unstructured,
  excel,
  claude: claudeAdapter,
  gaeb,
  docling,
  marker,
  gemini,
  // Opt-in (issue #210): OFF by default — not in the default provider
  // order and skipped unless the tenant configures a LlamaCloud key.
  llamaparse,
  // Opt-in: OFF by default — not in the default provider order and skipped
  // unless OPENROUTER_API_KEY is set + the tenant adds it to
  // docai_provider_order (or picks it via the engine picker). Text-first.
  openrouter: openrouterAdapter,
};

// Registered adapter names — the single source of truth for validating a
// caller-supplied engine override (e.g. the SO workspace "run extraction with
// engine X" picker) before it's trusted as a provider-order entry.
export const ADAPTER_NAMES = Object.keys(ADAPTERS);

// The order used when a tenant has NOT pinned docai_provider_order. Re-exported
// from provider-order.js so read-only surfaces (the SO workspace pipeline
// diagnostics card) keep importing it from here, while there is exactly ONE
// definition. It previously lived here AND in adapter-learning.js with the two
// disagreeing about where gemini belongs.
export { DEFAULT_PROVIDER_ORDER } from "./provider-order.js";
import { DEFAULT_PROVIDER_ORDER } from "./provider-order.js";

// Is this adapter usable for this tenant? Mirrors the dispatcher's own gate
// exactly, so a diagnostics surface cannot disagree with what will really run.
// Safe to call anywhere: every adapter's key lookup wraps decryptField in
// try/catch, so an unset ANVIL_SECRETS_KEY yields false rather than throwing.
export const isAdapterConfigured = (name, settings) => !!ADAPTERS[name]?.isConfigured?.(settings);

// Apply a caller's per-run engine override to a settings object WITHOUT
// mutating tenant config: prepend the (validated) engine to the provider order
// so it runs first, keeping the tenant's existing order as fallback. A blank
// or unknown engine returns settings unchanged. Used by /api/docai/extract for
// the SO workspace "run extraction with engine X" picker.
export const withEngineOverride = (settings, provider) => {
  const eng = typeof provider === "string" ? provider.trim().toLowerCase() : null;
  if (!eng || !ADAPTER_NAMES.includes(eng)) return settings;
  const rest = (settings?.docai_provider_order || []).filter((a) => a !== eng);
  return { ...settings, docai_provider_order: [eng, ...rest] };
};

// LLM extractors that must always be reachable so a stale / broken provider
// order cannot dead-end extraction (returning no customer + no lines).
export const LLM_FALLBACK_ADAPTERS = ["gemini", "claude", "llamaparse"];

// Self-heal a provider order by appending any CONFIGURED LLM extractor that
// isn't already in it, at the END. The tenant's chosen order still wins — a
// fallback only runs if every ordered engine skips or fails. Two failure
// classes this fixes: (1) a legacy order that predates Gemini so only a
// since-broken engine (e.g. Claude 5xx-ing) is configured — the loop now falls
// through to Gemini; (2) an order whose listed engines are all unconfigured.
// Only KEYED adapters are appended, so a deliberate exclusion made by not
// setting an API key (e.g. for data-residency) is respected.
// Adapters that implement a given document kind.
//
// Each non-PO kind is a distinct schema branch inside an adapter, not a
// separate adapter — and only claude.js has ever grown those branches. Every
// other adapter silently runs the PURCHASE-ORDER schema whatever `kind` says,
// so a quotation handed to Gemini classifies as non_po and yields nothing.
//
// That was survivable in principle — the dispatcher keeps the best result, so
// Claude's real parse would beat Gemini's empty one — except that Claude sits
// LAST in the default order behind six adapters sharing one 45s run budget,
// and allocateAdapterDeadline SKIPS an adapter outright once its slice falls
// below the floor. The only adapter that can read the document is the one most
// likely never to run.
//
// Listed by kind rather than "claude does everything" so adding a quote branch
// to gemini is a one-line change here, not a hunt.
export const KIND_CAPABLE_ADAPTERS = Object.freeze({
  quote: ["claude"],
  supplier_ack: ["claude"],
  assembly_bom: ["claude"],
  part_drawing: ["claude"],
});

/**
 * Move the adapters that actually implement `kind` to the front.
 *
 * Reorders rather than filters: a capable adapter that is unconfigured or
 * failing must still fall through to the rest, and a kind nobody special-cases
 * (po, rfq, invoice) is left exactly as it was.
 */
export const orderForKind = (order, kind) => {
  const capable = KIND_CAPABLE_ADAPTERS[kind];
  if (!capable || !Array.isArray(order)) return order;
  const first = order.filter((a) => capable.includes(a));
  if (!first.length) return order;
  return [...first, ...order.filter((a) => !capable.includes(a))];
};

export const ensureLlmFallbacks = (order, isConfigured) => {
  const out = Array.isArray(order) ? [...order] : [];
  for (const name of LLM_FALLBACK_ADAPTERS) {
    if (!out.includes(name) && isConfigured(name)) out.push(name);
  }
  return out;
};

const guessSourceType = ({ filename, mime, bytes }) => {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".xlsx") || f.endsWith(".xlsm") || f.endsWith(".xls")) return "xlsx";
  if (mime?.startsWith("image/")) return "image";
  // GAEB DA XML: detect by extension OR by sniffing the file bytes
  // for a top-level <GAEB> element. Phase 5.3.
  if (gaeb.looksLikeGaeb({ filename, bytes })) return "gaeb";
  // Wave 2.2: Office formats (DOCX zip, RTF stream). Sniff so an
  // attachment renamed without extension still routes.
  if (office.isDocx({ filename, mime, bytes })) return "docx";
  if (office.isRtf({ filename, mime, bytes })) return "rtf";
  if (office.isLegacyDoc({ filename, bytes })) return "legacy_doc";
  if (f.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  return "pdf";
};

const overallConfidence = (confidences) => {
  const vals = Object.values(confidences || {}).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

// FAIR-SHARE BUDGET ALLOCATION.
//
// Every adapter shares ONE 45s run budget and each takes what it needs until
// the budget is gone. The adapter that runs last gets whatever is left, which
// on a large document is nothing usable. Observed on PO 0066026562, same
// document and code, minutes apart:
//
//   gemini 29,520ms + claude   220ms + llamaparse 2,845ms -> ok, 44 lines
//   gemini 26,558ms + claude 5,603ms + llamaparse 5,999ms -> llamaparse TIMED OUT
//
// The only difference is whether Claude's pre-call guard tripped or it actually
// attempted. LlamaParse — the one adapter that parses that document — got 12s
// in the first case and 6s in the second, and 6s was not enough. The outcome
// was decided by upstream latency in an adapter that failed either way.
//
// Each adapter already reserves a FIXED tail (GEMINI_FALLBACK_RESERVE_MS and
// ANTHROPIC_FALLBACK_RESERVE_MS, both 8s). Fixed is the bug: 8s is right when
// one adapter follows and wrong when two do, because the reserve does not know
// how many still have to run.
//
// So the DISPATCHER allocates, since it is the only place that knows the whole
// order. Each adapter is handed a deadline that holds back MIN_ADAPTER_MS for
// every configured adapter still queued behind it.
//
// THIS REDISTRIBUTES A FIXED BUDGET; IT DOES NOT CREATE TIME. Reserving for the
// tail necessarily caps the head, and on a document where the primary genuinely
// needs the whole 45s that is a real cost. Two things make the trade sound:
// #418 means a capped-then-failed primary no longer discards a later success,
// and an adapter that cannot get its floor is now SKIPPED explicitly rather
// than started and timed out — a skip is diagnosable, a timeout burns the
// budget it was given. The durable fix for genuinely large documents is
// chunking, not allocation.
const MIN_ADAPTER_MS = Number(process.env.DOCAI_MIN_ADAPTER_MS || 6000);

// Never hold back more than this share of what remains, so a long tail of
// configured-but-unlikely adapters cannot starve the primary. With the default
// order that keeps the head's slice comfortably dominant.
const MAX_RESERVE_FRACTION = Number(process.env.DOCAI_MAX_RESERVE_FRACTION || 0.5);

export const allocateAdapterDeadline = ({ now, runDeadlineAt, queuedAfter }) => {
  if (!runDeadlineAt) return null;                  // no run budget => unchanged
  const remaining = runDeadlineAt - now;
  if (remaining <= 0) return runDeadlineAt;
  const queued = Math.max(0, Number(queuedAfter) || 0);
  const wanted = queued * MIN_ADAPTER_MS;
  const reserve = Math.min(wanted, Math.floor(remaining * MAX_RESERVE_FRACTION));
  const slice = remaining - reserve;
  // Below the floor there is no point starting: the adapter would consume its
  // slice and time out. The caller skips instead.
  if (slice < MIN_ADAPTER_MS) return null;
  return now + slice;
};

// Rank two successful results. Used only when every adapter came in UNDER the
// fallback threshold, so the loop has to choose rather than early-return.
//
// Lines first: a 0.82 result carrying 44 line items beats a 0.90 carrying none,
// because confidence scores the fields that ARE there and says nothing about
// the ones that are missing. Then confidence. Then line count, so a fuller
// parse wins a tie. Equal on all three keeps the incumbent, which preserves the
// tenant's provider order as the final tie-break.
export const isBetterResult = (candidate, incumbent) => {
  if (!candidate?.ok) return false;
  if (!incumbent) return true;
  const count = (r) => (Array.isArray(r?.normalized?.lines) ? r.normalized.lines.length : 0);
  const conf = (r) => (Number.isFinite(r?.confidence_overall) ? r.confidence_overall : -1);
  const ca = count(candidate), ci = count(incumbent);
  if ((ca > 0) !== (ci > 0)) return ca > 0;
  if (conf(candidate) !== conf(incumbent)) return conf(candidate) > conf(incumbent);
  return ca > ci;
};

// Build the per-customer few-shot bundle for the Claude fallback.
export const buildPromptOverrides = (settings, customerId) => {
  const all = settings?.docai_prompt_overrides || {};
  if (!customerId) return null;
  return all[customerId] || null;
};

export const dispatchExtract = async ({ source, settings, customerId, hints, runCost = null }) => {
  const sourceType = source.sourceType || guessSourceType(source);
  // Wave 2.2: DOCX / RTF inputs are extracted to plain text via the
  // office parser, then the normal LLM chain runs on the extracted
  // text. We mutate `hints.bodyText` so claude.js / gemini.js's
  // pre_extracted_text mode kicks in. Source is rewritten to look
  // like a non-PDF "text source" so the PDF chunker / TOC profiler
  // don't accidentally fire on docx bytes. Legacy .doc surfaces an
  // explicit error so the operator gets clear feedback.
  if (sourceType === "docx" || sourceType === "rtf") {
    const office = await import("./office.js");
    const extracted = await office.extractOfficeText({
      bytes: source.bytes, filename: source.filename, mime: source.mime,
    });
    if (!extracted.ok) {
      return {
        ok: false,
        adapter_used: "office",
        normalized: null,
        confidences: {},
        confidence_overall: null,
        attempts: [{ adapter: "office", status: "failed", error: extracted.error }],
        reason: extracted.error || "office_extract_failed",
        error: extracted.error || "office_extract_failed",
        latency_ms: extracted.latency_ms,
        mode: extracted.kind,
      };
    }
    const officeHints = { ...(hints || {}), bodyText: extracted.body_text, expectedFormat: extracted.kind };
    const officeSource = { ...source, sourceType: "text", mime: "text/plain" };
    const llmOut = await dispatchExtract({
      source: officeSource, settings, customerId, hints: officeHints, runCost,
    });
    // Tag the result so audit can tell a docx/rtf path apart from
    // a native PDF run.
    if (llmOut && typeof llmOut === "object") {
      llmOut.office_extracted = {
        kind: extracted.kind,
        extractor: extracted.extractor,
        char_count: extracted.char_count,
      };
    }
    return llmOut;
  }
  if (sourceType === "legacy_doc") {
    return {
      ok: false,
      adapter_used: "office",
      normalized: null,
      confidences: {},
      confidence_overall: null,
      attempts: [{ adapter: "office", status: "failed", reason: "unsupported_legacy_doc" }],
      reason: "unsupported_legacy_doc",
      error: "legacy .doc binary is not supported; ask the sender for a PDF or .docx",
      mode: "legacy_doc",
    };
  }
  // Excel always routes to the in-process parser; LLMs are bad at
  // multi-tab tenders.
  if (sourceType === "xlsx") {
    const t0 = Date.now();
    const out = await excel.extract({ ...source, settings, customerId, hints });
    return {
      adapter_used: "excel",
      latency_ms: Date.now() - t0,
      ...out,
      confidence_overall: overallConfidence(out.confidences),
    };
  }
  // GAEB routes to its own deterministic parser. The schema is
  // rigid; an LLM only adds noise. If GAEB parsing fails (malformed
  // XML, unexpected variant) we fall back to the normal LLM
  // pipeline so the file isn't silently rejected.
  if (sourceType === "gaeb") {
    const t0 = Date.now();
    const out = await gaeb.extract({ ...source, settings, customerId, hints });
    if (out.ok) {
      return {
        adapter_used: "gaeb",
        latency_ms: Date.now() - t0,
        ...out,
        confidence_overall: overallConfidence(out.confidences),
      };
    }
    // Fall through to the LLM order on parse failure, recording the
    // GAEB attempt so the caller can see what happened.
    const gaebAttempt = { adapter: "gaeb", status: "failed", ms: Date.now() - t0, error: out.error };
    // Cost-optimised default for the GAEB-fallback path: gemini
    // (free tier) and self-hostable adapters first, then paid LLM.
    const order = settings?.docai_provider_order
      || ["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"];
    const attempts = [gaebAttempt];
    let last = { ok: false, error: out.error };
    for (const adapterName of order) {
      const adapter = ADAPTERS[adapterName];
      if (!adapter || !adapter.isConfigured(settings)) {
        attempts.push({ adapter: adapterName, status: "skipped_not_configured" });
        continue;
      }
      const tStart = Date.now();
      try {
        const fb = await adapter.extract({
          ...source, settings, customerId, hints,
          promptOverrides: buildPromptOverrides(settings, customerId),
        });
        const conf = overallConfidence(fb.confidences);
        attempts.push({
          adapter: adapterName,
          status: fb.ok ? "ok" : "failed",
          ms: Date.now() - tStart,
          confidence: conf,
          ...(fb.ok ? {} : {
            ...(fb.reason ? { reason: fb.reason } : {}),
            ...(fb.error ? { error: String(fb.error).slice(0, 500) } : {}),
          }),
        });
        if (fb.ok) {
          return { adapter_used: adapterName, latency_ms: Date.now() - tStart, ...fb, confidence_overall: conf, attempts };
        }
        last = fb;
      } catch (err) {
        attempts.push({ adapter: adapterName, status: "error", ms: Date.now() - tStart, error: err.message });
      }
    }
    return { ...last, attempts };
  }
  // Cost-optimised default order:
  //   - gemini first (Gemini 2.5 Flash free tier covers most PoC
  //     traffic at $0/month: 1500 RPD, 1M TPM, no card).
  //   - self-hostable adapters next: zero per-page cost when the
  //     operator runs them (docling, marker, unstructured-OSS).
  //   - hosted doc-AI options after that: azure_di F0 free 500
  //     pages/mo, then paid reducto/unstructured.
  //   - claude last: paid LLM, our most expensive option.
  // The dispatcher skips any adapter whose isConfigured() returns
  // false, so an operator with only Claude still gets the single-
  // adapter path; the cost-guard then enforces docai_daily_limits
  // so a runaway Claude bill is impossible.
  //
  // Phase E1: when the caller provides customerId and the tenant
  // hasn't pinned an explicit docai_provider_order, consult the
  // per-customer adapter-learning helper to bias the order based
  // on this customer's recent extraction history. New customers
  // (or customers with <MIN_OBSERVATIONS runs per adapter) fall
  // through to the static default. The helper caches per
  // (tenant, customer) for 30 minutes so the per-call cost is at
  // most one Postgres select per cache window.
  let order = settings?.docai_provider_order || DEFAULT_PROVIDER_ORDER;
  // Phase F #2: PDF metadata-driven adapter bias. Read /Producer
  // and /Creator from the input PDF; if they match a known
  // pattern (SAP, Tally, Microsoft Word, Adobe Acrobat, etc.),
  // bias the adapter order toward the engines that consistently
  // win on that layout family. Layered with #6 below: tenant
  // override > customer learning > PDF bias > static default.
  let pdfBias = null;
  if (!settings?.docai_provider_order && source && source.bytes) {
    const mimeStr = String(source.mime || source.contentType || "").toLowerCase();
    const looksPdf = mimeStr === "application/pdf" || mimeStr.endsWith("/pdf")
      || (typeof source.filename === "string" && /\.pdf$/i.test(source.filename));
    if (looksPdf) {
      try { pdfBias = await readPdfBias(source.bytes); } catch (_e) { pdfBias = null; }
      if (pdfBias?.bias_adapters?.length) {
        order = composeOrderWithBias(order, pdfBias.bias_adapters);
      }
    }
  }
  // Wave 3.5: layout-fingerprint bias. When run.js computed a
  // fingerprint match against a prior successful run, it surfaces
  // the prior winning adapter on hints.layoutFingerprintBias.
  // Compose-ahead so this bias is applied AFTER pdf metadata
  // bias but BEFORE customer-learning rerank.
  if (!settings?.docai_provider_order && Array.isArray(hints?.layoutFingerprintBias) && hints.layoutFingerprintBias.length) {
    order = composeOrderWithBias(order, hints.layoutFingerprintBias);
  }
  // Per-customer adapter learning (Phase E1) reorders on top of
  // the metadata bias when we have enough observations. Skipped
  // if tenant pinned an explicit order or no customerId.
  if (!settings?.docai_provider_order && customerId && settings?.tenant_id) {
    try {
      let learnSvc = null;
      try { learnSvc = serviceClient(); } catch (_e) { learnSvc = null; }
      if (learnSvc) {
        order = await rankAdaptersForCustomer({
          svc: learnSvc,
          tenantId: settings.tenant_id,
          customerId,
          defaultOrder: order, // start from the bias-adjusted order
        });
      }
    } catch (_e) { /* fall back to bias-adjusted or static order on any error */ }
  }
  // Self-heal: guarantee a configured LLM extractor is reachable so a stale
  // provider order (e.g. a legacy gemini-less order whose only configured
  // engine is a 5xx-ing Claude) can't dead-end with no customer + no lines.
  order = ensureLlmFallbacks(order, (n) => isAdapterConfigured(n, settings));
  // Put the adapters that implement this document kind first. For a quote that
  // means Claude runs before the six adapters that would each spend budget
  // running the PO schema against a quotation.
  order = orderForKind(order, hints?.expectedKind);
  const attempts = [];
  // `best` is the strongest SUCCESSFUL result seen; `lastFailure` is only used
  // when nothing succeeded. Keeping them apart is the whole point — a single
  // `last` let a failure clobber a success (see the assignment below).
  let best = null;
  let lastFailure = null;
  let salvagedRaw = null;
  // Materialise an svc reference once so per-iteration cost-guard
  // checks don't re-spawn the client. Best-effort: a missing
  // SUPABASE_URL leaves svc null and the guard treats that as
  // "no limits" (legacy behaviour).
  let svc = null;
  try { svc = serviceClient(); } catch (_e) { svc = null; }
  for (const [idx, adapterName] of order.entries()) {
    const adapter = ADAPTERS[adapterName];
    if (!adapter) continue;
    // RUN DEADLINE. The serverless function has a hard ceiling (60s on the
    // current plan). Starting an LLM call we cannot finish is the worst
    // outcome: the platform kills the function mid-flight, so run.js never
    // reaches its final UPDATE — the row stays status='running' forever with
    // no attempts and no error, AND the provider call is still billed. Stop
    // BEFORE the next adapter instead, so the run always returns and records a
    // real, diagnosable status. Observed on PO 0066026562: a 47s Claude call
    // left two runs permanently stuck.
    if (hints?.deadlineAt && Date.now() >= hints.deadlineAt) {
      attempts.push({
        adapter: adapterName,
        status: "skipped_deadline",
        reason: "run_budget_exhausted",
      });
      continue;
    }
    if (!adapter.isConfigured(settings)) {
      attempts.push({ adapter: adapterName, status: "skipped_not_configured" });
      continue;
    }
    // How many CONFIGURED adapters are still queued behind this one. Counting
    // unconfigured ones would reserve time for adapters that never run and
    // starve the ones that do.
    const queuedAfter = order.slice(idx + 1)
      .filter((n) => ADAPTERS[n] && isAdapterConfigured(n, settings)).length;
    const adapterDeadlineAt = hints?.deadlineAt
      ? allocateAdapterDeadline({ now: Date.now(), runDeadlineAt: hints.deadlineAt, queuedAfter })
      : null;
    // Below the floor, starting is worse than skipping: the adapter consumes
    // its slice and times out, and the run records a timeout where it could
    // have recorded a reason.
    if (hints?.deadlineAt && !adapterDeadlineAt) {
      attempts.push({
        adapter: adapterName,
        status: "skipped_deadline",
        reason: "insufficient_budget_share",
      });
      continue;
    }
    // Cost-guard: short-circuit when the operator's daily cap for
    // this adapter is exhausted. Free / self-hosted adapters
    // (docling/marker/excel/gaeb) bypass this check; paid adapters
    // (claude/reducto/unstructured/azure_di) honour the
    // tenant_settings.docai_daily_limits map.
    const guard = await allowedToCall(svc, settings, adapterName);
    if (!guard.allowed) {
      attempts.push({
        adapter: adapterName,
        status: "skipped_over_budget",
        count: guard.count,
        limit: guard.limit,
        reason: guard.reason,
      });
      continue;
    }
    // Wave 1.4: per-extraction cost cap. The runCost accumulator
    // is shared across every adapter call in this run (including
    // every chunk of a chunked PDF). When the next call would
    // breach the cap, skip the adapter with a structured attempt
    // entry so the audit trail explicitly records the budget cut.
    if (runCost && runCost.wouldExceed(adapterName)) {
      runCost.skip(adapterName, "over_run_budget");
      attempts.push({
        adapter: adapterName,
        status: "skipped_over_run_budget",
        accumulated_cost_usd: runCost.totalUsd,
        estimated_cost_usd: runCost.estimatedCostFor(adapterName),
        cap_usd: runCost.cap,
      });
      continue;
    }
    const t0 = Date.now();
    let out;
    try {
      out = await adapter.extract({
        ...source,
        settings,
        customerId,
        // Fair-share deadline: this adapter's slice, not the whole run budget.
        // Holding back MIN_ADAPTER_MS per adapter still queued behind it is
        // what stops the tail being handed 6s on a document that needs 12.
        hints: adapterDeadlineAt ? { ...hints, deadlineAt: adapterDeadlineAt } : hints,
        promptOverrides: buildPromptOverrides(settings, customerId),
      });
    } catch (err) {
      attempts.push({ adapter: adapterName, status: "error", ms: Date.now() - t0, error: err.message });
      // Carry a reason so a thrown adapter surfaces as
      // status_reason='adapter_threw' instead of 'fail_unknown'.
      last = { ok: false, reason: "adapter_threw", error: err.message };
      continue;
    }
    const latency_ms = Date.now() - t0;
    // Schema boundary. Every adapter's line vocabulary is reconciled with the
    // canonical shape HERE, once, rather than each consumer guessing at the
    // dialect in front of it. Before this, llamaparse's `line_total` +
    // `tax_amount` reached computeLineTotals and the completeness guard, both
    // of which read different names, and the whole tax column was silently
    // dropped on a run that reported ok.
    //
    // Applied to every adapter, not just the one that misbehaved: the point is
    // that adapter #11 cannot reintroduce this without CI saying so.
    let schemaDiag = null;
    if (out?.ok && out.normalized) {
      const conformed = conformLines(out.normalized);
      out.normalized = conformed.normalized;
      schemaDiag = conformed.diag;
    }
    const conf = overallConfidence(out.confidences);
    // Bet 1 (May 2026): confidence threshold is now per-tenant
    // (tenant_settings.docai_fallback_confidence, default 0.85).
    // Was a hard-coded 0.7. Lifted because Gemini 3 Flash is now
    // the primary; Sonnet 4.6 fallback should fire more
    // aggressively to keep extraction quality high. Tenants on the
    // legacy Gemini 2.5 chain stay on 0.70 by setting their
    // docai_fallback_confidence to 0.70 explicitly.
    const fallbackThreshold = Number.isFinite(Number(settings?.docai_fallback_confidence))
      ? Number(settings.docai_fallback_confidence)
      : 0.85;
    // Carry the adapter's OWN reason/error onto the attempt. Without this a
    // failed adapter records only {adapter, status, ms, confidence} — and since
    // the run-level `error` is overwritten by whichever adapter ran LAST, an
    // earlier failure left no trace anywhere. That is exactly how a 47-second
    // Claude failure on PO 0066026562 became undiagnosable: the only surviving
    // error belonged to LlamaParse, three adapters later.
    attempts.push({
      adapter: adapterName,
      status: out.ok ? (conf != null && conf < fallbackThreshold ? "low_confidence" : "ok") : "failed",
      ms: latency_ms,
      confidence: conf,
      ...(out.ok ? {} : {
        ...(out.reason ? { reason: out.reason } : {}),
        ...(out.error ? { error: String(out.error).slice(0, 500) } : {}),
      }),
      // Only present when the adapter spoke a dialect. An `unknown` key here
      // is a field the adapter emitted that NOTHING downstream reads — the
      // exact silent-loss shape that cost an entire tax column.
      ...(schemaDiag ? { schema: schemaDiag } : {}),
    });
    // Telemetry: record the call against today's counter so
    // /api/docai/usage shows live usage and the guard locks the
    // adapter out once the cap is hit. Best-effort: failures are
    // logged inside recordCall.
    if (out.ok) {
      await recordCall(svc, { tenantId: settings?.tenant_id, adapter: adapterName });
      // Wave 1.4: also bump the per-run accumulator so the next
      // adapter call (or the next chunk) sees the accumulated
      // cost and can break-circuit if needed.
      if (runCost) runCost.add(adapterName);
    }
    if (out.ok && (conf == null || conf >= fallbackThreshold)) {
      return { adapter_used: adapterName, latency_ms, ...out, confidence_overall: conf, attempts };
    }
    const candidate = { adapter_used: adapterName, latency_ms, ...out, confidence_overall: conf };
    // KEEP THE BEST RESULT, NOT THE LAST ONE.
    //
    // `last` was reassigned on every iteration, so a LATER FAILURE overwrote an
    // EARLIER SUCCESS. Observed in production: LlamaParse returned a complete
    // parse at 0.82 — under the 0.85 fallback threshold, so the loop continued —
    // then Gemini and Claude both died on "run budget exhausted", and Claude's
    // failure became the run. The run persisted raw_extract: null,
    // normalized_extract: null and reported `failed`, throwing away a working
    // extraction AND the evidence needed to understand what happened.
    //
    // A successful extraction must survive anything that runs after it. Falling
    // through to a fallback is an attempt to do BETTER, never a reason to
    // discard what we already have.
    if (out.ok) {
      if (isBetterResult(candidate, best)) best = candidate;
    } else {
      lastFailure = candidate;
    }
    // Salvage geometry-bearing output from ANY adapter that produced it, even
    // one that failed. LlamaParse's `empty_lines` failure carries the full
    // markdown it parsed; losing that is what made the 6-lines-vs-44 question
    // unanswerable after the fact.
    if (out.raw && !salvagedRaw) salvagedRaw = { adapter: adapterName, raw: out.raw };
  }
  // Phase 3.6 observability (audit close): surface a structured
  // failure-reason so the operator can see why no adapter
  // contributed. Without this, the only signal was a 200 with
  // empty normalized + a notify-warn toast.
  // A success outranks any failure that ran after it. `lastFailure` is only
  // consulted when nothing succeeded at all.
  const last = best || lastFailure;
  if (!last) {
    const allSkipped = attempts.length > 0
      && attempts.every((a) => a.status === "skipped_not_configured");
    return {
      ok: false,
      reason: allSkipped ? "all_adapters_skipped" : "no_adapter_configured",
      error: "no docai adapter configured",
      attempts,
    };
  }
  // Salvage the parsed document from whichever adapter produced one, so a run
  // that ends in failure still persists something to diagnose from. Never
  // overwrites the chosen result's own raw, and records whose it is — mislabelled
  // provenance would be worse than none.
  const withSalvage = (r) => (r.raw || !salvagedRaw
    ? r
    : { ...r, raw: salvagedRaw.raw, raw_adapter: salvagedRaw.adapter });
  // `last` is whichever adapter ran LAST, not the best one — so after a
  // fall-through it is often a weak-but-ok result (LlamaParse returning zero
  // lines at 0.4 confidence). run.js persists `error: out?.error || null`, so
  // that weak result's empty error became the run's, and the REAL failures
  // above it — a Gemini 400, a Claude timeout — survived only inside
  // adapter_attempts. The run row then read "low confidence · review" with
  // error NULL, which is how an all-providers-down outage looked like a soft
  // parsing miss for hours. Lift the hard failures onto the run itself.
  const adapterFailures = attempts
    .filter((a) => a.status === "failed")
    .map((a) => ({ adapter: a.adapter, reason: a.reason || null, error: a.error || null }));
  if (!adapterFailures.length) return withSalvage({ ...last, attempts });
  return withSalvage({
    ...last,
    attempts,
    adapter_failures: adapterFailures,
    // Keep the winning adapter's own error when it has one; otherwise the run
    // inherits a readable summary of what actually broke upstream of it.
    error: last.error
      || adapterFailures.map((f) => f.adapter + ": " + (f.error || f.reason || "failed")).join(" | ").slice(0, 500),
  });
};
