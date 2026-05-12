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
        attempts.push({ adapter: adapterName, status: fb.ok ? "ok" : "failed", ms: Date.now() - tStart, confidence: conf });
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
  const defaultStaticOrder = ["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"];
  let order = settings?.docai_provider_order || defaultStaticOrder;
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
  const attempts = [];
  let last = null;
  // Materialise an svc reference once so per-iteration cost-guard
  // checks don't re-spawn the client. Best-effort: a missing
  // SUPABASE_URL leaves svc null and the guard treats that as
  // "no limits" (legacy behaviour).
  let svc = null;
  try { svc = serviceClient(); } catch (_e) { svc = null; }
  for (const adapterName of order) {
    const adapter = ADAPTERS[adapterName];
    if (!adapter) continue;
    if (!adapter.isConfigured(settings)) {
      attempts.push({ adapter: adapterName, status: "skipped_not_configured" });
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
        hints,
        promptOverrides: buildPromptOverrides(settings, customerId),
      });
    } catch (err) {
      attempts.push({ adapter: adapterName, status: "error", ms: Date.now() - t0, error: err.message });
      last = { ok: false, error: err.message };
      continue;
    }
    const latency_ms = Date.now() - t0;
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
    attempts.push({
      adapter: adapterName,
      status: out.ok ? (conf != null && conf < fallbackThreshold ? "low_confidence" : "ok") : "failed",
      ms: latency_ms,
      confidence: conf,
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
    last = { adapter_used: adapterName, latency_ms, ...out, confidence_overall: conf };
  }
  // Phase 3.6 observability (audit close): surface a structured
  // failure-reason so the operator can see why no adapter
  // contributed. Without this, the only signal was a 200 with
  // empty normalized + a notify-warn toast.
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
  return { ...last, attempts };
};
