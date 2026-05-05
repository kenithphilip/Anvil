import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// ============================================================
// ANVIL v3 — e-Invoice CRUD overlay
// Adds compose-draft form + Send to GSTN action on top of the
// read-only queue in wired-einvoice-d.jsx.
// ============================================================

const EI_STATUSES = [
  { id: "all",          label: "All",        match: () => true },
  { id: "DRAFT",        label: "Draft",      match: (e) => e.status === "DRAFT" },
  { id: "PENDING_GSTN", label: "Pending",    match: (e) => e.status === "PENDING_GSTN" },
  { id: "GENERATED",    label: "Generated",  match: (e) => e.status === "GENERATED" },
  { id: "CANCELLED",    label: "Cancelled",  match: (e) => e.status === "CANCELLED" },
  { id: "REJECTED",     label: "Rejected",   match: (e) => e.status === "REJECTED" },
];

const EI_FORM_BLANK = () => ({
  order_id: "",
  invoice_number: "",
  invoice_date: new Date().toISOString().slice(0, 10),
  seller_gstin: "",
  buyer_gstin: "",
  total_value_inr: "",
  notes: "",
});

const eiReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
};

const eiFetch = async (path: string, opts: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
  const cfg: any = (ObaraBackend?.getConfig?.() || {});
  const session: any = (ObaraBackend?.getSession?.() || null);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string> || {}) };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = (cfg.url || "").replace(/\/+$/, "") + path;
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
  return resp.json();
};

