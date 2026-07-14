import React, { useEffect, useMemo, useState } from "react";
import { fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Source POs (procurement)
// ============================================================

const SPO_TABS = [
  { id: "open",    label: "Open",         match: (s) => ["DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER"].includes(s) },
  { id: "ack",     label: "Awaiting ack", match: (s) => ["SENT_TO_SUPPLIER", "PRICE_CHANGED"].includes(s) },
  { id: "transit", label: "In transit",   match: (s) => ["SUPPLIER_ACK", "ETA_CONFIRMED", "DELAYED"].includes(s) },
  { id: "rcvd",    label: "Received",     match: (s) => s === "RECEIVED" },
  { id: "closed",  label: "Closed",       match: (s) => ["CLOSED", "CANCELLED"].includes(s) },
];

const SPO_STATUS_CHIP = {
  DRAFT:                      { label: "draft",            k: "ghost" },
  PENDING_INTERNAL_APPROVAL:  { label: "pending approval", k: "warn" },
  SENT_TO_SUPPLIER:           { label: "sent",             k: "info" },
  SUPPLIER_ACK:               { label: "acked",            k: "info" },
  PRICE_CHANGED:              { label: "price changed",    k: "warn" },
  ETA_CONFIRMED:              { label: "eta confirmed",    k: "good" },
  DELAYED:                    { label: "delayed",          k: "bad" },
  RECEIVED:                   { label: "received",         k: "good" },
  CLOSED:                     { label: "closed",           k: "ghost" },
  CANCELLED:                  { label: "cancelled",        k: "ghost" },
};

const spoCurrency = (po) => {
  if (po?.currency) return po.currency;
  const c = (po?.country || "").toUpperCase();
  if (c === "JP" || c === "JAPAN") return "JPY";
  if (c === "AT" || c === "DE" || c === "FR") return "EUR";
  if (c === "US") return "USD";
  return "INR";
};

const spoFmtValue = (n, ccy) => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (ccy === "INR") return fmtINRShort(v);
  if (ccy === "JPY") return `JPY ${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  if (ccy === "EUR") return `EUR ${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  if (ccy === "USD") return `USD ${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `${ccy} ${v.toLocaleString("en-IN")}`;
};

const spoFmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

// Read `new=1` from the hash so the route resolver can stay simple
// (always returns the SPO list screen) while this screen still
// branches into a creation form when the New SPO button asks for it.
const readNewFlag = (): boolean => {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash || "";
  const q = hash.split("?")[1] || "";
  return new URLSearchParams(q).get("new") === "1";
};

const WiredSourcePOs = () => {
  const { useState: uS, useEffect: eS, useMemo: mS } = React;
  const [active, setActive] = uS("open");
  const [ackPo, setAckPo] = uS(null);
  const [ackForm, setAckForm] = uS({ acked_unit_price: "", acked_eta_date: "", acked_qty: "", notes: "" });
  const [submitting, setSubmitting] = uS(false);
  const [submitErr, setSubmitErr] = uS(null);
  // P2 GRN: receive modal state.
  const [receivePo, setReceivePo] = uS<any>(null);
  const [receiveLines, setReceiveLines] = uS<any[]>([]);
  const [receiveInputs, setReceiveInputs] = uS<Record<string, string>>({});
  const [receiveNote, setReceiveNote] = uS("");
  const [receiveBusy, setReceiveBusy] = uS(false);
  const [receiveErr, setReceiveErr] = uS<any>(null);
  const [bump, setBump] = uS(0);

  // Creation form state. `creating` is the toggle that decides
  // whether the inline form panel renders. Initial value reads the
  // URL so the New SPO button (which sets `?new=1`) opens the form
  // automatically without needing a separate route.
  const [creating, setCreating] = uS(readNewFlag());
  const [createForm, setCreateForm] = uS({
    order_id: "", reference: "", supplier: "", country: "",
    currency: "INR", total_foreign: "", acknowledged_eta: "", notes: "",
  });
  const [createErr, setCreateErr] = uS(null);
  const [createBusy, setCreateBusy] = uS(false);
  const ordersList = useFetch(() => creating ? (ObaraBackend?.orders?.list?.() || Promise.resolve([])) : Promise.resolve([]), [creating]);

  // Sync `creating` with hash changes so back/forward + the
  // Cancel button (which strips `?new=1`) keep state coherent.
  eS(() => {
    const onHash = () => setCreating(readNewFlag());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const list = useFetch(() => ObaraBackend?.sourcePos?.list?.() || Promise.resolve([]), [bump]);
  const scorecard = useFetch(() => ObaraBackend?.sourcePos?.scorecard?.() || Promise.resolve([]), [bump]);

  const closeCreate = () => {
    setCreating(false);
    setCreateErr(null);
  };

  const submitCreate = async () => {
    setCreateErr(null);
    if (!createForm.order_id) { setCreateErr({ message: "Pick a parent sales order." }); return; }
    if (!createForm.reference.trim()) { setCreateErr({ message: "Reference is required." }); return; }
    if (!createForm.supplier.trim()) { setCreateErr({ message: "Supplier is required." }); return; }
    setCreateBusy(true);
    try {
      const payload = {
        order_id: createForm.order_id,
        reference: createForm.reference.trim(),
        supplier: createForm.supplier.trim(),
        country: createForm.country.trim() || null,
        currency: createForm.currency.trim() || null,
        total_foreign: createForm.total_foreign ? Number(createForm.total_foreign) : null,
        acknowledged_eta: createForm.acknowledged_eta || null,
        payload: createForm.notes ? { notes: createForm.notes } : {},
      };
      const res = await ObaraBackend?.sourcePos?.create?.(payload);
      window.notifySuccess?.("Source PO created", payload.reference);
      closeCreate();
      reload();
      if (res?.sourcePo?.id && typeof window !== "undefined") {
        // No dedicated workspace route yet; staying on the list is the
        // right behaviour and the new row appears immediately after
        // reload() above.
      }
    } catch (err: any) {
      setCreateErr(err);
      window.notifyError?.("Could not create SPO", err?.message || String(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const reload = () => setBump((n) => n + 1);

  const rows = mS(() => {
    const d = list.data;
    return Array.isArray(d) ? d : (d?.rows || d?.sourcePos || []);
  }, [list.data]);

  const scorecardRows = mS(() => {
    const d = scorecard.data;
    return Array.isArray(d) ? d : (d?.rows || d?.scorecards || []);
  }, [scorecard.data]);

  const counts = Object.fromEntries(SPO_TABS.map((t) => [t.id, rows.filter((p) => t.match(p.status)).length]));
  const filtered = rows.filter((p) => SPO_TABS.find((t) => t.id === active)?.match(p.status));

  // KPIs
  const onTimeRate = mS(() => {
    const total = scorecardRows.length;
    if (!total) return null;
    const sum = scorecardRows.reduce((s, r) => s + (Number(r.on_time_pct) || 0), 0);
    return sum / total;
  }, [scorecardRows]);

  const priceAccRate = mS(() => {
    const total = scorecardRows.length;
    if (!total) return null;
    const sum = scorecardRows.reduce((s, r) => s + (Number(r.price_accuracy_pct) || 0), 0);
    return sum / total;
  }, [scorecardRows]);

  const totalOpen = rows.filter((p) => SPO_TABS[0].match(p.status) || SPO_TABS[1].match(p.status) || SPO_TABS[2].match(p.status)).length;

  const totalValueINR = mS(() => {
    return rows.reduce((s, p) => {
      const v = Number(p.total_inr != null ? p.total_inr : p.total_landed_inr) || 0;
      return s + v;
    }, 0);
  }, [rows]);

  const openAck = (po) => {
    setReceivePo(null);   // mutual exclusion: opening ack fully closes any receive panel
    setAckPo(po);
    setAckForm({
      acked_unit_price: po.total_foreign != null ? String(po.total_foreign)
        : (po.total_inr != null ? String(po.total_inr) : ""),
      acked_eta_date:   po.acknowledged_eta ? String(po.acknowledged_eta).slice(0, 10) : "",
      acked_qty:        "",
      notes: "",
    });
    setSubmitErr(null);
  };

  const closeAck = () => { setAckPo(null); setSubmitErr(null); };

  const submitAck = async () => {
    if (!ackPo) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      // The API (source_pos/ack.js) reads confirmedPrice/confirmedEta and
      // compares the price to the PO total; send those canonical keys or
      // the ack records 0/null. qty + notes ride along in ack_payload.
      const ack = {
        confirmedPrice: ackForm.acked_unit_price ? Number(ackForm.acked_unit_price) : null,
        confirmedEta:   ackForm.acked_eta_date || null,
        confirmedQty:   ackForm.acked_qty ? Number(ackForm.acked_qty) : null,
        notes:          ackForm.notes || null,
      };
      // Bridge signature is ack(sourcePoId, ack). Passing a single object
      // left body.ack undefined, so the endpoint 400'd on every ack.
      await ObaraBackend?.sourcePos?.ack?.(ackPo.id, ack);
      window.notifySuccess?.("Ack submitted", ackPo.reference || ackPo.id?.slice(0, 8));
      closeAck();
      reload();
    } catch (err: any) {
      setSubmitErr(err);
      window.notifyError?.("Ack failed", err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openReceive = async (po: any) => {
    setAckPo(null);
    setReceivePo(po);
    setReceiveLines([]);
    setReceiveInputs({});
    setReceiveNote("");
    setReceiveErr(null);
    try {
      const r: any = await ObaraBackend?.sourcePos?.getReceiving?.(po.id);
      setReceiveLines(Array.isArray(r?.lines) ? r.lines : []);
    } catch (err: any) {
      setReceiveErr(err);
    }
  };
  const closeReceive = () => { setReceivePo(null); setReceiveErr(null); };

  const submitReceive = async () => {
    if (!receivePo) return;
    const lines = Object.entries(receiveInputs)
      .map(([line_index, v]) => ({ line_index: Number(line_index), received_qty: Number(v) }))
      .filter((l) => Number.isFinite(l.received_qty) && l.received_qty > 0);
    if (!lines.length) { setReceiveErr({ message: "Enter a received quantity on at least one line." }); return; }
    setReceiveBusy(true);
    setReceiveErr(null);
    try {
      const res: any = await ObaraBackend?.sourcePos?.receive?.(receivePo.id, { lines, note: receiveNote || null });
      const msg = res?.fully_received ? "Received in full → RECEIVED" : "Partial receipt recorded";
      window.notifySuccess?.("Goods received", msg);
      closeReceive();
      reload();
    } catch (err: any) {
      setReceiveErr(err);
      window.notifyError?.("Receive failed", err?.message || String(err));
    } finally {
      setReceiveBusy(false);
    }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="loading" title="Source POs" />
        <div className="ws-content"><Card><div className="body">Loading source POs…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="error" title="Could not load source POs" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Procurement · Source POs"
        title="Source POs"
        meta={`${rows.length} total · ${totalOpen} active`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/spo?new=1"}>{Icon.plus} New SPO</Btn>
        </>}
      />
      <WSTabs
        tabs={SPO_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {creating && (() => {
          const orderRows = (() => {
            const d = ordersList.data as any;
            if (Array.isArray(d)) return d;
            return d?.orders || d?.rows || [];
          })();
          return (
            <Card title="New Source PO" eyebrow="draft · attach to a parent sales order"
                  right={<Btn sm kind="ghost" onClick={closeCreate} title="Cancel">{Icon.x}</Btn>}>
              {createErr && (
                <Banner kind="bad" icon={Icon.alert} title="Could not create SPO">
                  <span className="mono-sm">{String(createErr?.message || createErr)}</span>
                </Banner>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
                <div>
                  <label htmlFor="spo-new-order" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Parent sales order</label>
                  <select id="spo-new-order" className="select" value={createForm.order_id}
                          onChange={(e) => setCreateForm((f) => ({ ...f, order_id: e.target.value }))}
                          disabled={ordersList.loading}>
                    <option value="">{ordersList.loading ? "loading orders…" : "select an order…"}</option>
                    {orderRows.map((o: any) => (
                      <option key={o.id} value={o.id}>
                        {(o.so_number || o.reference || o.id?.slice(0, 8) || "—")}
                        {o.customer_name ? " · " + o.customer_name : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="spo-new-ref" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>PO reference</label>
                  <input id="spo-new-ref" className="input" placeholder="e.g. SPO-2026-0001"
                         value={createForm.reference}
                         onChange={(e) => setCreateForm((f) => ({ ...f, reference: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="spo-new-supplier" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Supplier</label>
                  <input id="spo-new-supplier" className="input" placeholder="e.g. SKF Bearings India"
                         value={createForm.supplier}
                         onChange={(e) => setCreateForm((f) => ({ ...f, supplier: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="spo-new-country" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Country (ISO-2 / name)</label>
                  <input id="spo-new-country" className="input" placeholder="IN / DE / JP / US"
                         value={createForm.country}
                         onChange={(e) => setCreateForm((f) => ({ ...f, country: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="spo-new-ccy" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Currency</label>
                  <select id="spo-new-ccy" className="select" value={createForm.currency}
                          onChange={(e) => setCreateForm((f) => ({ ...f, currency: e.target.value }))}>
                    {["INR", "USD", "EUR", "JPY", "GBP", "AUD", "SGD"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="spo-new-total" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Total ({createForm.currency || "INR"})</label>
                  <input id="spo-new-total" className="input mono r" type="number" step="0.01"
                         value={createForm.total_foreign}
                         onChange={(e) => setCreateForm((f) => ({ ...f, total_foreign: e.target.value }))} />
                </div>
                <div>
                  <label htmlFor="spo-new-eta" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Acknowledged ETA</label>
                  <input id="spo-new-eta" className="input" type="date"
                         value={createForm.acknowledged_eta}
                         onChange={(e) => setCreateForm((f) => ({ ...f, acknowledged_eta: e.target.value }))} />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label htmlFor="spo-new-notes" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Notes</label>
                  <textarea id="spo-new-notes" className="input" rows={2} style={{ width: "100%", padding: 6 }}
                            value={createForm.notes}
                            onChange={(e) => setCreateForm((f) => ({ ...f, notes: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <Btn sm kind="ghost" onClick={closeCreate} disabled={createBusy}>Cancel</Btn>
                <Btn sm kind="primary" onClick={submitCreate} disabled={createBusy}>
                  {createBusy ? "Creating…" : "Create draft SPO"}
                </Btn>
              </div>
            </Card>
          );
        })()}

        <KPIRow cols={4}>
          <KPI lbl="On-time" v={onTimeRate != null ? `${(onTimeRate * 100).toFixed(0)}%` : "—"} d="rolling 90d" />
          <KPI lbl="Price accuracy" v={priceAccRate != null ? `${(priceAccRate * 100).toFixed(0)}%` : "—"} d="vs quoted" />
          <KPI lbl="Total open" v={String(totalOpen)} d="awaiting closure" live={totalOpen > 0} />
          <KPI lbl="Total value" v={fmtINRShort(totalValueINR)} d="all open SPOs" />
        </KPIRow>

        <div style={{ display: "grid", gridTemplateColumns: ackPo ? "1.5fr 1fr" : "1fr 380px", gap: 14 }}>
          <Card flush>
            <table className="tbl">
              <thead><tr>
                <th>PO ref</th>
                <th>Supplier</th>
                <th>Country</th>
                <th>Currency</th>
                <th className="r">Value</th>
                <th>ETA</th>
                <th>Status</th>
                <th></th>
              </tr></thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                    No source POs in this tab. {active !== "open" && <button type="button" onClick={() => setActive("open")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show open</button>}
                  </td></tr>
                ) : filtered.map((po) => {
                  const ccy = spoCurrency(po);
                  const chip = SPO_STATUS_CHIP[po.status] || { label: (po.status || "—").toLowerCase(), k: "ghost" };
                  return (
                    <tr
                      key={po.id}
                      onClick={() => openAck(po)}
                      tabIndex={0}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openAck(po); } }}
                      style={{ cursor: "pointer" }}
                      aria-label={`Open ack for ${po.po_reference || po.id}`}
                    >
                      <td className="mono"><span className="pri">{po.reference || po.id?.slice(0, 8) || "—"}</span></td>
                      <td>{po.supplier || "—"}</td>
                      <td className="mono-sm">{po.country || "—"}</td>
                      <td className="mono-sm">{ccy}</td>
                      <td className="r mono">{spoFmtValue(po.total_foreign != null ? po.total_foreign : (po.total_inr != null ? po.total_inr : po.total_landed_inr), ccy)}</td>
                      <td className="mono-sm">{spoFmtDate(po.acknowledged_eta)}</td>
                      <td><Chip k={chip.k}>{chip.label}</Chip></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Btn sm onClick={(ev) => { ev.stopPropagation(); openAck(po); }}>ack {Icon.arrowR}</Btn>{" "}
                        <Btn sm kind="ghost" onClick={(ev) => { ev.stopPropagation(); openReceive(po); }}>receive</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {ackPo ? (
            <Card title={`Record ack · ${ackPo.reference || ackPo.id?.slice(0, 8) || ""}`} eyebrow={ackPo.supplier || ""}
                  right={<Btn sm kind="ghost" onClick={closeAck} title="Close">{Icon.x}</Btn>}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label htmlFor="spo-ack-price" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Acked total ({spoCurrency(ackPo)})</label>
                  <input
                    id="spo-ack-price"
                    className="input"
                    type="number"
                    step="0.01"
                    value={ackForm.acked_unit_price}
                    onChange={(ev) => setAckForm((f) => ({ ...f, acked_unit_price: ev.target.value }))}
                    style={{ width: "100%", height: 30 }}
                  />
                </div>
                <div>
                  <label htmlFor="spo-ack-eta" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Acked ETA</label>
                  <input
                    id="spo-ack-eta"
                    className="input"
                    type="date"
                    value={ackForm.acked_eta_date}
                    onChange={(ev) => setAckForm((f) => ({ ...f, acked_eta_date: ev.target.value }))}
                    style={{ width: "100%", height: 30 }}
                  />
                </div>
                <div>
                  <label htmlFor="spo-ack-qty" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Acked qty</label>
                  <input
                    id="spo-ack-qty"
                    className="input"
                    type="number"
                    value={ackForm.acked_qty}
                    onChange={(ev) => setAckForm((f) => ({ ...f, acked_qty: ev.target.value }))}
                    style={{ width: "100%", height: 30 }}
                  />
                </div>
                <div>
                  <label htmlFor="spo-ack-notes" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Notes</label>
                  <textarea
                    id="spo-ack-notes"
                    className="input"
                    value={ackForm.notes}
                    onChange={(ev) => setAckForm((f) => ({ ...f, notes: ev.target.value }))}
                    style={{ width: "100%", minHeight: 60, padding: 6 }}
                  />
                </div>
                {submitErr && (
                  <div className="mono-sm" style={{ color: "var(--rust)" }}>
                    {String(submitErr.message || submitErr)}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Btn sm kind="ghost" onClick={closeAck}>Cancel</Btn>
                  <Btn sm kind="primary" disabled={submitting} onClick={submitAck}>{submitting ? "Saving…" : "Submit ack"}</Btn>
                </div>
              </div>
            </Card>
          ) : receivePo ? (
            <Card title={`Receive goods · ${receivePo.reference || receivePo.id?.slice(0, 8) || ""}`} eyebrow={receivePo.supplier || "record a GRN"}
                  right={<Btn sm kind="ghost" onClick={closeReceive} title="Close">{Icon.x}</Btn>}>
              {receiveErr && (
                <div className="mono-sm" style={{ color: "var(--rust)", marginBottom: 8 }}>{String(receiveErr.message || receiveErr)}</div>
              )}
              {receiveLines.length === 0 ? (
                <div className="mono-sm" style={{ color: "var(--ink-4)" }}>
                  No relational lines to receive against. (Only source POs released with line detail can be received here.)
                </div>
              ) : (
                <>
                  <table className="tbl" style={{ fontSize: 12 }}>
                    <thead><tr>
                      <th>#</th><th>Part</th><th className="r">Ordered</th><th className="r">Received</th><th className="r">Outstanding</th><th className="r">Receive now</th>
                    </tr></thead>
                    <tbody>
                      {receiveLines.map((ln: any) => {
                        const ordered = Number(ln.qty) || 0;
                        const got = Number(ln.received_qty) || 0;
                        const outstanding = Math.max(0, ordered - got);
                        return (
                          <tr key={ln.line_index}>
                            <td className="mono">{ln.line_index}</td>
                            <td>{ln.part_no || "—"}</td>
                            <td className="r mono">{ordered}</td>
                            <td className="r mono">{got}</td>
                            <td className="r mono">{outstanding}</td>
                            <td className="r">
                              <input className="input mono" type="number" min="0" step="any"
                                     value={receiveInputs[String(ln.line_index)] ?? ""}
                                     placeholder={String(outstanding)}
                                     onChange={(ev) => setReceiveInputs((m) => ({ ...m, [String(ln.line_index)]: ev.target.value }))}
                                     style={{ width: 90, height: 28 }} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 10 }}>
                    <label htmlFor="spo-grn-note" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Note (optional)</label>
                    <input id="spo-grn-note" className="input" value={receiveNote} onChange={(ev) => setReceiveNote(ev.target.value)} style={{ width: "100%", height: 30 }} />
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                    <Btn sm kind="ghost" onClick={closeReceive}>Cancel</Btn>
                    <Btn sm kind="primary" disabled={receiveBusy} onClick={submitReceive}>{receiveBusy ? "Recording…" : "Record receipt"}</Btn>
                  </div>
                </>
              )}
            </Card>
          ) : (
            <Card title="Supplier scorecards" eyebrow="A/B/C grades">
              {scorecard.loading ? (
                <div className="body">Loading…</div>
              ) : scorecardRows.length === 0 ? (
                <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No scorecards yet.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Supplier</th>
                    <th>Grade</th>
                    <th className="r">On-time</th>
                    <th className="r">Defect</th>
                  </tr></thead>
                  <tbody>
                    {scorecardRows.slice(0, 8).map((s) => {
                      // on_time_pct + price_accuracy_pct are stored 0-100
                      // (source_pos/ack.js), not 0-1 fractions.
                      const onTimePct = s.on_time_pct != null ? Number(s.on_time_pct) : null;
                      const grade = s.grade || (onTimePct == null ? "—" : onTimePct >= 90 ? "A" : onTimePct >= 75 ? "B" : "C");
                      const defectPct = s.defect_rate_pct != null
                        ? Number(s.defect_rate_pct) * 100
                        : (s.total_acks ? (Number(s.variance_count || 0) / Number(s.total_acks)) * 100 : null);
                      return (
                        <tr key={s.id || s.supplier}>
                          <td>{s.supplier || "—"}</td>
                          <td><Chip k={grade === "A" || grade === "A+" ? "good" : grade === "B" ? "warn" : "bad"}>{grade}</Chip></td>
                          <td className="r mono">{onTimePct != null ? `${onTimePct.toFixed(0)}%` : "—"}</td>
                          <td className="r mono">{defectPct != null ? `${defectPct.toFixed(1)}%` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
};



export default WiredSourcePOs;
