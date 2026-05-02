// Orders screen, ESM port. Lists every order with stage chip + age + value.
// Search box filters in place. Click a row to navigate to the legacy SO
// Workspace by changing the hash; the legacy app picks it up. (Sub-PR 2
// brings the workspace itself across.)

import React, { useMemo, useState } from "react";
import { ObaraBackend } from "../lib/api.js";
import { useFetch, ageLabel, fmtINRShort, stageOf } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";

const rowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.orders)) return resp.orders;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export default function Orders() {
  const orders = useFetch(() => ObaraBackend?.orders?.list?.({ limit: 200 }) || Promise.resolve([]), []);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const rows = rowsOf(orders.data);

  const allStatuses = useMemo(() => {
    const s = new Set();
    for (const r of rows) if (r.status) s.add(r.status);
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (!needle) return true;
      const hay = [
        r.po_number,
        r.customer_name,
        r.customer?.customer_name,
        r.id,
        r.notes,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q, statusFilter]);

  const totalValue = filtered.reduce((sum, r) => sum + (Number(r.grand_total) || 0), 0);

  if (orders.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales" title="Sales orders" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading orders…</div></Card></div>
      </div>
    );
  }

  if (orders.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Sales" title="Sales orders" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load orders"
                  action={<Btn sm onClick={orders.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(orders.error.message || orders.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Sales"
        title="Sales orders"
        meta={`${filtered.length} of ${rows.length} · ${fmtINRShort(totalValue)}`}
        right={<Btn icon kind="ghost" sm onClick={orders.reload} title="Refresh">{Icon.cycle}</Btn>}
      />

      <div className="ws-content">
        <KPIRow cols={3}>
          <KPI lbl="Total" v={String(rows.length)} d="last 200" />
          <KPI lbl="Filtered" v={String(filtered.length)} d={q || statusFilter ? "filtered view" : "no filter"} />
          <KPI lbl="Value" v={fmtINRShort(totalValue)} d="filtered sum" />
        </KPIRow>

        <Card flush>
          <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--hairline, #2a2a2a)" }}>
            <input
              type="search"
              placeholder="Search PO / customer / notes"
              value={q}
              onChange={(ev) => setQ(ev.target.value)}
              style={{ flex: 1, padding: "6px 8px" }}
            />
            <select value={statusFilter} onChange={(ev) => setStatusFilter(ev.target.value)}>
              <option value="">all statuses</option>
              {allStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No orders match the filter.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>PO number</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="r">Value</th>
                <th>Age</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const chip = stageOf(r.status);
                  return (
                    <tr key={r.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => { window.location.hash = `#/so?id=${r.id}`; }}>
                      <td className="mono"><span className="pri">{r.po_number || r.id?.slice(0, 8) || "—"}</span></td>
                      <td>{r.customer_name || r.customer?.customer_name || "—"}</td>
                      <td><Chip k={chip.k}>{chip.label}</Chip></td>
                      <td className="r mono">{r.grand_total != null ? fmtINRShort(r.grand_total) : "—"}</td>
                      <td className="mono-sm">{r.created_at ? ageLabel(r.created_at) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
