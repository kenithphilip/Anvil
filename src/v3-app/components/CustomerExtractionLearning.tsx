import React, { useEffect, useState } from "react";
import { Banner, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// "What Anvil has learned about this customer's POs" — a read-only panel on the
// customer master. Opening Hyundai Motors India shows the last PO Anvil
// extracted with each line's extracted codes mapped against what it resolved
// in the item master, plus the accumulated customer-code → our-part map and the
// recent extraction runs. Everything is composed from existing per-customer
// endpoints (docai runs, orders, item_customer_parts) — no new backend.

const authFetch = async (path: string) => {
  const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
  const session: any = (AnvilBackend as any)?.getSession?.() || null;
  const headers: any = { "Content-Type": "application/json" };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
  const base = String(cfg.url || "").replace(/\/+$/, "");
  const r = await fetch(base + path, { headers });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
};

const val = (o: any, ...ks: string[]) => { for (const k of ks) { const v = o?.[k]; if (v != null && String(v).trim() !== "") return String(v); } return null; };

type State = { loading: boolean; error: string | null; runs: any[]; lastOrder: any | null; mappings: any[] };

export const CustomerExtractionLearning: React.FC<{ customerId: string }> = ({ customerId }) => {
  const [s, setS] = useState<State>({ loading: true, error: null, runs: [], lastOrder: null, mappings: [] });

  useEffect(() => {
    let cancelled = false;
    setS({ loading: true, error: null, runs: [], lastOrder: null, mappings: [] });
    (async () => {
      const cid = encodeURIComponent(customerId);
      const [runsR, ordersR, mapR] = await Promise.all([
        authFetch(`/api/docai/runs?customer_id=${cid}&limit=8`).catch(() => null),
        authFetch(`/api/orders?customer=${cid}`).catch(() => null),
        authFetch(`/api/admin/item_customer_parts?customer_id=${cid}`).catch(() => null),
      ]);
      if (cancelled) return;
      const runs = (runsR?.runs || runsR?.rows || (Array.isArray(runsR) ? runsR : [])) as any[];
      const orders = (ordersR?.orders || ordersR?.rows || (Array.isArray(ordersR) ? ordersR : [])) as any[];
      const mappings = (mapR?.parts || mapR?.rows || mapR?.mappings || (Array.isArray(mapR) ? mapR : [])) as any[];
      // Newest order that actually carries extracted line items.
      const lastOrder = orders.find((o) => (o?.result?.salesOrder?.lineItems || []).length) || orders[0] || null;
      setS({ loading: false, error: null, runs, lastOrder, mappings });
    })().catch((e) => { if (!cancelled) setS((p) => ({ ...p, loading: false, error: e?.message || String(e) })); });
    return () => { cancelled = true; };
  }, [customerId]);

  const lastRun = s.runs[0];
  const lines: any[] = s.lastOrder?.result?.salesOrder?.lineItems || [];
  const okRuns = s.runs.filter((r) => r?.status === "ok").length;

  const fmtDate = (d: any) => { try { return d ? new Date(d).toISOString().slice(0, 10) : "—"; } catch { return "—"; } };

  return (
    <div>
      <div className="row gap-md" style={{ alignItems: "baseline", marginBottom: 8, flexWrap: "wrap" }}>
        <span className="h-eyebrow">Extraction learning</span>
        <span className="mono-sm" style={{ color: "var(--ink-3)" }}>what Anvil has learned from this customer&rsquo;s POs</span>
      </div>

      {s.loading ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 8 }}>Loading extraction history…</div>
      ) : s.error ? (
        <Banner kind="bad" title="Could not load extraction learning"><span className="mono-sm">{s.error}</span></Banner>
      ) : (
        <>
          {/* Summary chips */}
          <div className="row gap-sm" style={{ flexWrap: "wrap", marginBottom: 12 }}>
            <Chip k="info">{s.runs.length} extraction run{s.runs.length === 1 ? "" : "s"}</Chip>
            {s.runs.length > 0 && <Chip k={okRuns === s.runs.length ? "good" : "warn"}>{okRuns}/{s.runs.length} ok</Chip>}
            {lastRun && (
              <Chip k={lastRun.status === "ok" ? "good" : lastRun.status === "low_confidence" ? "warn" : "bad"}>
                last: {lastRun.status || "?"}{lastRun.confidence_overall != null ? ` · ${Math.round(Number(lastRun.confidence_overall) * 100)}%` : ""}
                {lastRun.adapter_used ? ` · ${lastRun.adapter_used}` : ""}
              </Chip>
            )}
            <Chip k={s.mappings.length ? "good" : "ghost"}>{s.mappings.length} learned part mapping{s.mappings.length === 1 ? "" : "s"}</Chip>
          </div>

          {/* Last PO extracted: extracted codes ↔ mapped canonical, per line */}
          {s.lastOrder && lines.length > 0 ? (
            <div style={{ marginBottom: 14 }}>
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>
                Last PO extracted: <b style={{ color: "var(--ink)" }}>{val(s.lastOrder, "po_number") || (s.lastOrder.id || "").slice(0, 8)}</b>
                {" · "}{fmtDate(s.lastOrder.created_at)}{" · "}{lines.length} line{lines.length === 1 ? "" : "s"}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ fontSize: 12 }}>
                  <thead><tr><th>#</th><th>Extracted (our part / buyer SAP)</th><th>Description</th><th>Mapped → item master</th></tr></thead>
                  <tbody>
                    {lines.slice(0, 12).map((ln, i) => {
                      const mi = ln?._mapped_item;
                      const part = val(ln, "partNumber", "part_no", "itemCode");
                      const sap = val(ln, "customerItemCode", "customer_item_code");
                      const desc = val(ln, "raw_description", "description");
                      return (
                        <tr key={i}>
                          <td className="mono-sm" style={{ color: "var(--ink-4)" }}>{i + 1}</td>
                          <td className="mono-sm">
                            {part || "—"}
                            {sap && <div><Chip k="ghost">SAP {sap}</Chip></div>}
                          </td>
                          <td className="mono-sm" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{desc || "—"}</td>
                          <td className="mono-sm">
                            {mi
                              ? <span><Chip k="info">{mi.match_via || "mapped"}</Chip> {mi.part_no || ""}</span>
                              : <span style={{ color: "var(--ink-4)" }}>unmapped</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {lines.length > 12 && <div className="mono-sm" style={{ color: "var(--ink-4)", marginTop: 4 }}>+{lines.length - 12} more lines</div>}
            </div>
          ) : (
            <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 12 }}>No extracted PO on file for this customer yet.</div>
          )}

          {/* Learned customer-code → our-part map */}
          {s.mappings.length > 0 && (
            <div>
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>Learned code map (customer code → our part)</div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ fontSize: 12 }}>
                  <thead><tr><th>Customer code</th><th>Our part / item</th><th>Source</th></tr></thead>
                  <tbody>
                    {s.mappings.slice(0, 10).map((m, i) => (
                      <tr key={i}>
                        <td className="mono-sm">{val(m, "customer_item_code", "customer_part_number") || "—"}</td>
                        <td className="mono-sm">{val(m, "part_no", "canonical_part_no") || val(m, "item_id")?.slice(0, 8) || "—"}</td>
                        <td className="mono-sm" style={{ color: "var(--ink-4)" }}>{val(m, "created_via", "source") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {s.mappings.length > 10 && <div className="mono-sm" style={{ color: "var(--ink-4)", marginTop: 4 }}>+{s.mappings.length - 10} more mappings</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CustomerExtractionLearning;
