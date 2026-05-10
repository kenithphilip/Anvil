// Per-tenant per-day per-adapter call counter + budget guard.
//
// Cost-optimisation pass for the docai pipeline. The PoC stays
// at $0/month if traffic naturally drains free tiers (Gemini
// 2.5 Flash, Azure DI F0). The guard exists so that if a
// runaway upload accidentally targets a paid adapter (Anthropic
// Claude, paid Reducto, etc.), we hard-stop at the per-day cap
// the operator configured on tenant_settings.docai_daily_limits.
//
// Two kinds of free adapters that we never gate:
//
//   1. Paid-tier-with-free-quota providers (Gemini, Azure DI F0).
//      The provider already enforces the free quota; over-the-cap
//      requests just return 429 / 403. We let the dispatcher
//      attempt them and surface whatever the provider says.
//
//   2. Self-hosted HTTP adapters (Docling, Marker, Unstructured-
//      OSS). The cost is the operator's compute, which they
//      already pay for. No per-call gate needed.
//
// Adapters we DO gate by default: claude, reducto, unstructured
// (hosted), azure_di (S0 paid). If docai_daily_limits is null on
// tenant_settings, every adapter is uncapped (legacy behaviour).
//
// Shape of docai_daily_limits jsonb:
//   { "claude": 50, "reducto": 100 }       cap per adapter
//   {}                                       no caps (legacy)
//   null                                     no caps (legacy)
//
// Shape of one docai_daily_usage row:
//   { tenant_id, usage_date, adapter, call_count, estimated_cost_usd, last_called_at }

// Adapters we treat as "always free" so the guard never blocks
// them even if they appear in docai_daily_limits.
const ALWAYS_FREE = new Set(["docling", "marker", "excel", "gaeb"]);

// Approximate USD cost per call for cost telemetry. These are
// midpoint estimates assuming ~5K input + ~500 output tokens per
// extraction; the operator overrides via env if they want
// different numbers.
//
// Bet 1 (May 2026): bumped to reflect the Gemini 3 Flash + Mistral
// OCR 3 + Sonnet 4.6 / Opus 4.7 chain.
//
//   Gemini 3 Flash: $0.50 in / $3 out per 1M -> ~$0.0035 per
//                   18-line PO at 5K in + 500 out (replaces
//                   gemini-2.5-flash at ~$0.0006).
//   Sonnet 4.6:     $3 in / $15 out per 1M -> ~$0.022 per same shape.
//                   Same as the legacy Sonnet 4 list price; the
//                   shift in the docai chain is that Sonnet now
//                   fires only as the confidence-fallback (~10-15%
//                   of traffic, prompt-cached at 0.1x reads), not
//                   as the primary.
//   Opus 4.7:       $5 in / $25 out, +35% from new tokenizer. Used
//                   only for escalate / re-extract.
//   Mistral OCR 3:  $1 / 1k pages batch -> ~$0.001 per PO at
//                   ~1 page per PO.
const DEFAULT_COST_USD = {
  claude:        Number(process.env.COST_USD_CLAUDE              || 0.022),
  // Bet 1: Gemini 3 Flash. The cheaper 2.5 Flash entry stays
  // env-pinnable via COST_USD_GEMINI_2_5_FLASH for tenants on the
  // legacy chain.
  gemini:        Number(process.env.COST_USD_GEMINI_3_FLASH
                   || process.env.COST_USD_GEMINI                || 0.0035),
  reducto:       Number(process.env.COST_USD_REDUCTO             || 0.01),
  azure_di:      Number(process.env.COST_USD_AZURE_DI            || 0.01),
  unstructured:  Number(process.env.COST_USD_UNSTRUCTURED        || 0.01),
  docling:       Number(process.env.COST_USD_DOCLING             || 0),
  marker:        Number(process.env.COST_USD_MARKER              || 0),
  // Bet 1: Mistral OCR 3 batch endpoint. Tenants who flip
  // docai_mistral_ocr_batch=false land on the realtime endpoint
  // (~$0.002 per page); operator overrides via env.
  mistral_ocr:   Number(process.env.COST_USD_MISTRAL_OCR_3
                   || process.env.COST_USD_MISTRAL_OCR           || 0.001),
};

