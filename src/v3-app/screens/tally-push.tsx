import React, { useEffect, useState } from "react";
import { ageLabel, draftLabel, fmtINRShort, stageOf, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { tallyOrderRows, shortHash } from "../lib/tally";
import { useTallyBridgeStatus } from "../lib/tally-status";

// ============================================================
// ANVIL v3 — wired Tally · push queue
// Wave D · Finance
// Pulls APPROVED + EXPORTED_TO_TALLY orders, drives AnvilBackend.tally.push.
// Reuses tallyOrderRows + shortHash from wired-tally-masters-d.jsx.
// ============================================================

const tallyPushSnapshot = (order) => ({
  orderId: order.id,
  voucherNo: order.po_number || ("SO:" + String(order.id).slice(0, 8)),
  payloadHash: order.payload_hash || (order.approval && order.approval.payloadHash) || null,
  // Phase 1 F1 (second half): the server composes the Tally
  // voucher XML from order + customer + tally_companies. We
  // intentionally do NOT send a tallyXml body; the push handler
  // builds it via buildSalesVoucherXml in
  // src/api/_lib/tally-build-voucher.js. Old callers that send
  // the literal "<ENVELOPE/>" placeholder are detected by
  // isPlaceholderXml and rebuilt server-side.
  salesOrder: (order.result && order.result.salesOrder) || null,
});

const WiredTallyPush = () => {
  const queue   = useFetch(() => AnvilBackend?.orders?.list?.({ status: "APPROVED", limit: 200 })          || Promise.resolve({ orders: [] }), []);
  const pushed  = useFetch(() => AnvilBackend?.orders?.list?.({ status: "EXPORTED_TO_TALLY", limit: 200 }) || Promise.resolve({ orders: [] }), []);

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

  // The tenant's sales-order processing mode (Admin > Sales-order
  // processing). In Mode B the server refuses every push (tally/push.js),
  // so the screen says why, lists the approved orders and offers no push
  // button. While the mode loads, push buttons render disabled, so a quick
  // click cannot reach a push that Mode B refuses. A mode that cannot be
  // read counts as Mode A, which is also how the server reads it.
  const [modeState, setModeState] = useState<"loading" | "A" | "B">("loading");
  const [modeLabel, setModeLabel] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    Promise.resolve((AnvilBackend as any)?.docai?.soProcessingMode?.())
      .then((r: any) => {
        if (!live) return;
        const m = r?.mode === "B" ? "B" : "A";
        setModeLabel(r?.modes?.[m]?.label);
        setModeState(m);
      })
      .catch(() => { if (live) setModeState("A"); });
    return () => { live = false; };
  }, []);
  const modeB = modeState === "B";
  const modeA = modeState === "A";

  const handlePush = async (order) => {
    if (!canPush || !modeA) return;
    setBusyId(order.id);
    setFlash(null);
    try {
      await AnvilBackend?.tally?.push?.(tallyPushSnapshot(order));
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
        title={modeB ? "Approved orders" : "Push queue"}
        meta={modeB
          ? `${queueRows.length} approved · ${amendOrders.length} amend`
          : `${queueRows.length} queued · ${pushedToday.length} pushed today · ${failed.length} failed · ${amendOrders.length} amend`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { queue.reload(); pushed.reload(); }} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        {modeB && (
          <Banner kind="info" icon={Icon.lock} title={"Push is off in Mode B" + (modeLabel ? ": " + modeLabel : "")}>
            <span className="mono-sm">
              Your team enters these sales orders in Tally by hand, and Anvil checks them against the PO.
              Anvil does not push vouchers in Mode B, so this screen offers no push. An admin can switch to
              Mode A under Admin &gt; Sales-order processing.
            </span>
          </Banner>
        )}

        {modeA && !bridge.loading && !bridge.configured && (
          <Banner kind="warn" icon={Icon.alert} title="Tally bridge not configured">
            <span className="mono-sm">
              Set <code>TALLY_BRIDGE_URL</code> and <code>TALLY_BRIDGE_TOKEN</code> in Vercel
              env to enable push. Reconcile and Masters tabs still work without the bridge.
            </span>
          </Banner>
        )}

        {modeA && !canPush && (
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

        {modeB ? (
          // Mode B: the clerk keys these orders in Tally, so nothing here
          // waits on a push and the push counters do not apply.
          <KPIRow cols={2}>
            <KPI lbl="Approved"    v={String(queueRows.length)}  d={queueRows.length ? `oldest ${ageLabel(queueRows[0]?.updated_at || queueRows[0]?.created_at)}` : "none"} />
            <KPI lbl="Amendments"  v={String(amendOrders.length)} d="pending" />
          </KPIRow>
        ) : (
          <KPIRow cols={4}>
            <KPI lbl="Queued"        v={String(queueRows.length)}  d={queueRows.length ? `oldest ${ageLabel(queueRows[0]?.updated_at || queueRows[0]?.created_at)}` : "all clear"} live={queueRows.length > 0} />
            <KPI lbl="Pushed today"  v={String(pushedToday.length)} d="EXPORTED_TO_TALLY" dKind={pushedToday.length ? "up" : ""} />
            <KPI lbl="Failed"        v={String(failed.length)}     d="needs retry" dKind={failed.length ? "down" : ""} />
            <KPI lbl="Amendments"    v={String(amendOrders.length)} d="re-hash + push" />
          </KPIRow>
        )}

        <Card title={modeB ? "Approved orders" : "Push queue"} eyebrow={modeB ? "approved · keyed in Tally by hand" : "approved · awaiting Tally"} flush>
          {queue.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading queue…</div>
          ) : queueRows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>{modeB ? "No approved orders." : "Nothing waiting to push."}</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Order reference</th>
                <th scope="col">Customer</th>
                <th scope="col" className="r">Value</th>
                <th scope="col">Payload hash</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">Age</th>
                {!modeB && <th scope="col" style={{ width: 120 }}></th>}
              </tr></thead>
              <tbody>
                {queueRows.map((o) => {
                  const st = stageOf(o.status);
                  const value = Number(o.result?.salesOrder?.grandTotal) || 0;
                  const hash = o.payload_hash || (o.approval && o.approval.payloadHash) || null;
                  return (
                    <tr key={o.id}>
                      <td className="mono"><span className="pri">{draftLabel(o)}</span></td>
                      <td>{o.customer?.customer_name || o.customer_id?.slice(0, 8) || "—"}</td>
                      <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                      <td className="mono-sm">{shortHash(hash)}</td>
                      <td><Chip k={st.k}>{st.label}</Chip></td>
                      <td className="r mono">{ageLabel(o.updated_at || o.created_at)}</td>
                      {!modeB && (
                        <td>
                          <Btn sm kind="primary"
                               disabled={!modeA || !canPush || busyId === o.id || !bridge.configured}
                               title={!modeA ? "Checking the sales-order processing mode" : !bridge.configured ? "Tally bridge not configured" : undefined}
                               onClick={() => handlePush(o)}>
                            {busyId === o.id ? "pushing…" : <>push {Icon.send}</>}
                          </Btn>
                        </td>
                      )}
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
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>{modeB ? "Anvil does not push in Mode B." : "Nothing pushed yet."}</div>
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
                      <td className="mono"><span className="pri">{draftLabel(o)}</span></td>
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
