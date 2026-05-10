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

const ADAPTERS = {
  reducto,
  azure_di: azureDI,
  unstructured,
  excel,
  claude: claudeAdapter,
  gaeb,
  docling,
  marker,
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
    const order = settings?.docai_provider_order
      || ["docling", "marker", "claude", "reducto", "azure_di", "unstructured"];
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
  // Default order favours self-hostable / deterministic adapters
  // first (zero per-page cost when configured), then the hosted
  // doc-AI options, then Claude as the LLM fallback. The dispatcher
  // skips any adapter whose isConfigured(settings) returns false,
  // so an operator who configures only Claude still gets the
  // single-adapter path with no extra latency.
  const order = settings?.docai_provider_order
    || ["docling", "marker", "unstructured", "reducto", "azure_di", "claude"];
  const attempts = [];
  let last = null;
  for (const adapterName of order) {
    const adapter = ADAPTERS[adapterName];
    if (!adapter) continue;
    if (!adapter.isConfigured(settings)) {
      attempts.push({ adapter: adapterName, status: "skipped_not_configured" });
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
    attempts.push({
      adapter: adapterName,
      status: out.ok ? (conf != null && conf < 0.7 ? "low_confidence" : "ok") : "failed",
      ms: latency_ms,
      confidence: conf,
    });
    if (out.ok && (conf == null || conf >= 0.7)) {
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
