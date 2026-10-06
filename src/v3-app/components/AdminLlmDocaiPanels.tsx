// Admin Center LLM + DocAI panels — extracted verbatim from screens/admin.tsx
// (provider selection, DocAI adapter config, DocAI cost/trend). Split out to
// keep admin.tsx maintainable. CostTrendChart + the constants stay internal.

import React, { useState, useEffect, useCallback } from "react";
import { Banner, Btn, Card, Chip, KV } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// DocAI cost panel.
//
// Reads /api/docai/cost_status (today's per-adapter usage + 7-day
// trend + adapter health + per-tenant caps + recommended actions),
// and lets an admin PATCH /api/admin/docai_settings to update the
// cost levers (provider order, daily limits, anthropic + gemini
// model selectors) without writing SQL.
//
// Self-contained so admin.tsx stays readable.
// ============================================================

// Bet 1: mistral_ocr is now a first-class adapter row in the chain
// editor + cost panel. It runs as the OCR LAYER (image-only PDFs)
// not in the structured-extraction provider chain itself, but
// surfacing it here lets operators see usage + cost alongside the
// other adapters.
const DOCAI_ADAPTERS_LIST = [
  "gemini", "claude", "reducto", "azure_di", "unstructured",
  "docling", "marker", "mistral_ocr", "llamaparse",
] as const;

type CostStatus = {
  date: string;
  window_days?: number;
  today_usage: Array<{ adapter: string; call_count: number; estimated_cost_usd: number; last_called_at?: string | null }>;
  trend_7d: { calls: number; cost: number };
  trend_window?: { calls: number; cost: number };
  trend_series?: {
    dates: string[];
    adapters: string[];
    series: Record<string, { calls: number[]; cost: number[] }>;
  };
  burn?: Record<string, { today_calls: number; median_n_calls: number; ratio: number | null; window_days: number }>;
  anomalies?: Array<{ adapter: string; date: string; calls: number; median: number; multiplier: number }>;
  forecast?: Record<string, { cap: number; used: number; remaining: number; rate_per_hour: number; hours_to_cap: number | null; will_hit_cap_today: boolean }>;
  provider_order: string[];
  provider_order_default: boolean;
  daily_limits: Record<string, number> | null;
  anthropic_model: string;
  // Bet 1 additions.
  gemini_model?: string;
  fallback_confidence?: number;
  mistral_ocr_batch?: boolean;
  gemini_media_resolution?: string;
  adapter_health: Record<string, boolean>;
  tenant_has_key: Record<string, boolean>;
  recommendations: Array<{ id: string; severity: string; title: string; body: string; action?: string }>;
  summary: { calls_today: number; cost_today_usd: number; free_friendly_calls_today: number; paid_calls_today: number; warnings: number; anomalies_count?: number; forecast_caps_at_risk_today?: number };
};

// Color palette for stacked-area chart series. Mirrors the brand
// tokens in styles.css; the order is stable so 'gemini' always
// gets the brand chartreuse, 'claude' always gets sage, etc.
const COST_CHART_COLORS: Record<string, string> = {
  gemini:       "var(--accent)",
  claude:       "var(--sage)",
  reducto:      "var(--lapis)",
  azure_di:     "var(--plum)",
  unstructured: "var(--amber)",
  docling:      "var(--accent-2)",
  marker:       "var(--rust)",
  // Bet 1: Mistral OCR 3 OCR layer.
  mistral_ocr:  "var(--lapis-2)",
};
const fallbackColor = (i: number) => {
  const fallback = ["var(--accent-3)", "var(--sage-3)", "var(--lapis-3)", "var(--plum-3)", "var(--amber-3)", "var(--rust-3)"];
  return fallback[i % fallback.length];
};