const WiredEinvoiceCRUD = () => {
  const { useState: u, useEffect: e } = React;
  const params = eiReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";

  const [list, setList] = u({ rows: [], loading: true, error: null });
  const [orders, setOrders] = u([]);
  const [active, setActive] = u("all");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [busy, setBusy] = u(false);

  const reload = () => {
    setList((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.einvoice?.list?.() || eiFetch("/api/einvoice"))
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.einvoices || r?.rows || []);
        setList({ rows, loading: false, error: null });
      })
      .catch((err) => setList({ rows: [], loading: false, error: err }));
  };

  e(reload, []);
  e(() => {
    Promise.resolve(ObaraBackend?.orders?.list?.({ limit: 200 }) || [])
      .then((r) => setOrders(Array.isArray(r) ? r : (r?.rows || [])));
  }, []);

  e(() => {
    if (isNew) {
      setForm(EI_FORM_BLANK());
      setEditing("__new__");
      return;
    }
    if (editId) {
      const found = list.rows.find((r) => r.id === editId);
      if (found) {
        setForm({ ...EI_FORM_BLANK(), ...found });
        setEditing(editId);
      }
      return;
    }
    setForm(null);
    setEditing(null);
  }, [editId, isNew, list.rows.length]);

  const closeForm = () => {
    setForm(null);
    setEditing(null);
    window.location.hash = "#/einvoice";
  };

  const submit = async () => {
    if (!form) return;
    if (!form.invoice_number?.trim()) {
      window.notifyError?.("Invoice number is required");
      return;
    }
    setBusy(true);
    try {
      const payload = { ...form };
      if (payload.total_value_inr) payload.total_value_inr = Number(payload.total_value_inr);
      if (editing && editing !== "__new__") payload.id = editing;
      const result = await eiFetch("/api/einvoice", {
        method: editing && editing !== "__new__" ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      window.notifySuccess?.(editing === "__new__" ? "Draft saved" : "Invoice updated", form.invoice_number);
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Save failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendToGstn = async (id, num) => {
    if (!RBAC?.canDo?.("einvoice.generate")) {
      window.notifyError?.("Permission denied", "einvoice.generate role required");
      return;
    }
    setBusy(true);
    try {
      // The backend expects PATCH with action=submit per einvoice/index.js convention.
      const result = await eiFetch("/api/einvoice", {
        method: "PATCH",
        body: JSON.stringify({ id, action: "submit_to_gstn" }),
      });
      window.notifySuccess?.("Sent to GSTN", num + " · IRN " + (result?.irn || "pending"));
      reload();
    } catch (err) {
      window.notifyError?.("Send to GSTN failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id, num) => {
    if (!window.confirm(`Cancel invoice ${num}? Within the 24h GSTN window only.`)) return;
    setBusy(true);
    try {
      await eiFetch("/api/einvoice", {
        method: "PATCH",
        body: JSON.stringify({ id, action: "cancel", cancel_reason: "User-initiated" }),
      });
      window.notifySuccess?.("Cancellation requested", num);
      reload();
    } catch (err) {
      window.notifyError?.("Cancel failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, num) => {
    if (!window.confirm(`Delete draft invoice ${num}?`)) return;
    setBusy(true);
    try {
      await eiFetch("/api/einvoice?id=" + encodeURIComponent(id), { method: "DELETE" });
      window.notifySuccess?.("Deleted", num);
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Delete failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const matcher = EI_STATUSES.find((t) => t.id === active)?.match || (() => true);
  const filtered = list.rows.filter(matcher);
  const counts = Object.fromEntries(EI_STATUSES.map((t) => [t.id, list.rows.filter(t.match).length]));

  // 24h cancel window helper
  const within24h = (iso) => {
    if (!iso) return false;
    return Date.now() - new Date(iso).getTime() < 24 * 3600 * 1000;
  };

  const orderRef = (id) => orders.find((o) => o.id === id)?.po_number || orders.find((o) => o.id === id)?.quote_number || (id ? id.slice(0, 8) : "—");

  return (
    <>
      <WSTitle
        eyebrow="Finance · e-Invoice"
        title="GSTN e-Invoices"
        meta={`${list.rows.length} total · ${counts.PENDING_GSTN || 0} pending · ${counts.GENERATED || 0} generated`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/einvoice?new=1"}>{Icon.plus} New invoice</Btn>
        </>}
      />
      <WSTabs tabs={EI_STATUSES.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} active={active} onChange={setActive} />

      <div className="ws-content">
        {list.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load invoices"
                  action={<Btn sm onClick={reload}>retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        )}

        {form && (
          <Card title={editing === "__new__" ? "New invoice draft" : "Edit invoice " + form.invoice_number}
                eyebrow="form"
                right={<Btn sm icon kind="ghost" onClick={closeForm} aria-label="Close">{Icon.x}</Btn>}>
            <div className="form-grid">
              <div>
                <label htmlFor="ei-num" className="label">Invoice number *</label>
                <input id="ei-num" className="input mono" value={form.invoice_number} onChange={(ev) => setForm({ ...form, invoice_number: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="ei-date" className="label">Invoice date</label>
                <input id="ei-date" type="date" className="input mono" value={form.invoice_date} onChange={(ev) => setForm({ ...form, invoice_date: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="ei-order" className="label">Order *</label>
                <select id="ei-order" className="select" value={form.order_id} onChange={(ev) => setForm({ ...form, order_id: ev.target.value })}>
                  <option value="">Pick order…</option>
                  {orders.filter((o) => o.status === "APPROVED" || o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED").map((o) => (
                    <option key={o.id} value={o.id}>{o.po_number || o.quote_number || o.id.slice(0, 8)} · {o.customer?.customer_name || "—"}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ei-seller" className="label">Seller GSTIN</label>
                <input id="ei-seller" className="input mono" value={form.seller_gstin} onChange={(ev) => setForm({ ...form, seller_gstin: ev.target.value })} placeholder="15-char GSTIN" />
              </div>
              <div>
                <label htmlFor="ei-buyer" className="label">Buyer GSTIN</label>
                <input id="ei-buyer" className="input mono" value={form.buyer_gstin} onChange={(ev) => setForm({ ...form, buyer_gstin: ev.target.value })} placeholder="15-char GSTIN" />
              </div>
              <div>
                <label htmlFor="ei-value" className="label">Total value INR</label>
                <input id="ei-value" type="number" className="input mono" value={form.total_value_inr || ""} onChange={(ev) => setForm({ ...form, total_value_inr: ev.target.value })} />
              </div>
              <div className="span-2">
                <label htmlFor="ei-notes" className="label">Notes</label>
                <textarea id="ei-notes" className="input" rows={2} value={form.notes || ""} onChange={(ev) => setForm({ ...form, notes: ev.target.value })} />
              </div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <Btn kind="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : editing === "__new__" ? "Save draft" : "Save"}</Btn>
              {editing && editing !== "__new__" && form.status === "DRAFT" && (
                <Btn kind="live" disabled={busy} onClick={() => sendToGstn(editing, form.invoice_number)}>{Icon.send} Send to GSTN</Btn>
              )}
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              <span style={{ flex: 1 }} />
              {editing && editing !== "__new__" && (
                <Btn kind="danger" disabled={busy} onClick={() => remove(editing, form.invoice_number)}>{Icon.x} Delete</Btn>
              )}
            </div>
            {editing && editing !== "__new__" && form.status === "GENERATED" && (
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <Chip k="good">IRN {form.irn || "(present)"}</Chip>
                {within24h(form.generated_at) && (
                  <Btn sm kind="danger" disabled={busy} onClick={() => cancel(editing, form.invoice_number)}>{Icon.x} Cancel within 24h</Btn>
                )}
              </div>
            )}
          </Card>
        )}

        <Card flush>
          {list.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {list.rows.length === 0 ? "No invoices yet." :
                <>No invoices in this view. <button type="button" onClick={() => setActive("all")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</button></>}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Invoice #</th>
                <th>IRN</th>
                <th>Order</th>
                <th>Buyer GSTIN</th>
                <th className="r">Value</th>
                <th>Status</th>
                <th>Date</th>
                <th></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const k = r.status === "GENERATED" ? "good" : r.status === "REJECTED" ? "bad" : r.status === "CANCELLED" ? "ghost" : r.status === "PENDING_GSTN" ? "warn" : "info";
                  const inWindow = r.status === "GENERATED" && within24h(r.generated_at || r.created_at);
                  return (
                    <tr key={r.id}>
                      <td className="mono"><span className="pri">{r.invoice_number}</span></td>
                      <td className="mono-sm">{r.irn || "—"}</td>
                      <td className="mono-sm">{orderRef(r.order_id)}</td>
                      <td className="mono-sm">{r.buyer_gstin || "—"}</td>
                      <td className="r mono">{r.total_value_inr ? "₹ " + Number(r.total_value_inr).toLocaleString("en-IN") : "—"}</td>
                      <td><Chip k={k}>{(r.status || "—").toLowerCase().replace(/_/g, " ")}</Chip></td>
                      <td className="mono-sm">{(r.invoice_date || "").slice(0, 10) || "—"}</td>
                      <td>
                        <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                          <Btn sm kind="ghost" onClick={() => window.location.hash = `#/einvoice?id=${r.id}`}>{Icon.eye}</Btn>
                          {r.status === "DRAFT" && (
                            <Btn sm kind="live" onClick={() => sendToGstn(r.id, r.invoice_number)} disabled={busy} title="Send to GSTN">{Icon.send}</Btn>
                          )}
                          {inWindow && (
                            <Btn sm kind="ghost" onClick={() => cancel(r.id, r.invoice_number)} disabled={busy} title="Cancel within 24h">{Icon.x}</Btn>
                          )}
                          {r.status === "DRAFT" && (
                            <Btn sm kind="ghost" onClick={() => remove(r.id, r.invoice_number)} disabled={busy}>{Icon.x}</Btn>
                          )}
                        </div>
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


export default WiredEinvoiceCRUD;
