import React, { useEffect, useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// Rule library mirror of `src/api/anomaly/compute.js`. Kept in sync with
// the server-side RULES array; the screen renders this when the user
// clicks the "Rules" tab so they can see what the engine evaluates on
// every order. Grouping matches the design's 5 buckets + hygiene.
const RULE_CATALOG: Array<{ id: string; label: string; bucket: string; severity: string }> = [
  { id: "grand_total",                   label: "Order value outlier",                  bucket: "Hygiene", severity: "high" },
  { id: "line_count",                    label: "Line count outlier",                   bucket: "Hygiene", severity: "med" },
  { id: "duplicate_line",                label: "Duplicate line",                        bucket: "Hygiene", severity: "med" },
  { id: "qty_step_skip",                 label: "Qty doesn't match pack size",          bucket: "Hygiene", severity: "low" },
  { id: "lead_time_spike",               label: "Lead time tighter than typical",       bucket: "Hygiene", severity: "med" },
  { id: "line_rate",                     label: "Line rate outlier",                    bucket: "Rate",    severity: "high" },
  { id: "rate_10x_jump",                 label: "Rate decimal-shift",                   bucket: "Rate",    severity: "high" },
  { id: "cross_customer_rate_drift",     label: "Rate drifts from tenant band",         bucket: "Rate",    severity: "med" },
  { id: "rate_below_landed_cost",        label: "Rate below landed cost",               bucket: "Rate",    severity: "high" },
  { id: "round_number_rate",             label: "Suspiciously round rate",              bucket: "Rate",    severity: "low" },
  { id: "margin_floor_breach",           label: "Margin below 8% floor",                bucket: "Margin",  severity: "high" },
  { id: "margin_drop_vs_baseline",       label: "Margin drop vs customer baseline",     bucket: "Margin",  severity: "med" },
  { id: "freight_share_outlier",         label: "Freight share outlier",                bucket: "Margin",  severity: "low" },
  { id: "gst_class_mismatch",            label: "GST class vs state mismatch",          bucket: "GST",     severity: "med" },
  { id: "gst_rate_inconsistent_for_hsn", label: "Inconsistent GST rate for HSN",        bucket: "GST",     severity: "med" },
  { id: "missing_hsn_or_gst",            label: "Missing HSN or GST",                   bucket: "GST",     severity: "low" },
  { id: "payment_terms_drift",           label: "Payment terms drift",                  bucket: "Credit",  severity: "med" },
  { id: "credit_overrun",                label: "Credit limit overrun",                 bucket: "Credit",  severity: "high" },
  { id: "alias_low_confidence",          label: "Alias low confidence",                 bucket: "Alias",   severity: "med" },
  { id: "ambiguous_alias",               label: "Ambiguous alias",                      bucket: "Alias",   severity: "med" },
];

// ============================================================
// ANVIL v3 — wired Findings (anomaly · quality)
// Wave E · 3 status tabs · resolve action
// ============================================================

const findingFetch = async () => {
  const cfg = (ObaraBackend?.getConfig?.() || {});
  const session = (ObaraBackend?.getSession?.() || null);
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + "/api/findings";
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const findingRowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.findings)) return resp.findings;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const SEV_CHIP = (s) => {
  const k = s === "high" ? "bad" : s === "med" ? "warn" : "ghost";
  return <Chip k={k}>{s || "low"}</Chip>;
};