// Inline SVG stacked-area chart for the per-day cost trend. No
// external chart library; mirrors the inventory-item.tsx pattern
// (lines 140-189). The y-axis is total $ spend per day, with each
// adapter's contribution stacked. The cap line (if any) is the
// max of all per-adapter daily caps from docai_daily_limits.
const CostTrendChart: React.FC<{
  series: NonNullable<CostStatus["trend_series"]>;
  metric: "calls" | "cost";
  capLine?: number | null;
}> = ({ series, metric, capLine }) => {
  const W = 760;
  const H = 240;
  const padL = 36;
  const padR = 16;
  const padT = 10;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const dates = series.dates;
  const adapters = series.adapters;

  const dailyTotals = dates.map((_, dayIdx) =>
    adapters.reduce((acc, a) => acc + (series.series[a]?.[metric][dayIdx] || 0), 0)
  );
  const yMaxRaw = Math.max(...dailyTotals, capLine != null ? capLine : 0, 1);
  const yMax = niceCeiling(yMaxRaw);
  const xStep = dates.length > 1 ? innerW / (dates.length - 1) : innerW;
  const xAt = (i: number) => padL + i * xStep;
  const yAt = (v: number) => padT + innerH - (v / yMax) * innerH;

  // Stacked layers: bottom-up. For each adapter compute the
  // running cumulative total at each date; build the polygon as
  // top edge (cumulative) + bottom edge (previous cumulative).
  const cum: number[] = dates.map(() => 0);
  const layers = adapters.map((adapter) => {
    const data = series.series[adapter]?.[metric] || dates.map(() => 0);
    const top = dates.map((_, i) => {
      cum[i] += data[i];
      return cum[i];
    });
    const bottom = dates.map((_, i) => cum[i] - data[i]);
    const points: [number, number][] = [];
    for (let i = 0; i < dates.length; i++) points.push([xAt(i), yAt(top[i])]);
    for (let i = dates.length - 1; i >= 0; i--) points.push([xAt(i), yAt(bottom[i])]);
    return { adapter, top, bottom, polygon: points.map((p) => p.join(",")).join(" ") };
  });

  const fmtY = (v: number) => metric === "cost" ? "$" + v.toFixed(2) : String(v);

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }} role="img" aria-label="DocAI per-day usage chart">
        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <line key={i}
                x1={padL} y1={padT + innerH * (1 - t)}
                x2={W - padR} y2={padT + innerH * (1 - t)}
                stroke="var(--hairline-2)" strokeWidth={0.5} />
        ))}
        {/* y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <text key={i}
                x={padL - 4} y={padT + innerH * (1 - t) + 3}
                textAnchor="end" fontSize={10} fill="var(--ink-3)"
                fontFamily="monospace">
            {fmtY(yMax * t)}
          </text>
        ))}
        {/* stacked layers */}
        {layers.map((layer, i) => (
          <polygon key={layer.adapter}
                   points={layer.polygon}
                   fill={COST_CHART_COLORS[layer.adapter] || fallbackColor(i)}
                   fillOpacity={0.55}
                   stroke={COST_CHART_COLORS[layer.adapter] || fallbackColor(i)}
                   strokeWidth={1} />
        ))}
        {/* cap line overlay */}
        {capLine != null && capLine > 0 && capLine <= yMax && (
          <g>
            <line x1={padL} y1={yAt(capLine)} x2={W - padR} y2={yAt(capLine)}
                  stroke="var(--rust)" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={W - padR} y={yAt(capLine) - 4} textAnchor="end"
                  fontSize={10} fill="var(--rust)" fontFamily="monospace">
              cap {fmtY(capLine)}
            </text>
          </g>
        )}
        {/* x-axis labels: first, last, and every 5th day in between to avoid crowding */}
        {dates.map((d, i) => {
          const show = i === 0 || i === dates.length - 1 || i % Math.max(1, Math.floor(dates.length / 7)) === 0;
          if (!show) return null;
          return (
            <text key={d}
                  x={xAt(i)} y={H - 8}
                  textAnchor="middle" fontSize={10} fill="var(--ink-3)"
                  fontFamily="monospace">
              {d.slice(5)}
            </text>
          );
        })}
      </svg>
      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 6, padding: "0 8px" }}>
        {adapters.map((a, i) => (
          <span key={a} className="mono-sm" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-2)" }}>
            <span style={{
              width: 10, height: 10, borderRadius: 2,
              backgroundColor: COST_CHART_COLORS[a] || fallbackColor(i),
              opacity: 0.7,
            }} />
            {a}
          </span>
        ))}
      </div>
    </div>
  );
};

// Pick a "nice" axis ceiling (50 -> 50; 11 -> 12; 1.3 -> 2; etc.).
const niceCeiling = (v: number): number => {
  if (v <= 0) return 1;
  if (v <= 1) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  if (f <= 1.5) return 1.5 * exp;
  if (f <= 2) return 2 * exp;
  if (f <= 5) return 5 * exp;
  return 10 * exp;
};

