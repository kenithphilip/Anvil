import React, { useEffect, useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KV, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";

// ============================================================
// ANVIL v3 — wired Email Triage
// Wave F · Comms
// Two-pane inbox + detail. Promote / attach / nudge actions.
// ============================================================

const emailRowsFromResp = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.emails)) return resp.emails;
  if (Array.isArray(resp.messages)) return resp.messages;
  if (Array.isArray(resp.rows)) return resp.rows;
  if (Array.isArray(resp.events)) return resp.events;
  return [];
};

const intentChip = (intent) => {
  const map = {
    "Customer PO":          { k: "info",  label: "Customer PO" },
    "Supplier rate":        { k: "ghost", label: "Supplier rate" },
    "Payment":              { k: "plum",  label: "Payment" },
    "Service · breakdown":  { k: "bad",   label: "Service" },
    "Spam":                 { k: "ghost", label: "Spam" },
  };
  return map[intent] || { k: "ghost", label: (intent || "—") };
};

const truncate = (s, n) => {
  if (!s) return "—";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

const WiredEmailTriage = () => {
  const inbox = useFetch(
    () => fetch("/api/email/inbound?limit=50", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ list: true, limit: 50 }) })
      .then((r) => r.ok ? r.json() : { emails: [] })
      .catch(() => ({ emails: [] })),
    []
  );
  const orders = useFetch(
    () => ObaraBackend?.orders?.list?.({ limit: 100 }) || Promise.resolve([]),
    []
  );

  const rows = emailRowsFromResp(inbox.data);
  const orderList = Array.isArray(orders.data) ? orders.data : (orders.data?.rows || orders.data?.orders || []);

  const [selectedId, setSelectedId] = useState(rows[0]?.id || null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [attachQuery, setAttachQuery] = useState("");

  // Reselect first row when data first arrives.
  useEffect(() => {
    if (!selectedId && rows.length) setSelectedId(rows[0].id);
  }, [rows.length]);

  const selected = rows.find((r) => r.id === selectedId);

  const matchedOrders = orderList.filter((o) => {
    if (!attachQuery) return true;
    const q = attachQuery.toLowerCase();
    return (
      (o.po_number || "").toLowerCase().includes(q) ||
      (o.customer?.customer_name || "").toLowerCase().includes(q)
    );
  }).slice(0, 6);

  const promote = async () => {
    if (!selected) return;
    setBusy(true); setFlash(null);
    try {
      await ObaraBackend?.orders?.create?.({ from_email_id: selected.id });
      setFlash({ kind: "good", msg: "Promoted email to draft order" });
      inbox.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const attachToOrder = async (orderId) => {
    if (!selected || !orderId) return;
    setBusy(true); setFlash(null);
    try {
      await ObaraBackend?.orders?.update?.(orderId, { attached_email_id: selected.id });
      setFlash({ kind: "good", msg: `Attached to ${orderId.slice(0, 8)}` });
      inbox.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  const requestMissing = async () => {
    if (!selected) return;
    setBusy(true); setFlash(null);
    try {
      const orderId = selected.order_id || selected.related_order_id || null;
      if (!orderId) throw new Error("No order linked to this email");
      await ObaraBackend?.communications?.missingDoc?.(orderId);
      setFlash({ kind: "good", msg: "Missing-doc nudge queued" });
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Comms · Email Triage"
        title="Inbound · email triage"
        meta={`${rows.length} in inbox · ${rows.filter((r) => !r.triaged).length} untriaged`}
        right={<>
          <Btn icon kind="ghost" sm onClick={inbox.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Action failed" : "Action complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}
        {inbox.error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load inbox" action={<Btn sm onClick={inbox.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(inbox.error.message || inbox.error)}</span>
          </Banner>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
          <Card flush>
            {inbox.loading ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading inbox…</div>
            ) : rows.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                Inbox empty. New email-in messages will appear here.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th scope="col">From</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Intent</th>
                  <th scope="col" className="r">Att.</th>
                  <th scope="col" className="r">Age</th>
                </tr></thead>
                <tbody>
                  {rows.slice(0, 50).map((r) => {
                    const isSel = r.id === selectedId;
                    const intent = intentChip(r.classification || r.intent);
                    const attCount = (r.attachments && r.attachments.length) || r.attachment_count || 0;
                    return (
                      <tr
                        key={r.id}
                        tabIndex={0}
                        onClick={() => setSelectedId(r.id)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            setSelectedId(r.id);
                          }
                        }}
                        style={{ cursor: "pointer", background: isSel ? "var(--paper-2)" : undefined }}
                        aria-selected={isSel}
                      >
                        <td className="mono-sm">{r.from || r.sender || "—"}</td>
                        <td>{truncate(r.subject, 38)}</td>
                        <td><Chip k={intent.k}>{intent.label}</Chip></td>
                        <td className="r mono">{attCount || "—"}</td>
                        <td className="r mono">{r.received_at || r.created_at ? ageLabel(r.received_at || r.created_at) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {!selected ? (
              <Card title="No selection" eyebrow="pick a row">
                <div className="body" style={{ color: "var(--ink-3)" }}>Select an email to see thread details and actions.</div>
              </Card>
            ) : (
              <>
                <Card title={selected.subject || "(no subject)"} eyebrow={`thread · ${(selected.thread_id || selected.id || "").slice(0, 12)}`}>
                  <KV rows={[
                    ["From", selected.from || selected.sender || "—"],
                    ["Received", selected.received_at || selected.created_at || "—"],
                    ["Intent", (selected.classification || selected.intent || "—")],
                    ["Confidence", selected.confidence != null ? selected.confidence.toFixed(2) : "—"],
                  ]} />
                  {(selected.attachments && selected.attachments.length > 0) && (
                    <>
                      <div className="divider" />
                      <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Attachments</div>
                      <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                        {selected.attachments.map((a, i) => (
                          <li key={i} className="mono-sm">{Icon.doc} {a.filename || a.name || "(file)"}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </Card>

                <Card title="Actions" eyebrow="promote · attach · nudge">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <Btn kind="primary" sm disabled={busy} onClick={promote}>
                      {Icon.zap} Promote to order
                    </Btn>
                    <Btn kind="ghost" sm disabled={busy || !selected} onClick={requestMissing}>
                      {Icon.send} Request missing doc
                    </Btn>
                  </div>
                  <div className="divider" />
                  <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>Attach to existing order</div>
                  <input
                    className="input"
                    placeholder="search by PO / customer…"
                    value={attachQuery}
                    onChange={(ev) => setAttachQuery(ev.target.value)}
                    aria-label="Search orders"
                    style={{ width: "100%", height: 28, marginBottom: 8 }}
                  />
                  {orderList.length === 0 ? (
                    <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No orders to attach to.</div>
                  ) : (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                      {matchedOrders.map((o) => (
                        <li key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 6, border: "1px solid var(--hairline)" }}>
                          <span className="mono-sm" style={{ flex: 1 }}>
                            <b>{o.po_number || o.quote_number || "draft"}</b> · {o.customer?.customer_name || "—"}
                          </span>
                          <Btn sm disabled={busy} onClick={() => attachToOrder(o.id)}>attach</Btn>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
};


export default WiredEmailTriage;
