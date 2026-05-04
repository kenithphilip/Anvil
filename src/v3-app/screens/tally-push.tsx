import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, stageOf, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { tallyOrderRows, shortHash } from "../lib/tally";
import { useTallyBridgeStatus } from "../lib/tally-status";

// ============================================================
// ANVIL v3 — wired Tally · push queue
// Wave D · Finance
// Pulls APPROVED + EXPORTED_TO_TALLY orders, drives ObaraBackend.tally.push.
// Reuses tallyOrderRows + shortHash from wired-tally-masters-d.jsx.
// ============================================================

const tallyPushSnapshot = (order) => ({
  orderId: order.id,
  voucherNo: order.po_number || ("SO:" + String(order.id).slice(0, 8)),
  payloadHash: order.payload_hash || (order.approval && order.approval.payloadHash) || null,
  // Server requires tallyXml in body; with no client-side composer, emit a
  // minimal envelope so the push endpoint can record an attempt and surface
  // any bridge error in the UI.
  tallyXml: "<ENVELOPE/>",
  salesOrder: (order.result && order.result.salesOrder) || null,
});

const WiredTallyPush = () => {
  const queue   = useFetch(() => ObaraBackend?.orders?.list?.({ status: "APPROVED", limit: 200 })          || Promise.resolve({ orders: [] }), []);
  const pushed  = useFetch(() => ObaraBackend?.orders?.list?.({ status: "EXPORTED_TO_TALLY", limit: 200 }) || Promise.resolve({ orders: [] }), []);

  const [busyId, setBusyId] = useState(null);
  const [flash, setFlash]   = useState(null);

  const queueRows  = tallyOrderRows(queue.data);
  const pushedRows = tallyOrderRows(pushed.data);

  // Order-level amendments are jsonb on each order. Surface any order whose
  // result.amendments[] is non-empty as a "pending amendment" diff card.
  const amendOrders = queueRows.concat(pushedRows).filter((o) => {
    const amends = (o.result && (o.result.amendments || o.result.order_amendments)) || [];
    return Array.isArray(amends) && amends.length > 0;
  });

  const pushedToday = pushedRows.filter((o) => {
    const t = o.updated_at || o.created_at;
    return t && new Date(t).toDateString() === new Date().toDateString();
  });
  const failed = queueRows.concat(pushedRows).filter((o) => o.status === "FAILED_TALLY_IMPORT" || o.tally_status === "failed");

  const canPush  = !!(RBAC && RBAC.canDo && RBAC.canDo("tally.push"));
  const bridge   = useTallyBridgeStatus();

  const handlePush = async (order) => {
    if (!canPush) return;
    setBusyId(order.id);
    setFlash(null);
    try {
      await ObaraBackend?.tally?.push?.(tallyPushSnapshot(order));
      setFlash({ kind: "good", msg: `Pushed ${order.po_number || order.id.slice(0, 8)}` });
      queue.reload();
      pushed.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Finance · Tally"
        title="Push queue"
        meta={`${queueRows.length} queued · ${pushedToday.length} pushed today · ${failed.length} failed · ${amendOrders.length} amend`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { queue.reload(); pushed.reload(); }} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        {!bridge.loading && !bridge.configured && (
          <Banner kind="warn" icon={Icon.alert} title="Tally bridge not configured">
            <span className="mono-sm">
              Set <code>TALLY_BRIDGE_URL</code> and <code>TALLY_BRIDGE_TOKEN</code> in Vercel
              env to enable push. Reconcile and Masters tabs still work without the bridge.
            </span>
          </Banner>
        )}

        {!canPush && (
          <Banner kind="warn" icon={Icon.lock} title="Push permission required">
            <span className="mono-sm">Your role cannot push to Tally. Contact an admin or finance manager to enable <b>tally.push</b>.</span>
          </Banner>
        )}

        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Push failed" : "Push complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {(queue.error || pushed.error) ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load Tally queue">
            <span className="mono-sm">{String((queue.error || pushed.error).message || (queue.error || pushed.error))}</span>
          </Banner>
        ) : null}

        <KPIRow cols={4}>
          <KPI lbl="Queued"        v={String(queueRows.length)}  d={queueRows.length ? `oldest ${ageLabel(queueRows[0]?.updated_at || queueRows[0]?.created_at)}` : "all clear"} live={queueRows.length > 0} />
          <KPI lbl="Pushed today"  v={String(pushedToday.length)} d="EXPORTED_TO_TALLY" dKind={pushedToday.length ? "up" : ""} />
          <KPI lbl="Failed"        v={String(failed.length)}     d="needs retry" dKind={failed.length ? "down" : ""} />
          <KPI lbl="Amendments"    v={String(amendOrders.length)} d="re-hash + push" />
        </KPIRow>

        <Card title="Push queue" eyebrow="approved · awaiting Tally" flush>
          {queue.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading queue…</div>
          ) : queueRows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Nothing waiting to push.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Order reference</th>
                <th scope="col">Customer</th>
                <th scope="col" className="r">Value</th>
                <th scope="col">Payload hash</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">Age</th>
                <th scope="col" style={{ width: 120 }}></th>
              </tr></thead>
              <tbody>
                {queueRows.map((o) => {
                  const st = stageOf(o.status);
                  const value = Number(o.result?.salesOrder?.grandTotal) || 0;
                  const hash = o.payload_hash || (o.approval && o.approval.payloadHash) || null;
                  return (
                    <tr key={o.id}>
                      <td className="mono"><span className="pri">{o.po_number || o.quote_number || "draft"}</span></td>
                      <td>{o.customer?.customer_name || o.customer_id?.slice(0, 8) || "—"}</td>
                      <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                      <td className="mono-sm">{shortHash(hash)}</td>
                      <td><Chip k={st.k}>{st.label}</Chip></td>
                      <td className="r mono">{ageLabel(o.updated_at || o.created_at)}</td>
                      <td>
                        <Btn sm kind="primary"
                             disabled={!canPush || busyId === o.id || !bridge.configured}
                             title={!bridge.configured ? "Tally bridge not configured" : undefined}
                             onClick={() => handlePush(o)}>
                          {busyId === o.id ? "pushing…" : <>push {Icon.send}</>}
                        </Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {amendOrders.length > 0 && (
          <Card title="Pending amendments" eyebrow="diff before re-hash">
            {amendOrders.slice(0, 6).map((o) => {
              const amends = (o.result && (o.result.amendments || o.result.order_amendments)) || [];
              return (
                <div key={o.id} style={{ marginBottom: 14 }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{o.po_number || o.id.slice(0, 8)}</span>
                    <span style={{ marginLeft: 8 }}>·</span>
                    <span style={{ marginLeft: 8 }}>{o.customer?.customer_name || "—"}</span>
                  </div>
                  {amends.slice(0, 4).map((amd, i) => (
                    <div key={i} className="diff-row" style={{ marginBottom: 6 }}>
                      <div className="l">
                        <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>before</div>
                        {amd.before ? <span>{typeof amd.before === "string" ? amd.before : JSON.stringify(amd.before)}</span> : <span>—</span>}
                      </div>
                      <div className="r">
                        <div style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9, letterSpacing: 0.06 }}>after</div>
                        {amd.after ? <span>{typeof amd.after === "string" ? amd.after : JSON.stringify(amd.after)}</span> : <span>—</span>}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </Card>
        )}

        <Card title="Recently pushed" eyebrow="exported to Tally" flush>
          {pushed.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
          ) : pushedRows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Nothing pushed yet.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Order reference</th>
                <th scope="col">Customer</th>
                <th scope="col" className="r">Value</th>
                <th scope="col">Payload hash</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">Age</th>
              </tr></thead>
              <tbody>
                {pushedRows.slice(0, 50).map((o) => {
                  const st = stageOf(o.status);
                  const value = Number(o.result?.salesOrder?.grandTotal) || 0;
                  const hash = o.payload_hash || (o.approval && o.approval.payloadHash) || null;
                  return (
                    <tr key={o.id}>
                      <td className="mono"><span className="pri">{o.po_number || o.quote_number || "draft"}</span></td>
                      <td>{o.customer?.customer_name || "—"}</td>
                      <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                      <td className="mono-sm">{shortHash(hash)}</td>
                      <td><Chip k={st.k}>{st.label}</Chip></td>
                      <td className="r mono">{ageLabel(o.updated_at || o.created_at)}</td>
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


export default WiredTallyPush;