// Build a CSV from the trend series. Columns: date, then one
// per adapter for the chosen metric. Used for the Export button.
const buildTrendCsv = (series: NonNullable<CostStatus["trend_series"]>, metric: "calls" | "cost"): string => {
  const header = ["date", ...series.adapters].join(",");
  const rows = series.dates.map((d, i) => {
    const cells = [d, ...series.adapters.map((a) => String(series.series[a]?.[metric][i] ?? 0))];
    return cells.join(",");
  });
  return [header, ...rows].join("\n") + "\n";
};
const downloadCsv = (filename: string, content: string) => {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Item-master custom-field schema editor. Lets a tenant admin
// define their own extension fields for the Item Master without a
// code migration. Each field has a key, label, type, group, and
// visibility flags (invoice vs PO vs master) so the same field can
// be opted in/out of customer-facing or supplier-facing documents.
const LLM_FEATURE_LABELS: Record<string, string> = {
  email_classifier: "Email classifier",
  anomaly_explain: "Anomaly explainer",
  inventory_explain: "Inventory explainer",
  customer_health_score: "Customer health score",
};
export const LlmProviderCard: React.FC = () => {
  const [provider, setProvider] = useState<string>("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [features, setFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const s: any = await (AnvilBackend as any)?.admin?.llmSettings?.();
      setProvider(s?.llm_provider || "");
      setOverrides((s?.llm_provider_overrides && typeof s.llm_provider_overrides === "object") ? s.llm_provider_overrides : {});
      setFeatures(Array.isArray(s?.features) ? s.features : Object.keys(LLM_FEATURE_LABELS));
    } catch (_) { setFeatures(Object.keys(LLM_FEATURE_LABELS)); } finally { setLoading(false); }
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const clean: Record<string, string> = {};
      for (const [f, p] of Object.entries(overrides)) { if (p) clean[f] = p; }
      await (AnvilBackend as any)?.admin?.updateLlmSettings?.({ llm_provider: provider || null, llm_provider_overrides: clean });
      await reload();
      setMsg("Saved");
      window.notifySuccess?.("LLM provider settings saved", "");
    } catch (e: any) {
      setMsg(e?.message || String(e));
      window.notifyError?.("Save failed", e?.message || String(e));
    } finally { setSaving(false); }
  };

  const sel = (value: string, onChange: (v: string) => void) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 160 }}>
      <option value="">Default (Claude)</option>
      <option value="claude">Claude</option>
      <option value="gemini">Gemini</option>
    </select>
  );

  return (
    <Card title="Reasoning LLM provider" eyebrow="which engine runs the non-extraction AI features · default Claude">
      <div className="col gap-sm" style={{ maxWidth: 560 }}>
        <label className="row gap-sm" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <span className="mono-sm"><b>Tenant default</b> — all reasoning features</span>
          {sel(provider, setProvider)}
        </label>
        <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>Per-feature overrides{loading ? " (loading…)" : ""}:</div>
        {(features.length ? features : Object.keys(LLM_FEATURE_LABELS)).map((f) => (
          <label key={f} className="row gap-sm" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <span className="mono-sm">{LLM_FEATURE_LABELS[f] || f}</span>
            {sel(overrides[f] || "", (v) => setOverrides({ ...overrides, [f]: v }))}
          </label>
        ))}
        <div className="row gap-sm" style={{ alignItems: "center", marginTop: 4 }}>
          <Btn sm kind="primary" disabled={saving} onClick={save}>{saving ? "saving…" : "Save"}</Btn>
          {msg && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{msg}</span>}
        </div>
        <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
          Gemini needs <b>GEMINI_API_KEY</b> set on the server. The copilot + KB assistant stay on Claude regardless (not yet routed). Precedence: per-feature &gt; env &gt; tenant default &gt; Claude.
        </div>
      </div>
    </Card>
  );
};