const today = () => new Date().toISOString().slice(0, 10);     // YYYY-MM-DD

// Read today's call count for a (tenant, adapter). Best-effort:
// returns 0 on error so a transient DB issue doesn't lock the
// dispatcher out.
export const getDailyUsage = async (svc, { tenantId, adapter, date }) => {
  if (!svc || !tenantId || !adapter) return 0;
  try {
    const r = await svc.from("docai_daily_usage")
      .select("call_count")
      .eq("tenant_id", tenantId)
      .eq("usage_date", date || today())
      .eq("adapter", adapter)
      .maybeSingle();
    return Number(r?.data?.call_count || 0);
  } catch (_e) {
    return 0;
  }
};

// Decide whether an adapter is allowed to run RIGHT NOW. Returns
//   { allowed: bool, count: number, limit: number|null, reason?: string }
//
// Rules:
//   - ALWAYS_FREE adapters: allowed.
//   - tenant has no docai_daily_limits row: allowed.
//   - adapter not in the limits map: allowed (uncapped).
//   - adapter in the limits map with a numeric value: allowed
//     when current count < limit.
export const allowedToCall = async (svc, settings, adapter) => {
  if (!adapter || ALWAYS_FREE.has(adapter)) {
    return { allowed: true, count: 0, limit: null };
  }
  const limits = settings?.docai_daily_limits;
  if (!limits || typeof limits !== "object") {
    return { allowed: true, count: 0, limit: null };
  }
  const limit = Number(limits[adapter]);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, count: 0, limit: null };
  }
  const tenantId = settings?.tenant_id;
  const count = await getDailyUsage(svc, { tenantId, adapter });
  if (count >= limit) {
    return {
      allowed: false,
      count,
      limit,
      reason: "over_daily_budget",
    };
  }
  return { allowed: true, count, limit };
};

// Bump today's counter by 1 for a (tenant, adapter). Idempotency
// shape: rely on PG primary key (tenant_id, usage_date, adapter)
// to merge new rows; if the row exists, increment in-place.
//
// Best-effort: failures don't break the run, but we surface them
// to stderr so missing telemetry is visible.
export const recordCall = async (svc, { tenantId, adapter, costUsd }) => {
  if (!svc || !tenantId || !adapter) return;
  const date = today();
  const cost = Number.isFinite(Number(costUsd)) ? Number(costUsd) : (DEFAULT_COST_USD[adapter] || 0);
  try {
    const cur = await svc.from("docai_daily_usage")
      .select("call_count, estimated_cost_usd")
      .eq("tenant_id", tenantId)
      .eq("usage_date", date)
      .eq("adapter", adapter)
      .maybeSingle();
    if (cur?.data) {
      await svc.from("docai_daily_usage")
        .update({
          call_count: Number(cur.data.call_count || 0) + 1,
          estimated_cost_usd: Number(cur.data.estimated_cost_usd || 0) + cost,
          last_called_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("usage_date", date)
        .eq("adapter", adapter);
    } else {
      await svc.from("docai_daily_usage").insert({
        tenant_id: tenantId,
        usage_date: date,
        adapter,
        call_count: 1,
        estimated_cost_usd: cost,
        last_called_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    /* eslint-disable no-console */
    console.warn("[cost_guard] recordCall failed: " + (err?.message || err));
  }
};

// Convenience: return the current usage shape for a tenant. Used
// by /api/docai/usage to surface today's counters in the admin UI.
export const summariseUsage = async (svc, { tenantId, date }) => {
  if (!svc || !tenantId) return [];
  const r = await svc.from("docai_daily_usage")
    .select("adapter, call_count, estimated_cost_usd, last_called_at")
    .eq("tenant_id", tenantId)
    .eq("usage_date", date || today())
    .order("call_count", { ascending: false });
  return r?.data || [];
};

export const __consts__ = { ALWAYS_FREE, DEFAULT_COST_USD };
