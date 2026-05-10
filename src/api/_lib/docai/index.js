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
import { allowedToCall, recordCall } from "../cost_guard.js";
import { serviceClient } from "../supabase.js";

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

export const dispatchExtract = async ({ source, settings, customerId, hints }) => {
  const sourceType = source.sourceType || guessSourceType(source);
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
  const order = settings?.docai_provider_order
    || ["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"];
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
