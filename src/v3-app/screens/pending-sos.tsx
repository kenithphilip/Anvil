import React from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Pending Sales Orders (per-customer supply-chain tracker)
// One row per OPEN sales-order line, showing where each line stands:
// the internal work order (local -I parts) or import PO + in-transit
// ladder, its ready date, and the delivery date promised to the
// customer. Data: GET /api/sales/pending_sales_orders?customer_id=.
// ============================================================

const readParams = () => new URLSearchParams((window.location.hash || "").split("?")[1] || "");

const ORIGIN_CHIP: Record<string, { k: string; label: string }> = {
  local: { k: "info", label: "Local (WO)" },
  import: { k: "plum", label: "Import" },
  unknown: { k: "ghost", label: "—" },
};

const fmtQty = (v: any) => (v == null ? "—" : String(v));
const fmtDate = (v: any) => (v ? String(v).slice(0, 10) : "—");
const fmtMoney = (v: any) => (v == null ? "—" : "₹" + Number(v).toLocaleString("en-IN"));

// The furthest-along in-transit hop we have a date for (import lines only).
const transitCell = (r: any) => {
  if (r.origin !== "import") {
    return r.ready_date ? "WO ready " + fmtDate(r.ready_date) : "work order";
  }
  const hops: Array<[string, any]> = [
    ["Store", r.warehouse_receipt_date],
    ["India", r.port_arrival_date],
    ["Sailed", r.vessel_sailing_date],
  ];
  for (const [label, v] of hops) if (v) return `${label} ${fmtDate(v)}`;
  return r.ready_date ? "ready " + fmtDate(r.ready_date) : (r.shipper_invoice_no ? "in transit" : "—");
};