const WiredAnomaly = () => {
  const list = useFetch(findingFetch, []);
  const [tab, setTab] = useState("open");
  const [resolving, setResolving] = useState(null);
  const [resolveError, setResolveError] = useState(null);
  // Audit P9.4: per-finding Haiku explanations. Keyed by finding
  // id; each entry is { loading?, explanation?, error? }. Once
  // populated the row's Explain expansion stays visible until
  // closed.
  const [explanations, setExplanations] = useState<Record<string, { loading?: boolean; explanation?: string; recommendation?: string; error?: string }>>({});

  const resolveOne = async (id) => {
    setResolving(id);
    setResolveError(null);
    try {
      await ObaraBackend?.findings?.resolve?.(id, true);
      list.reload();
    } catch (err) {
      setResolveError(err);
    } finally {
      setResolving(null);
    }
  };

  const explainOne = async (id: string) => {
    setExplanations((s) => ({ ...s, [id]: { loading: true } }));
    try {
      const r: any = await ObaraBackend?.anomaly?.explain?.(id);
      const out = r?.explanation || r?.data || r;
      setExplanations((s) => ({
        ...s,
        [id]: {
          explanation: out?.explanation || out?.text || "(no explanation returned)",
          recommendation: out?.recommendation || null,
        },
      }));
    } catch (err: any) {
      setExplanations((s) => ({ ...s, [id]: { error: String(err?.message || err) } }));
    }
  };
  const closeExplanation = (id: string) => setExplanations((s) => {
    const out = { ...s };
    delete out[id];
    return out;
  });

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Findings" title="Findings" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading findings…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Findings" title="Findings" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load findings"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const all = findingRowsOf(list.data);
  // Audit P13.B.2.2: severity distribution panel. Counts every
  // finding by severity, drawn as horizontal bars. Live data from
  // the same /api/findings response, no fabrication. The panel
  // sits on the Open tab (where the operator triages the queue).
  const sevCounts = (() => {
    const buckets: Record<string, number> = { high: 0, med: 0, low: 0, other: 0 };
    for (const r of all) {
      const k = String(r.severity || r.sev || "low").toLowerCase();
      if (k === "high" || k === "med" || k === "low") buckets[k] += 1;
      else buckets.other += 1;
    }
    const max = Math.max(buckets.high, buckets.med, buckets.low, buckets.other, 1);
    return { buckets, max, total: all.length };
  })();
  const matchTab = (r) => {
    const status = (r.status || (r.resolved ? "resolved" : r.suppressed ? "suppressed" : "open")).toLowerCase();
    if (tab === "open")       return status !== "resolved" && status !== "suppressed";
    if (tab === "resolved")   return status === "resolved" || r.resolved === true;
    if (tab === "suppressed") return status === "suppressed" || r.suppressed === true;
    return true;
  };
  const filtered = all.filter(matchTab);

  const tabs = [
    { id: "open",       label: "Open",       count: all.filter((r) => !(r.resolved || r.suppressed) && (r.status || "open").toLowerCase() === "open").length },
    { id: "resolved",   label: "Resolved",   count: all.filter((r) => r.resolved === true || (r.status || "").toLowerCase() === "resolved").length },
    { id: "suppressed", label: "Suppressed", count: all.filter((r) => r.suppressed === true || (r.status || "").toLowerCase() === "suppressed").length },
    { id: "rules",      label: "Rules",      count: RULE_CATALOG.length },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Quality · Findings"
        title="Findings"
        meta={`${all.length} total · ${tabs[0].count} open`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {resolveError && (
          <Banner kind="bad" icon={Icon.alert} title="Resolve failed">
            <span className="mono-sm">{String(resolveError.message || resolveError)}</span>
          </Banner>
        )}

        {tab === "rules" ? (
          <>
            <KPIRow cols={5}>
              <KPI lbl="Rate" v={String(RULE_CATALOG.filter((r) => r.bucket === "Rate").length)} />
              <KPI lbl="Margin" v={String(RULE_CATALOG.filter((r) => r.bucket === "Margin").length)} />
              <KPI lbl="GST" v={String(RULE_CATALOG.filter((r) => r.bucket === "GST").length)} />
              <KPI lbl="Credit" v={String(RULE_CATALOG.filter((r) => r.bucket === "Credit").length)} />
              <KPI lbl="Alias / Hygiene" v={String(RULE_CATALOG.filter((r) => r.bucket === "Alias" || r.bucket === "Hygiene").length)} />
            </KPIRow>
            {/* Model calibration strip from the design package's
                "model card." Strict precision/recall would need a
                labelled ground-truth set we do not have today, so
                we surface operator-confirmed rate (resolved /
                (resolved + suppressed)) as the closest honest
                proxy. Suppression rate proxies false-positive
                rate; the target = 5% bound is the same one the
                landing's product pillar quotes. */}
            {(() => {
              const resolved = all.filter((r) => r.resolved === true || (r.status || "").toLowerCase() === "resolved").length;
              const suppressed = all.filter((r) => r.suppressed === true || (r.status || "").toLowerCase() === "suppressed").length;
              const actioned = resolved + suppressed;
              const opPrecision = actioned > 0 ? Math.round((resolved / actioned) * 100) : null;
              const supRate = all.length > 0 ? Math.round((suppressed / all.length) * 100) : null;
              return (
                <KPIRow cols={3}>
                  <KPI
                    lbl="Operator-confirmed"
                    v={opPrecision == null ? "—" : opPrecision + "%"}
                    d={opPrecision == null ? "no operator actions yet" : `${resolved} resolved of ${actioned} actioned`}
                    dKind={opPrecision == null ? "" : (opPrecision >= 90 ? "up" : opPrecision < 70 ? "down" : "")}
                  />
                  <KPI
                    lbl="Suppression rate"
                    v={supRate == null ? "—" : supRate + "%"}
                    d={supRate == null ? "no findings yet" : `target ≤ 5% · ${suppressed} suppressed of ${all.length}`}
                    dKind={supRate == null ? "" : (supRate > 5 ? "down" : "up")}
                  />
                  <KPI lbl="Findings (lifetime)" v={String(all.length)} d={`${resolved} resolved · ${suppressed} suppressed`} />
                </KPIRow>
              );
            })()}
            {/* Rule-frequency histogram. The design package's
                screens-quality.jsx showed a continuous-score
                histogram next to the rule library. validation_findings
                has no `score` column today (a literal score
                histogram would need a schema migration), so we
                surface the closest honest analog: per-rule firing
                rate. Same chart shape, same operator question
                answered ("where is the engine spending its
                attention"). Caps at the 10 most-fired rules so
                the strip stays scannable on a wide spread. */}
            {(() => {
              const byRule = new Map<string, number>();
              for (const r of all) {
                const id = String(r.rule_id || r.code || r.rule || "unknown");
                byRule.set(id, (byRule.get(id) || 0) + 1);
              }
              const ranked = Array.from(byRule.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
              if (!ranked.length) return null;
              const max = ranked[0][1];
              return (
                <Card title="Rule frequency" eyebrow={`top ${ranked.length} of ${byRule.size} active rules · lifetime`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {ranked.map(([rid, n]) => {
                      const pct = max > 0 ? Math.round((n / max) * 100) : 0;
                      const cat = RULE_CATALOG.find((rc) => rc.id === rid);
                      const tone = cat?.severity === "high" ? "var(--rust)"
                        : cat?.severity === "med" ? "var(--amber)"
                        : cat?.severity === "low" ? "var(--sage)"
                        : "var(--ink-4)";
                      return (
                        <div key={rid} style={{ display: "grid", gridTemplateColumns: "160px 1fr 60px", alignItems: "center", gap: 10 }}>
                          <span className="mono-sm" title={cat?.label || rid} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {rid}
                          </span>
                          <div style={{ height: 12, background: "var(--paper-3)", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ width: pct + "%", height: "100%", background: tone }} />
                          </div>
                          <span className="mono-sm r" style={{ textAlign: "right" }}>{n}</span>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })()}
            <Card title="Rule library" eyebrow={RULE_CATALOG.length + " rules · 5 buckets"} flush>
              <table className="tbl">
                <thead><tr>
                  <th>ID</th>
                  <th>Label</th>
                  <th>Bucket</th>
                  <th>Default severity</th>
                </tr></thead>
                <tbody>
                  {RULE_CATALOG.map((r) => (
                    <tr key={r.id}>
                      <td className="mono-sm"><span className="pri">{r.id}</span></td>
                      <td>{r.label}</td>
                      <td><Chip k="info">{r.bucket}</Chip></td>
                      <td>{SEV_CHIP(r.severity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        ) : null}
        {tab === "open" && all.length > 0 && (
          <Card title="Severity distribution" eyebrow={`${sevCounts.total} finding${sevCounts.total === 1 ? "" : "s"}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(["high", "med", "low", "other"] as const).map((k) => {
                const n = sevCounts.buckets[k];
                const pct = sevCounts.max > 0 ? Math.round((n / sevCounts.max) * 100) : 0;
                const tone = k === "high" ? "var(--rust)" : k === "med" ? "var(--amber)" : k === "low" ? "var(--sage)" : "var(--ink-4)";
                return (
                  <div key={k} style={{ display: "grid", gridTemplateColumns: "60px 1fr 50px", alignItems: "center", gap: 10 }}>
                    <span className="mono-sm" style={{ textTransform: "uppercase", color: "var(--ink-3)" }}>{k}</span>
                    <div style={{ height: 14, background: "var(--paper-3)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: pct + "%", height: "100%", background: tone }} />
                    </div>
                    <span className="mono-sm r" style={{ textAlign: "right" }}>{n}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
        {tab !== "rules" && <Card flush>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {tab === "open" ? "All clear · no open findings." : `No ${tab} findings.`}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Order ref</th>
                <th>Field</th>
                <th>Severity</th>
                <th>Suggested fix</th>
                <th>Status</th>
                <th className="r">Age</th>
                <th style={{ width: 110 }}></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const status = (r.status || (r.resolved ? "resolved" : r.suppressed ? "suppressed" : "open")).toLowerCase();
                  const sev = (r.severity || r.sev || "low").toLowerCase();
                  const orderRef = r.order_ref || r.po_number || r.quote_number || (r.order_id ? r.order_id.slice(0, 8) : "—");
                  const created = r.created_at || r.detected_at;
                  const exp = explanations[r.id];
                  return (
                    <React.Fragment key={r.id}>
                      <tr>
                        <td className="mono"><span className="pri">{orderRef}</span></td>
                        <td className="mono-sm">{r.field || r.field_name || "—"}</td>
                        <td>{SEV_CHIP(sev)}</td>
                        <td>{r.suggested_fix || r.suggestion || "—"}</td>
                        <td><Chip k={status === "open" ? "warn" : status === "resolved" ? "good" : "ghost"}>{status}</Chip></td>
                        <td className="r mono">{created ? ageLabel(created) : "—"}</td>
                        <td style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <Btn
                            sm
                            kind="ghost"
                            disabled={!!exp?.loading}
                            onClick={() => exp ? closeExplanation(r.id) : explainOne(r.id)}
                            title="Ask Haiku to explain why this finding fired"
                          >
                            {exp?.loading ? "explaining..." : exp ? "hide" : "explain"}
                          </Btn>
                          {tab === "open" && (
                            <Btn
                              sm
                              disabled={resolving === r.id}
                              onClick={() => resolveOne(r.id)}
                            >
                              {resolving === r.id ? "resolving…" : "resolve"}
                            </Btn>
                          )}
                        </td>
                      </tr>
                      {exp && !exp.loading && (
                        <tr key={r.id + ":exp"}>
                          <td colSpan={7} style={{ background: "var(--surface-2, #f7f7f7)", padding: 12 }}>
                            {exp.error ? (
                              <span className="mono-sm" style={{ color: "var(--bad, #a00)" }}>Explainer failed: {exp.error}</span>
                            ) : (
                              <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                <div><strong>Why:</strong> {exp.explanation}</div>
                                {exp.recommendation && <div><strong>Suggested action:</strong> {exp.recommendation}</div>}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>}
      </div>
    </>
  );
};


export default WiredAnomaly;
