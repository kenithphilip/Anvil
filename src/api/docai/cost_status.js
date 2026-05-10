// GET /api/docai/cost_status
//
// Single-shot aggregator for the "is this tenant cost-optimised"
// admin panel. Combines:
//
//   - Today's per-adapter usage (docai_daily_usage)
//   - 7-day usage trend (sum + per-day breakdown)
//   - Configured adapter chain (tenant_settings.docai_provider_order)
//   - Per-adapter daily caps (tenant_settings.docai_daily_limits)
//   - Anthropic model selector (tenant_settings.docai_anthropic_model)
//   - Adapter health (env keys + tenant-encrypted keys present)
//   - Recommendations: actionable suggestions to reduce spend
//
// The recommendations engine is small and deterministic; rules
// listed below. Each rule emits at most one suggestion so the
// admin UI doesn't drown the operator. Rules are ordered by
// expected $ saved.
//
// Auth: anyone with read can see usage; recommendations only
// surface actionable hints (no secret keys).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { __consts__ as costConsts } from "../_lib/cost_guard.js";

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const DEFAULT_ORDER = ["gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude"];
const FREE_FRIENDLY = new Set(["gemini", "docling", "marker", "azure_di"]);
const PAID_LLMS = new Set(["claude"]);

// Rules: each takes (state) -> { id, severity, title, body, action } | null
const RULES = [
  // R1. Gemini not configured. The single biggest PoC saving.
  (s) => {
    if (!s.adapterHealth.gemini && !s.tenantHasKey.gemini) {
      return {
        id: "gemini_unconfigured",
        severity: "warn",
        title: "Gemini is not configured",
        body: "Gemini 2.5 Flash has a free tier (1500 RPD, 1M TPM, no card required). With it configured, PoC traffic costs $0/month. Set GEMINI_API_KEY in Vercel env or store an encrypted key per tenant.",
        action: "set_env_var:GEMINI_API_KEY",
      };
    }
    return null;
  },
  // R2. Claude configured but no daily cap. Runaway cost risk.
  (s) => {
    const hasKey = s.adapterHealth.claude || s.tenantHasKey.claude;
    const cap = s.dailyLimits?.claude;
    if (hasKey && (cap == null || Number(cap) <= 0)) {
      return {
        id: "claude_uncapped",
        severity: "bad",
        title: "Claude is uncapped",
        body: "Without a daily cap, a single corrupt PDF in a retry loop can drain credits in minutes. Set docai_daily_limits.claude to a small number (25-50 for PoC).",
        action: "set_daily_limit:claude",
      };
    }
    return null;
  },
  // R3. Sonnet 4 in use. Recommend Haiku for PoC.
  (s) => {
    const model = s.anthropicModel || process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-20250514";
    if (/sonnet/i.test(model) && !s.todayUsage.find((u) => u.adapter === "claude")?.call_count) {
      // Don't nag if Claude isn't actually being used.
      return null;
    }
    if (/sonnet/i.test(model)) {
      return {
        id: "anthropic_sonnet_default",
        severity: "info",
        title: "Anthropic is on Sonnet (~4x more expensive than Haiku)",
        body: "Sonnet 4 is ~$0.022/extraction; Haiku 4.5 is ~$0.006/extraction. For clean PDFs Haiku is plenty. Set docai_anthropic_model='claude-haiku-4-5-20251001' to flip per-tenant.",
        action: "set_anthropic_model:claude-haiku-4-5-20251001",
      };
    }
    return null;
  },
  // R4. Adapter chain doesn't put a free adapter first.
  (s) => {
    const order = s.providerOrder || DEFAULT_ORDER;
    const first = order[0];
    if (PAID_LLMS.has(first)) {
      return {
        id: "paid_first_in_chain",
        severity: "warn",
        title: "Paid adapter is first in the chain",
        body: "The dispatcher tries '" + first + "' before any free adapter. Reorder docai_provider_order to put free adapters first (gemini, docling, azure_di) so the LLM is a fallback, not the default.",
        action: "reorder_chain",
      };
    }
    return null;
  },
  // R5. Heavy Claude usage today (defined as > 25 calls/day).
  (s) => {
    const claudeUsage = s.todayUsage.find((u) => u.adapter === "claude");
    if (claudeUsage && Number(claudeUsage.call_count) > 25 && !s.adapterHealth.gemini && !s.tenantHasKey.gemini) {
      return {
        id: "heavy_claude_no_gemini",
        severity: "warn",
        title: "Heavy Claude usage today",
        body: "Claude has fired " + claudeUsage.call_count + " times today. Configure Gemini as the primary extractor to drop cost ~95% on the same volume.",
        action: "set_env_var:GEMINI_API_KEY",
      };
    }
    return null;
  },
  // R6. No OCR adapter configured (image-only PDFs would burn LLM credits).
  (s) => {
    if (!s.adapterHealth.mistral_ocr && !s.tenantHasKey.mistral_ocr && !s.adapterHealth.azure_di && !s.tenantHasKey.azure_di) {
      return {
        id: "no_ocr_adapter",
        severity: "info",
        title: "No OCR adapter configured",
        body: "Image-only PDFs (scanned POs) need either Mistral OCR (free Experiment tier) or Azure DI F0 (free 500 pages/mo) to extract text. Without one, the LLM gets binary noise and credits burn for nothing.",
        action: "set_env_var:MISTRAL_API_KEY",
      };
    }
    return null;
  },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);

    // Configurable trend window (clamped 1..90).
    const url = new URL(req.url || "", "http://x");
    const requestedDays = Number(url.searchParams.get("days"));
    const days = Number.isFinite(requestedDays) && requestedDays >= 1
      ? Math.min(90, Math.floor(requestedDays))
      : 7;

    // Today's usage.
    const todayResp = await svc.from("docai_daily_usage")
      .select("adapter, call_count, estimated_cost_usd, last_called_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("usage_date", today())
      .order("call_count", { ascending: false });
    const todayUsage = todayResp.data || [];

    // N-day trend, raw rows so the frontend can build a per-day
    // per-adapter chart. We still emit a rollup for callers that
    // only want totals.
    const trendResp = await svc.from("docai_daily_usage")
      .select("usage_date, adapter, call_count, estimated_cost_usd")
      .eq("tenant_id", ctx.tenantId)
      .gte("usage_date", daysAgo(days))
      .order("usage_date", { ascending: true });
    const trendRows = trendResp.data || [];
    const trendRollup = trendRows.reduce((acc, r) => {
      acc.calls += Number(r.call_count || 0);
      acc.cost  += Number(r.estimated_cost_usd || 0);
      return acc;
    }, { calls: 0, cost: 0 });
    // Keep the legacy 7-day rollup name for back-compat with
    // existing UI bindings.
    const trend7d = trendRollup;

    // Per-day per-adapter buckets for the chart.
    // shape: { dates: [...], adapters: [...], series: { [adapter]: { calls: [...], cost: [...] } } }
    const trendSeries = (() => {
      const dateSet = new Set();
      const adapterSet = new Set();
      const byKey = new Map();          // `${date}__${adapter}` -> { calls, cost }
      for (const r of trendRows) {
        const date = r.usage_date.slice(0, 10);
        const adapter = r.adapter;
        dateSet.add(date);
        adapterSet.add(adapter);
        byKey.set(date + "__" + adapter, {
          calls: Number(r.call_count || 0),
          cost: Number(r.estimated_cost_usd || 0),
        });
      }
      // Fill every date in the window so the x-axis is dense.
      const allDates = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        allDates.push(d.toISOString().slice(0, 10));
      }
      const adapters = Array.from(adapterSet).sort();
      const series = {};
      for (const a of adapters) {
        series[a] = {
          calls: allDates.map((d) => byKey.get(d + "__" + a)?.calls || 0),
          cost: allDates.map((d) => byKey.get(d + "__" + a)?.cost || 0),
        };
      }
      return { dates: allDates, adapters, series };
    })();

    // Burn rate: today vs N-day median (excluding today). Per-adapter.
    const burn = (() => {
      const out = {};
      for (const adapter of trendSeries.adapters) {
        const allCalls = trendSeries.series[adapter].calls;
        // Median of the historical days (everything except the
        // last entry, which is today).
        const historical = allCalls.slice(0, -1).filter((n) => n > 0).sort((a, b) => a - b);
        const median = historical.length
          ? historical[Math.floor(historical.length / 2)]
          : 0;
        const todayCount = allCalls[allCalls.length - 1] || 0;
        const ratio = median > 0 ? todayCount / median : (todayCount > 0 ? Infinity : 0);
        out[adapter] = {
          today_calls: todayCount,
          median_n_calls: median,
          ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
          window_days: days,
        };
      }
      return out;
    })();

    // Anomalies: days where calls > 2x median for that adapter.
    const anomalies = [];
    for (const adapter of trendSeries.adapters) {
      const allCalls = trendSeries.series[adapter].calls;
      const sorted = [...allCalls].filter((n) => n > 0).sort((a, b) => a - b);
      if (!sorted.length) continue;
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median <= 0) continue;
      allCalls.forEach((n, i) => {
        if (n >= 2 * median && n >= 5) {
          anomalies.push({
            adapter,
            date: trendSeries.dates[i],
            calls: n,
            median,
            multiplier: Number((n / median).toFixed(2)),
          });
        }
      });
    }

    // Forecast: at today's burn rate, when does each adapter's cap
    // exhaust this calendar day? Returns hours-remaining estimate.
    const forecast = (() => {
      const limits = settings?.docai_daily_limits || {};
      const out = {};
      const todayMap = Object.fromEntries(todayUsage.map((u) => [u.adapter, Number(u.call_count || 0)]));
      for (const adapter of Object.keys(limits)) {
        const cap = Number(limits[adapter]);
        if (!Number.isFinite(cap) || cap <= 0) continue;
        const used = todayMap[adapter] || 0;
        const remaining = Math.max(0, cap - used);
        // Hours into today (UTC).
        const now = new Date();
        const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const hoursElapsed = Math.max(0.1, (now - startOfDay) / 3_600_000);
        const ratePerHour = used / hoursElapsed;
        const hoursToCap = ratePerHour > 0 ? remaining / ratePerHour : null;
        out[adapter] = {
          cap,
          used,
          remaining,
          rate_per_hour: Number(ratePerHour.toFixed(2)),
          hours_to_cap: hoursToCap == null ? null : Math.max(0, Number(hoursToCap.toFixed(1))),
          will_hit_cap_today: hoursToCap != null && hoursToCap < (24 - hoursElapsed),
        };
      }
      return out;
    })();

    // Adapter health (env-var presence). Mirrors the dispatcher's
    // isConfigured precedence: env beats tenant-encrypted key.
    const adapterHealth = {
      gemini:        !!process.env.GEMINI_API_KEY,
      claude:        !!process.env.ANTHROPIC_API_KEY,
      reducto:       !!process.env.REDUCTO_API_KEY,
      azure_di:      !!process.env.AZURE_DI_KEY && !!process.env.AZURE_DI_ENDPOINT,
      unstructured:  !!process.env.UNSTRUCTURED_API_KEY,
      docling:       !!process.env.DOCLING_ENDPOINT,
      marker:        !!process.env.MARKER_ENDPOINT,
      mistral_ocr:   !!process.env.MISTRAL_API_KEY,
    };
    // Per-tenant key presence (without revealing the key itself).
    const tenantHasKey = {
      gemini:        !!settings?.docai_gemini_api_key_enc,
      claude:        false,                                            // platform-wide only
      reducto:       !!settings?.docai_reducto_api_key_enc,
      azure_di:      !!settings?.docai_azure_di_endpoint && !!settings?.docai_azure_di_key_enc,
      unstructured:  !!settings?.docai_unstructured_api_key_enc || !!settings?.docai_unstructured_endpoint,
      docling:       !!settings?.docai_docling_endpoint,
      marker:        !!settings?.docai_marker_endpoint,
      mistral_ocr:   false,
    };

    const ruleState = {
      todayUsage,
      dailyLimits: settings?.docai_daily_limits || null,
      providerOrder: settings?.docai_provider_order || null,
      anthropicModel: settings?.docai_anthropic_model || null,
      adapterHealth,
      tenantHasKey,
    };
    const recommendations = RULES.map((r) => r(ruleState)).filter(Boolean);

    // Estimate dollar impact: free-friendly adapters today.
    const freeFriendlyCalls = todayUsage
      .filter((u) => FREE_FRIENDLY.has(u.adapter))
      .reduce((acc, u) => acc + Number(u.call_count || 0), 0);
    const paidCalls = todayUsage
      .filter((u) => !FREE_FRIENDLY.has(u.adapter) && !costConsts.ALWAYS_FREE.has(u.adapter))
      .reduce((acc, u) => acc + Number(u.call_count || 0), 0);

    return json(res, 200, {
      date: today(),
      window_days: days,
      today_usage: todayUsage,
      trend_7d: trend7d,
      trend_window: trendRollup,
      trend_series: trendSeries,
      burn,
      anomalies,
      forecast,
      provider_order: settings?.docai_provider_order || DEFAULT_ORDER,
      provider_order_default: !settings?.docai_provider_order,
      daily_limits: settings?.docai_daily_limits || null,
      anthropic_model: settings?.docai_anthropic_model
        || process.env.ANTHROPIC_MODEL_DEFAULT
        || "claude-sonnet-4-20250514",
      adapter_health: adapterHealth,
      tenant_has_key: tenantHasKey,
      recommendations,
      summary: {
        calls_today: todayUsage.reduce((acc, u) => acc + Number(u.call_count || 0), 0),
        cost_today_usd: Number(
          todayUsage.reduce((acc, u) => acc + Number(u.estimated_cost_usd || 0), 0).toFixed(4)
        ),
        free_friendly_calls_today: freeFriendlyCalls,
        paid_calls_today: paidCalls,
        warnings: recommendations.filter((r) => r.severity === "warn" || r.severity === "bad").length,
        anomalies_count: anomalies.length,
        forecast_caps_at_risk_today: Object.values(forecast).filter((f) => f.will_hit_cap_today).length,
      },
    });
  } catch (err) { sendError(res, err); }
}
