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

const ADAPTERS = {
  reducto, azure_di: azureDI, unstructured, excel, claude: claudeAdapter,
};

const guessSourceType = ({ filename, mime }) => {
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".xlsx") || f.endsWith(".xlsm") || f.endsWith(".xls")) return "xlsx";
  if (mime?.startsWith("image/")) return "image";
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
  // GAEB routes to its own deterministic parser (Phase 5.3 will land
  // a real GAEB module; for now fall through to Claude).
  const order = settings?.docai_provider_order
    || ["reducto", "azure_di", "unstructured", "claude"];
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
  return last
    ? { ...last, attempts }
    : { ok: false, error: "no docai adapter configured", attempts };
};