// Issue #210: per-tenant DocAI provider keys (BYOK). Enter an API key per
// provider; it's encrypted at rest (shared docai_creds_iv) and adapters use the
// tenant key first, then the env var. External providers carry a residency
// warning — routing Indian POs to a US/EU SaaS is DPDPA exposure.
type DocaiProviderRow = { id: string; label: string; external: boolean; region: string; key_present: boolean };
export const DocaiProvidersPanel: React.FC = () => {
  const [providers, setProviders] = useState<DocaiProviderRow[]>([]);
  const [order, setOrder] = useState<string[] | null>(null);
  const [secretsOk, setSecretsOk] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const r: any = await (AnvilBackend as any)?.docai?.providerKeys?.();
      if (r?.providers) { setProviders(r.providers); setOrder(r.provider_order || null); setSecretsOk(r.secrets_configured !== false); }
    } catch (_e) { /* panel is optional */ }
  };
  useEffect(() => { load(); }, []);

  const saveKey = async (id: string, clear = false) => {
    const val = clear ? null : (drafts[id] || "").trim();
    if (!clear && !val) { window.notifyError?.("Enter a key", "Type the API key, then Save."); return; }
    setSavingId(id);
    try {
      const resp: any = await (AnvilBackend as any)?.docai?.saveProviderKeys?.({ keys: { [id]: clear ? null : val } });
      if (!resp || resp.error) { window.notifyError?.("Save failed", (resp && resp.error && resp.error.message) || "could not store the key"); }
      else { window.notifySuccess?.(clear ? "Key cleared" : "Key saved", id); setDrafts((d) => ({ ...d, [id]: "" })); await load(); }
    } catch (err: any) { window.notifyError?.("Save failed", String(err?.message || err)); }
    setSavingId(null);
  };

  return (
    <Card title="DocAI providers · bring-your-own-key" eyebrow="AI · per-tenant credentials">
      {!secretsOk && (
        <Banner kind="bad" icon={Icon.alert} title="Secret storage not configured">
          <span className="mono-sm">ANVIL_SECRETS_KEY is not set on this deployment — provider keys can't be stored.</span>
        </Banner>
      )}
      <Banner kind="warn" icon={Icon.alert} title="Data residency (DPDPA)">
        <span className="mono-sm">External providers send document contents — GSTINs, prices, part IP — outside India. Enable one only with customer consent; the in-house pipeline stays the default.</span>
      </Banner>
      <table className="tbl" style={{ marginTop: 10 }}>
        <thead><tr><th>Provider</th><th>Region</th><th>API key</th><th style={{ width: 130 }}></th></tr></thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id}>
              <td><span className="pri">{p.label}</span></td>
              <td><Chip k={p.external ? "warn" : "good"}>{p.external ? "external · " + p.region : p.region}</Chip></td>
              <td>
                <input type="password" className="input mono" style={{ width: 240 }}
                  value={drafts[p.id] || ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder={p.key_present ? "•••••••• set — type to replace" : "enter API key"} aria-label={p.label + " API key"} />
              </td>
              <td>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <Btn sm kind="primary" disabled={savingId === p.id || !secretsOk} onClick={() => saveKey(p.id)}>{savingId === p.id ? "…" : "Save"}</Btn>
                  {p.key_present && <Btn sm kind="ghost" disabled={savingId === p.id} onClick={() => saveKey(p.id, true)}>Clear</Btn>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 8 }}>
        Keys are encrypted at rest and never shown again. Adapters use the tenant key first, then the env var.
        {order && order.length ? " · Provider order: " + order.join(" → ") : ""}
      </div>
    </Card>
  );
};

