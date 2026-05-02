// Home screen, ESM port. Proves the ESM chain: api + helpers + primitives.
// Wraps the same ObaraBackend.orders.list / audit.list calls the legacy
// wired-home.jsx uses and renders the same KPI row + recent orders + audit
// stream layout, sized down to what's needed to demonstrate the pattern.

import React from "react";
import { ObaraBackend } from "../lib/api.js";
import { useFetch, ageLabel, fmtINRShort, stageOf } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle, Stream } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";

const rowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.orders)) return resp.orders;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const auditOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.events)) return resp.events;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

export default function Home() {
  const orders = useFetch(() => ObaraBackend?.orders?.list?.({ limit: 50 }) || Promise.resolve([]), []);
  const audit  = useFetch(() => ObaraBackend?.audit?.list?.({ limit: 6 }) || Promise.resolve([]), []);

  if (orders.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Home" title="Anvil" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading orders…</div></Card></div>
      </div>
    );
  }

  if (orders.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Home" title="Anvil" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load orders"
                  action={<Btn sm onClick={orders.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(orders.error.message || orders.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = rowsOf(orders.data);
  const auditRows = auditOf(audit.data);

  const total = rows.length;
  const blocked = rows.filter((r) => r.status === "BLOCKED" || r.status === "FAILED_TALLY_IMPORT").length;
  const pending = rows.filter((r) => r.status === "PENDING_REVIEW" || r.status === "DUPLICATE").length;
  const totalValue = rows.reduce((sum, r) => sum + (Number(r.grand_total) || 0), 0);

  return (
    <>
      <WSTitle
        eyebrow="Home"
        title="Anvil v3 (vite)"
        meta={`${total} orders · ${blocked} blocked`}
        right={<Btn icon kind="ghost" sm onClick={orders.reload} title="Refresh">{Icon.cycle}</Btn>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Orders" v={String(total)} d="last 50" />
          <KPI lbl="Blocked" v={String(blocked)} d="needs action" dKind={blocked > 0 ? "down" : ""} live={blocked > 0} />
          <KPI lbl="Pending review" v={String(pending)} d="validate / dedupe" />
          <KPI lbl="Order value" v={fmtINRShort(totalValue)} d="last 50 sum" />
        </KPIRow>

        <Card title="Recent orders" eyebrow="newest first" flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No orders yet.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>PO number</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="r">Value</th>
                <th>Created</th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 25).map((r) => {
                  const chip = stageOf(r.status);
                  return (
                    <tr key={r.id}>
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

        <Card title="Recent activity" eyebrow="audit + system events">
          {auditRows.length === 0 ? (
            <div className="body" style={{ color: "var(--ink-3)" }}>No recent activity.</div>
          ) : (
            <Stream rows={auditRows.slice(0, 10).map((a) => ({
              t: a.created_at ? ageLabel(a.created_at) : "—",
              a: a.actor_email || a.actor_id || "system",
              m: <span>{a.action || "event"} <span style={{ color: "var(--ink-3)" }}>{a.object_type || ""} {a.object_id?.slice(0, 8) || ""}</span></span>,
            }))} />
          )}
        </Card>
      </div>
    </>
  );
}
