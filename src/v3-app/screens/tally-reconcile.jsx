import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, stageOf, useFetch } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";
import { tallyOrderRows, shortHash } from "../lib/tally.js";

// ============================================================
// ANVIL v3 — wired Tally · reconciliation
// Wave D · Finance
// Lists EXPORTED_TO_TALLY orders, calls ObaraBackend.tally.reconcile.
// Reuses tallyOrderRows + shortHash from wired-tally-masters-d.jsx.
// ============================================================

const WiredTallyReconcile = () => {
  const exported = useFetch(() => ObaraBackend?.orders?.list?.({ status: "EXPORTED_TO_TALLY", limit: 200 }) || Promise.resolve({ orders: [] }), []);
  const [busyId, setBusyId] = useState(null);
  const [flash, setFlash]   = useState(null);

  const rows = tallyOrderRows(exported.data);

  const handleReconcile = async (order) => {
    setBusyId(order.id);
    setFlash(null);
    try {
      const tallyVoucherId =
        (order.result && order.result.tally && order.result.tally.voucherId) ||
        (order.result && order.result.tally_voucher_id) ||
        order.tally_voucher_id ||
        null;
      await ObaraBackend?.tally?.reconcile?.({
        orderId: order.id,
        status: "reconciled",
        tally_voucher_id: tallyVoucherId,
      });
      setFlash({ kind: "good", msg: `Reconciled ${order.po_number || order.id.slice(0, 8)}` });
      exported.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusyId(null);
    }
  };

  const totalValue = rows.reduce((s, o) => s + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);
  const oldest = rows.length ? ageLabel(rows[rows.length - 1].updated_at || rows[rows.length - 1].created_at) : "—";

  return (
    <>
      <WSTitle
        eyebrow="Finance · Tally"
        title="Reconciliation"
        meta={`${rows.length} pushed · awaiting reconciliation`}
        right={<>
          <Btn icon kind="ghost" sm onClick={exported.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Reconcile failed" : "Reconcile complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {exported.error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load Tally exports" action={<Btn sm onClick={exported.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(exported.error.message || exported.error)}</span>
          </Banner>
        ) : null}

        <KPIRow cols={4}>
          <KPI lbl="Awaiting" v={String(rows.length)} d={rows.length ? `oldest ${oldest}` : "all clear"} live={rows.length > 0} />
          <KPI lbl="Total ₹"  v={fmtINRShort(totalValue)} d="value pending" />
          <KPI lbl="Today"    v={String(rows.filter((o) => { const t = o.updated_at || o.created_at; return t && new Date(t).toDateString() === new Date().toDateString(); }).length)} d="pushed today" />
          <KPI lbl="Stale"    v={String(rows.filter((o) => {
            const t = o.updated_at || o.created_at;
            if (!t) return false;
            return (Date.now() - new Date(t).getTime()) > 24 * 3600_000;
          }).length)} d=">24h waiting" dKind="down" />
        </KPIRow>

        <Card title="Pushed · awaiting Tally confirmation" eyebrow="mark reconciled when the voucher is confirmed in Tally" flush>
          {exported.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading exports…</div>
          ) : rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Nothing waiting for reconciliation.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">Pushed at</th>
                <th scope="col">Voucher number</th>
                <th scope="col">Payload hash</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ width: 160 }}></th>
              </tr></thead>
              <tbody>
                {rows.map((o) => {
                  const st = stageOf(o.status);
                  const pushedAt = o.updated_at || o.created_at;
                  const voucher =
                    (o.result && o.result.tally && (o.result.tally.voucherId || o.result.tally.voucherNo)) ||
                    o.tally_voucher_id ||
                    "—";
                  const hash = o.payload_hash || (o.approval && o.approval.payloadHash) || null;
                  return (
                    <tr key={o.id}>
                      <td className="mono"><span className="pri">{o.po_number || o.quote_number || "draft"}</span></td>
                      <td>{o.customer?.customer_name || o.customer_id?.slice(0, 8) || "—"}</td>
                      <td className="mono-sm">{pushedAt ? new Date(pushedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td className="mono-sm">{voucher}</td>
                      <td className="mono-sm">{shortHash(hash)}</td>
                      <td><Chip k={st.k}>{st.label}</Chip></td>
                      <td>
                        <Btn sm kind="primary" disabled={busyId === o.id} onClick={() => handleReconcile(o)}>
                          {busyId === o.id ? "marking…" : <>mark reconciled {Icon.check}</>}
                        </Btn>
                      </td>
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
};


export default WiredTallyReconcile;