export const DocAICostPanel: React.FC = () => {
  const [data, setData] = useState<CostStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    docai_provider_order: string[];
    docai_daily_limits: Record<string, number | "">;
    docai_anthropic_model: string;
    docai_gemini_model: string;
    // Bet 1: confidence-fallback slider, Mistral OCR batch flag,
    // Gemini media_resolution picker.
    docai_fallback_confidence: number;
    docai_mistral_ocr_batch: boolean;
    docai_gemini_media_resolution: string;
  }>({
    docai_provider_order: [],
    docai_daily_limits: {},
    docai_anthropic_model: "",
    docai_gemini_model: "",
    docai_fallback_confidence: 0.85,
    docai_mistral_ocr_batch: true,
    docai_gemini_media_resolution: "high",
  });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<"calls" | "cost">("calls");

  const reload = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const next = await (AnvilBackend as any)?.docai?.costStatus?.();
      setData(next);
      // Seed the editable form with the current values.
      // Bet 1: drop the legacy claude-sonnet-4-20250514 default
      // through to "" so the placeholder hint surfaces; same for
      // claude-haiku-4-5-20251001 (deprecated as a docai default).
      const legacyAnthropic = (m: string) =>
        /sonnet-4-20250514/.test(m) || /haiku-4-5-20251001/.test(m);
      // Bet 1: drop legacy gemini-2.5-flash through to "" so the
      // placeholder surfaces.
      const legacyGemini = (m: string) => /^gemini-2\.5/.test(m);
      setForm({
        docai_provider_order: Array.isArray(next?.provider_order) && !next?.provider_order_default
          ? next.provider_order
          : (next?.provider_order || []),
        docai_daily_limits: Object.fromEntries(
          Object.entries(next?.daily_limits || {}).map(([k, v]) => [k, Number(v)])
        ),
        docai_anthropic_model: next?.anthropic_model && !legacyAnthropic(next.anthropic_model)
          ? next.anthropic_model
          : "",
        docai_gemini_model: next?.gemini_model && !legacyGemini(next.gemini_model)
          ? next.gemini_model
          : "",
        docai_fallback_confidence: typeof next?.fallback_confidence === "number"
          ? next.fallback_confidence
          : 0.85,
        docai_mistral_ocr_batch: next?.mistral_ocr_batch !== false,
        docai_gemini_media_resolution: next?.gemini_media_resolution || "high",
      });
    } catch (e) {
      setError(e);
    } finally { setLoading(false); }
  }, []);

  React.useEffect(() => { reload(); }, [reload]);

  const submit = async () => {
    setSaving(true); setSaveErr(null);
    try {
      const patch: Record<string, any> = {};
      patch.docai_provider_order = form.docai_provider_order;
      // Convert "" / 0 / negative to absent; only forward positive ints.
      const limits: Record<string, number> = {};
      for (const [k, v] of Object.entries(form.docai_daily_limits)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) limits[k] = Math.floor(n);
      }
      patch.docai_daily_limits = Object.keys(limits).length ? limits : null;
      if (form.docai_anthropic_model) patch.docai_anthropic_model = form.docai_anthropic_model;
      else patch.docai_anthropic_model = null;
      if (form.docai_gemini_model) patch.docai_gemini_model = form.docai_gemini_model;
      else patch.docai_gemini_model = null;
      // Bet 1 fields. Send through unconditionally; backend
      // tolerates the same values being re-sent.
      const fc = Number(form.docai_fallback_confidence);
      if (Number.isFinite(fc) && fc >= 0.5 && fc <= 0.99) {
        patch.docai_fallback_confidence = Math.round(fc * 100) / 100;
      }
      patch.docai_mistral_ocr_batch = !!form.docai_mistral_ocr_batch;
      if (["low", "medium", "high", "ultra_high"].includes(form.docai_gemini_media_resolution)) {
        patch.docai_gemini_media_resolution = form.docai_gemini_media_resolution;
      }
      await (AnvilBackend as any)?.docai?.updateSettings?.(patch);
      setEditing(false);
      await reload();
    } catch (e: any) {
      setSaveErr(String(e?.message || e));
    } finally { setSaving(false); }
  };

  if (loading) return <Card><div className="body">Loading docai cost status…</div></Card>;
  if (error) return (
    <Banner kind="bad" icon={Icon.alert} title="DocAI cost status unreachable" action={<Btn sm onClick={reload}>Retry</Btn>}>
      <span className="mono-sm">{String((error as any)?.message || error)}</span>
    </Banner>
  );
  if (!data) return <Card><div className="body">No data.</div></Card>;

  const sevTone = (s: string): "good" | "warn" | "bad" | "info" =>
    s === "bad" ? "bad" : s === "warn" ? "warn" : "info";

  const moveOrder = (idx: number, dir: -1 | 1) => {
    const next = [...form.docai_provider_order];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setForm({ ...form, docai_provider_order: next });
  };
  const toggleAdapter = (name: string) => {
    const cur = form.docai_provider_order;
    if (cur.includes(name)) {
      setForm({ ...form, docai_provider_order: cur.filter((a) => a !== name) });
    } else {
      setForm({ ...form, docai_provider_order: [...cur, name] });
    }
  };
  // Engine selector: make `name` the PRIMARY extraction engine (first in the
  // order), keeping the rest as fallbacks. Adds it if it wasn't in the order.
  const setPrimaryAdapter = (name: string) => {
    if (!name) return;
    const rest = form.docai_provider_order.filter((a) => a !== name);
    setForm({ ...form, docai_provider_order: [name, ...rest] });
  };
  // A configured engine has a platform key (env) or a tenant key.
  const adapterConfigured = (name: string): boolean =>
    !!(data.adapter_health?.[name] || (data as any).tenant_has_key?.[name]);

  return (
    <>
      {/* Top-line cost summary */}
      <Card title="Today's docai usage" eyebrow={"date " + data.date}>
        <KV rows={[
          ["Total calls",        String(data.summary.calls_today)],
          ["Estimated cost",     "$" + data.summary.cost_today_usd.toFixed(4)],
          ["Free-friendly calls", String(data.summary.free_friendly_calls_today)],
          ["Paid calls",         String(data.summary.paid_calls_today)],
          ["Warnings",           String(data.summary.warnings)],
        ]} />
      </Card>

      {/* Recommendations */}
      {data.recommendations.length > 0 && (
        <Card title="Recommendations" eyebrow={"actionable cost-saving steps (" + data.recommendations.length + ")"}>
          <div style={{ display: "grid", gap: 10 }}>
            {data.recommendations.map((r) => (
              <Banner key={r.id} kind={sevTone(r.severity)} icon={Icon.info} title={r.title}>
                <span className="mono-sm">{r.body}</span>
              </Banner>
            ))}
          </div>
        </Card>
      )}

      {/* Today's per-adapter table */}
      <Card flush>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
          <span className="h2">Per-adapter usage today</span>
        </div>
        {data.today_usage.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No extractions today.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Adapter</th>
              <th className="r">Calls</th>
              <th className="r">Cap</th>
              <th className="r">Remaining</th>
              <th className="r">$ today</th>
              <th>Last called</th>
            </tr></thead>
            <tbody>
              {data.today_usage.map((row) => {
                const cap = data.daily_limits?.[row.adapter];
                const remaining = (cap != null) ? Math.max(0, cap - row.call_count) : null;
                return (
                  <tr key={row.adapter}>
                    <td className="mono">{row.adapter}</td>
                    <td className="r mono">{row.call_count}</td>
                    <td className="r mono">{cap != null ? cap : "—"}</td>
                    <td className="r mono">{remaining != null ? remaining : "—"}</td>
                    <td className="r mono">${Number(row.estimated_cost_usd || 0).toFixed(4)}</td>
                    <td className="mono-sm">
                      {row.last_called_at
                        ? new Date(row.last_called_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Adapter health */}
      <Card title="Adapter health" eyebrow="env vars + per-tenant keys">
        <table className="tbl">
          <thead><tr><th>Adapter</th><th>Env</th><th>Tenant key</th></tr></thead>
          <tbody>
            {DOCAI_ADAPTERS_LIST.map((a) => (
              <tr key={a}>
                <td className="mono">{a}</td>
                <td><Chip k={data.adapter_health[a] ? "good" : "bad"}>{data.adapter_health[a] ? "yes" : "no"}</Chip></td>
                <td><Chip k={data.tenant_has_key[a] ? "good" : "bad"}>{data.tenant_has_key[a] ? "yes" : "no"}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Configuration editor */}
      <Card
        title="Cost levers"
        eyebrow="adapter chain · daily limits · model selectors"
        right={
          <>
            {!editing && <Btn sm onClick={() => setEditing(true)}>Edit</Btn>}
            {editing && (
              <>
                <Btn sm kind="ghost" onClick={() => { setEditing(false); reload(); }}>Cancel</Btn>
                <Btn sm kind="primary" disabled={saving} onClick={submit}>{saving ? "Saving…" : "Save"}</Btn>
              </>
            )}
          </>
        }
      >
        {!editing && (
          <KV rows={[
            ["Provider order",   data.provider_order.join(" -> ") + (data.provider_order_default ? " (default)" : "")],
            ["Daily limits",     data.daily_limits
              ? Object.entries(data.daily_limits).map(([k, v]) => k + ":" + v).join(", ")
              : "(none — uncapped)"],
            ["Anthropic model",  data.anthropic_model],
          ]} />
        )}
        {editing && (
          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>Extraction engine (primary)</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  className="input"
                  style={{ minWidth: 180 }}
                  value={form.docai_provider_order[0] || ""}
                  onChange={(e) => setPrimaryAdapter(e.target.value)}
                >
                  {!form.docai_provider_order[0] && <option value="">select engine…</option>}
                  {DOCAI_ADAPTERS_LIST.map((a) => (
                    <option key={a} value={a}>
                      {a}{adapterConfigured(a) ? "" : " (no key)"}
                    </option>
                  ))}
                </select>
                {form.docai_provider_order[0] && (
                  <Chip k={adapterConfigured(form.docai_provider_order[0]) ? "good" : "bad"}>
                    {adapterConfigured(form.docai_provider_order[0]) ? "configured" : "no key — will be skipped"}
                  </Chip>
                )}
              </div>
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>
                The chosen engine runs first; the rest below are fallbacks. Pick one that shows “configured”.
              </div>
            </div>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>Provider order (drag-equivalent: move up/down or toggle)</div>
              <div style={{ display: "grid", gap: 6 }}>
                {form.docai_provider_order.map((a, i) => (
                  <div key={a} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className="mono-sm" style={{ width: 24, color: "var(--ink-3)" }}>{i + 1}</span>
                    <span className="mono" style={{ flex: 1 }}>{a}</span>
                    <Btn sm kind="ghost" disabled={i === 0} onClick={() => moveOrder(i, -1)}>Up</Btn>
                    <Btn sm kind="ghost" disabled={i === form.docai_provider_order.length - 1} onClick={() => moveOrder(i, 1)}>Down</Btn>
                    <Btn sm kind="ghost" onClick={() => toggleAdapter(a)}>Remove</Btn>
                  </div>
                ))}
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>Add:</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {DOCAI_ADAPTERS_LIST.filter((a) => !form.docai_provider_order.includes(a)).map((a) => (
                    <Btn key={a} sm kind="ghost" onClick={() => toggleAdapter(a)}>+ {a}</Btn>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>Daily caps per adapter (blank or 0 = uncapped)</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", columnGap: 10, rowGap: 6, alignItems: "center" }}>
                {DOCAI_ADAPTERS_LIST.map((a) => (
                  <React.Fragment key={a}>
                    <span className="mono">{a}</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={form.docai_daily_limits[a] ?? ""}
                      onChange={(ev) => setForm({
                        ...form,
                        docai_daily_limits: {
                          ...form.docai_daily_limits,
                          [a]: ev.target.value === "" ? "" : Number(ev.target.value),
                        },
                      })}
                    />
                  </React.Fragment>
                ))}
              </div>
            </div>

            <label className="lbl">Anthropic model (blank = ANTHROPIC_MODEL_DEFAULT env or Sonnet 4.6)
              <input
                type="text"
                value={form.docai_anthropic_model}
                placeholder="claude-sonnet-4-6"
                onChange={(ev) => setForm({ ...form, docai_anthropic_model: ev.target.value })}
              />
            </label>

            <label className="lbl">Gemini model (blank = GEMINI_MODEL_DEFAULT env or gemini-3-flash-preview)
              <input
                type="text"
                value={form.docai_gemini_model}
                placeholder="gemini-3-flash-preview"
                onChange={(ev) => setForm({ ...form, docai_gemini_model: ev.target.value })}
              />
            </label>

            {/* Bet 1 (May 2026): Sonnet fallback threshold +
                Mistral OCR batch flag + Gemini media_resolution. */}
            <label className="lbl">Confidence fallback threshold ({Number(form.docai_fallback_confidence).toFixed(2)})
              <input
                type="range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={form.docai_fallback_confidence}
                onChange={(ev) => setForm({ ...form, docai_fallback_confidence: Number(ev.target.value) })}
              />
              <div className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 11 }}>
                Below this confidence, Gemini 3 Flash extractions fall through to Sonnet 4.6 for a second pass. Default 0.85.
              </div>
            </label>

            <label className="lbl">Mistral OCR endpoint
              <select
                value={form.docai_mistral_ocr_batch ? "batch" : "realtime"}
                onChange={(ev) => setForm({ ...form, docai_mistral_ocr_batch: ev.target.value === "batch" })}
              >
                <option value="batch">Batch (50% cheaper, slight latency)</option>
                <option value="realtime">Realtime (lower latency, full price)</option>
              </select>
            </label>

            <label className="lbl">Gemini media resolution
              <select
                value={form.docai_gemini_media_resolution}
                onChange={(ev) => setForm({ ...form, docai_gemini_media_resolution: ev.target.value })}
              >
                <option value="low">Low (~280 tokens/image; cheapest, fine-text legibility lost)</option>
                <option value="medium">Medium (~560 tokens/image)</option>
                <option value="high">High (~1120 tokens/image; default, dense PO PDFs)</option>
                <option value="ultra_high">Ultra-high (most tokens; only when high fails)</option>
              </select>
            </label>

            {saveErr && (
              <Banner kind="bad" icon={Icon.alert} title="Could not save">
                <span className="mono-sm">{saveErr}</span>
              </Banner>
            )}
          </div>
        )}
      </Card>

      {/* Per-day per-adapter trend chart. Draws an inline-SVG
          stacked-area chart over the configurable window. Three
          metrics: calls, cost, plus a CSV export. Cap line is
          the max per-adapter daily limit so the operator can
          see how today is tracking against budget. */}
      {data.trend_series && data.trend_series.dates.length > 0 && (
        <Card
          title={"Usage trend"}
          eyebrow={(data.window_days || 7) + "-day per-adapter stacked"}
          right={
            <>
              <Btn sm kind={chartMetric === "calls" ? "primary" : "ghost"} onClick={() => setChartMetric("calls")}>Calls</Btn>
              <Btn sm kind={chartMetric === "cost" ? "primary" : "ghost"} onClick={() => setChartMetric("cost")}>Cost</Btn>
              <Btn sm kind="ghost" onClick={() => {
                if (!data.trend_series) return;
                downloadCsv(
                  "docai-usage-" + chartMetric + "-" + data.date + ".csv",
                  buildTrendCsv(data.trend_series, chartMetric),
                );
              }}>CSV</Btn>
            </>
          }
        >
          <CostTrendChart
            series={data.trend_series}
            metric={chartMetric}
            capLine={chartMetric === "calls" && data.daily_limits
              ? Math.max(0, ...Object.values(data.daily_limits).map(Number).filter(Number.isFinite))
              : null}
          />
        </Card>
      )}

      {/* Per-adapter burn + forecast. Tells the operator at a
          glance which adapter is on track to hit its cap today. */}
      {(data.burn || data.forecast) && (
        <Card title="Burn + forecast" eyebrow="today vs window-median, cap projection">
          <table className="tbl">
            <thead><tr>
              <th>Adapter</th>
              <th className="r">Today calls</th>
              <th className="r">Window median</th>
              <th className="r">Ratio</th>
              <th className="r">Cap</th>
              <th className="r">Remaining</th>
              <th className="r">Hours to cap</th>
              <th>At risk today</th>
            </tr></thead>
            <tbody>
              {Object.keys({ ...(data.burn || {}), ...(data.forecast || {}) }).sort().map((adapter) => {
                const b = data.burn?.[adapter];
                const f = data.forecast?.[adapter];
                return (
                  <tr key={adapter}>
                    <td className="mono">{adapter}</td>
                    <td className="r mono">{b?.today_calls ?? "—"}</td>
                    <td className="r mono">{b?.median_n_calls ?? "—"}</td>
                    <td className="r mono">{b?.ratio == null ? "—" : (b.ratio.toFixed(2) + "x")}</td>
                    <td className="r mono">{f?.cap ?? "—"}</td>
                    <td className="r mono">{f?.remaining ?? "—"}</td>
                    <td className="r mono">{f?.hours_to_cap == null ? "—" : f.hours_to_cap.toFixed(1)}</td>
                    <td>
                      <Chip k={f?.will_hit_cap_today ? "bad" : "good"}>
                        {f?.will_hit_cap_today ? "yes" : "no"}
                      </Chip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* Anomaly highlights: any day in the window where calls
          spiked >= 2x that adapter's window median. */}
      {data.anomalies && data.anomalies.length > 0 && (
        <Card title="Anomalies" eyebrow={data.anomalies.length + " day(s) >=2x median"}>
          <table className="tbl">
            <thead><tr>
              <th>Date</th>
              <th>Adapter</th>
              <th className="r">Calls</th>
              <th className="r">Median</th>
              <th className="r">Multiplier</th>
            </tr></thead>
            <tbody>
              {data.anomalies.map((a, i) => (
                <tr key={a.date + a.adapter + i}>
                  <td className="mono-sm">{a.date}</td>
                  <td className="mono-sm">{a.adapter}</td>
                  <td className="r mono">{a.calls}</td>
                  <td className="r mono">{a.median}</td>
                  <td className="r mono">{a.multiplier.toFixed(2)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* 7-day rollup totals (kept for back-compat + at-a-glance) */}
      <Card title={(data.window_days || 7) + "-day rollup"} eyebrow="cumulative across all adapters">
        <KV rows={[
          ["Calls", String(data.trend_window?.calls ?? data.trend_7d.calls)],
          ["Estimated cost", "$" + Number(data.trend_window?.cost ?? data.trend_7d.cost).toFixed(4)],
        ]} />
      </Card>
    </>
  );
};