const PendingSalesOrders: React.FC = () => {
  const [customers, setCustomers] = React.useState<any[]>([]);
  const [customerId, setCustomerId] = React.useState<string>(() => readParams().get("customer") || "");
  const [state, setState] = React.useState<{ rows: any[]; loading: boolean; error: any; customer: any }>({ rows: [], loading: false, error: null, customer: null });
  const [tab, setTab] = React.useState("all");

  // Load the customer list for the selector once.
  React.useEffect(() => {
    Promise.resolve(AnvilBackend?.customers?.list?.() || { customers: [] })
      .then((r: any) => {
        const list = (r?.customers || r?.rows || []).filter((c: any) => c && c.id);
        list.sort((a: any, b: any) => String(a.customer_name || a.display_name || "").localeCompare(String(b.customer_name || b.display_name || "")));
        setCustomers(list);
      })
      .catch(() => setCustomers([]));
  }, []);

  const load = React.useCallback((cid: string) => {
    if (!cid) { setState({ rows: [], loading: false, error: null, customer: null }); return; }
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve(AnvilBackend?.sales?.pendingSalesOrders?.({ customer_id: cid }) || { rows: [] })
      .then((r: any) => setState({ rows: r?.rows || [], loading: false, error: null, customer: r?.customer || null }))
      .catch((err: any) => setState({ rows: [], loading: false, error: err, customer: null }));
  }, []);

  React.useEffect(() => { load(customerId); }, [customerId, load]);

  const pickCustomer = (cid: string) => {
    setCustomerId(cid);
    // Reflect in the hash so the view deep-links / survives refresh.
    window.location.hash = "#/so?view=pending" + (cid ? "&customer=" + encodeURIComponent(cid) : "");
  };

  const tabs = [
    { id: "all", label: "All", match: () => true },
    { id: "local", label: "Local (WO)", match: (r: any) => r.origin === "local" },
    { id: "import", label: "Imported", match: (r: any) => r.origin === "import" },
    { id: "overdue", label: "90+ days", match: (r: any) => !!r.over_90_days },
    { id: "no_ready", label: "No ready date", match: (r: any) => !r.ready_date && !r.promised_date },
  ];
  const matcher = tabs.find((t) => t.id === tab)?.match || (() => true);
  const filtered = state.rows.filter(matcher);
  const counts = Object.fromEntries(tabs.map((t) => [t.id, state.rows.filter(t.match).length]));
  const totalValue = state.rows.reduce((s, r) => s + (Number(r.value) || 0), 0);

  return (
    <>
      <WSTitle
        eyebrow="Sales · Pending Orders"
        title="Pending sales orders"
        meta={state.customer ? `${state.customer.customer_name || state.customer.display_name} · ${state.rows.length} open line${state.rows.length === 1 ? "" : "s"} · ${fmtMoney(totalValue)}` : "Select a customer"}
        right={<>
          <select
            className="select"
            value={customerId}
            onChange={(e) => pickCustomer(e.target.value)}
            aria-label="Customer"
            style={{ minWidth: 220 }}
          >
            <option value="">Select customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.customer_name || c.display_name || c.id.slice(0, 8)}</option>
            ))}
          </select>
          <Btn icon kind="ghost" sm onClick={() => load(customerId)} title="Refresh" disabled={!customerId}>{Icon.cycle}</Btn>
        </>}
      />
      {customerId && <WSTabs tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} active={tab} onChange={setTab} />}

      <div className="ws-content">
        {state.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load pending orders" action={<Btn sm onClick={() => load(customerId)}>Retry</Btn>}>
            <span className="mono-sm">{String(state.error?.message || state.error)}</span>
          </Banner>
        )}

        {!customerId ? (
          <Card><div className="body" style={{ padding: 28, textAlign: "center", color: "var(--ink-3)" }}>
            Pick a customer above to see their open sales-order lines and where each one stands in the supply chain.
          </div></Card>
        ) : state.loading ? (
          <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading pending orders…</div></Card>
        ) : filtered.length === 0 ? (
          <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            {state.rows.length === 0 ? "No open sales-order lines for this customer." :
              <>No lines in this view. <button type="button" onClick={() => setTab("all")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</button></>}
          </div></Card>
        ) : (
          <Card flush>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead><tr>
                  <th>SO / date</th>
                  <th>Part · description</th>
                  <th>Origin</th>
                  <th className="r">Ord / Sup / Bal</th>
                  <th className="r">Value</th>
                  <th>Promised</th>
                  <th>Source PO · ready</th>
                  <th>In-transit</th>
                  <th className="r">Age</th>
                </tr></thead>
                <tbody>
                  {filtered.slice(0, 500).map((r, idx) => {
                    const oc = ORIGIN_CHIP[r.origin] || ORIGIN_CHIP.unknown;
                    return (
                      <tr key={r.order_id + ":" + (r.part_no || idx)}>
                        <td className="mono-sm"><span className="pri">{r.so_number || "—"}</span><div style={{ color: "var(--ink-3)" }}>{fmtDate(r.po_date)}</div></td>
                        <td className="mono-sm">
                          <span className="pri">{r.part_no || "—"}</span>
                          {r.part_split ? <Chip k="ghost">split</Chip> : null}
                          <div style={{ color: "var(--ink-3)" }}>{r.description || "—"}</div>
                        </td>
                        <td>
                          <Chip k={oc.k as any}>{oc.label}{r.country ? " · " + r.country : ""}</Chip>
                          {r.origin_conflict ? <Chip k="warn">?</Chip> : null}
                        </td>
                        <td className="r mono-sm">{fmtQty(r.ordered_qty)} / {fmtQty(r.supplied_qty)} / <b>{fmtQty(r.balance_qty)}</b></td>
                        <td className="r mono-sm">{fmtMoney(r.value)}</td>
                        <td className="mono-sm">{fmtDate(r.promised_date)}{r.promised_source === "order" ? <div style={{ color: "var(--ink-3)" }}>order-level</div> : null}</td>
                        <td className="mono-sm">{r.source_po_no || "—"}{r.ready_date ? <div style={{ color: "var(--ink-3)" }}>ready {fmtDate(r.ready_date)}</div> : null}</td>
                        <td className="mono-sm">{transitCell(r)}</td>
                        <td className="r"><Chip k={r.over_90_days ? "bad" : (r.days_from_po != null && r.days_from_po >= 60 ? "warn" : "ghost")}>{r.days_from_po == null ? "—" : r.days_from_po + "d"}</Chip></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
};

export default PendingSalesOrders;
