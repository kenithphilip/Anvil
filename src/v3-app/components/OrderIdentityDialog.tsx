// Fix an order's customer, PO number and PO date (plan PR 7).
//
// Opened from the "change" links on the SO workspace's summary strip, and from
// the "No customer on the order" exception row. The customer picker is the
// intake's: the tenant's customers by name with their GSTIN, narrowed by a
// search box as in the new-quote dialog. The server allows the change only
// while the order is DRAFT or PENDING_REVIEW, checks the customer is this
// tenant's, re-maps the lines and re-runs the quote reconcile, and audits it.
// Only the fields that changed are sent.

import React, { useEffect, useMemo, useState } from "react";
import { Btn, Modal } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

export interface IdentityOrder {
  id: string;
  status?: string | null;
  customer_id?: string | null;
  po_number?: string | null;
  po_date?: string | null;
}

interface CustomerRow { id: string; customer_name?: string | null; gstin?: string | null }

// The statuses the server accepts the change in (_lib/order-identity.js).
export const IDENTITY_EDITABLE = new Set(["DRAFT", "PENDING_REVIEW"]);

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "");

export const OrderIdentityDialog: React.FC<{
  open: boolean;
  order: IdentityOrder;
  onClose: () => void;
  onSaved: () => void;
}> = ({ open, order, onClose, onSaved }) => {
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [poDate, setPoDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCustomerId(order.customer_id || "");
    setPoNumber(order.po_number || "");
    setPoDate(day(order.po_date));
    setReason("");
    setQuery("");
    setErr(null);
    setCustomers(null);
    let cancelled = false;
    Promise.resolve(AnvilBackend?.customers?.list?.())
      .then((data: any) => {
        if (cancelled) return;
        setCustomers(Array.isArray(data) ? data : data?.customers || []);
      })
      .catch((e: any) => { if (!cancelled) setErr("Could not load customers: " + (e?.message || String(e))); });
    return () => { cancelled = true; };
  }, [open, order.id, order.customer_id, order.po_number, order.po_date]);

  const filtered = useMemo(() => {
    const list = customers || [];
    const v = query.trim().toLowerCase();
    if (!v) return list;
    // Keep the current pick listed so the select never loses its value.
    return list.filter((c) => c.id === customerId
      || String(c.customer_name || "").toLowerCase().includes(v)
      || String(c.gstin || "").toLowerCase().includes(v));
  }, [customers, query, customerId]);

  const body: Record<string, unknown> = {};
  if (customerId && customerId !== (order.customer_id || "")) body.customer_id = customerId;
  if (poNumber.trim() !== (order.po_number || "")) body.po_number = poNumber.trim() || null;
  if (poDate !== day(order.po_date)) body.po_date = poDate || null;
  const changed = Object.keys(body).length > 0;

  const save = async () => {
    if (!changed) return;
    setBusy(true);
    setErr(null);
    try {
      await AnvilBackend?.orders?.update?.(order.id, { ...body, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      window.notifySuccess?.("Order updated", "customer_id" in body
        ? "Customer changed. The lines were re-mapped and checked against the new customer's quotes."
        : "PO details saved.");
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const editable = IDENTITY_EDITABLE.has(String(order.status || ""));

  return (
    <Modal open={open} onClose={onClose} title="Customer and PO details">
      <Modal.Body>
        {!editable && (
          <p className="mono-sm" style={{ margin: 0, color: "var(--rust)" }}>
            This order is {order.status}. The customer, PO number and PO date can be changed only while it is DRAFT or PENDING_REVIEW.
          </p>
        )}
        <label className="mono-sm" htmlFor="order-identity-customer" style={{ color: "var(--ink-3)" }}>Customer</label>
        <input
          className="input"
          aria-label="Search customers"
          placeholder="Search by name or GSTIN"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!editable}
        />
        <select
          id="order-identity-customer"
          className="select"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          disabled={!editable || customers == null}
        >
          <option value="">{customers == null ? "Loading customers..." : filtered.length === 0 ? "No customers found" : "Select a customer"}</option>
          {filtered.map((c) => (
            <option key={c.id} value={c.id}>
              {c.customer_name || c.id.slice(0, 8)}{c.gstin ? ` · ${c.gstin}` : ""}
            </option>
          ))}
        </select>
        <label className="mono-sm" htmlFor="order-identity-po" style={{ color: "var(--ink-3)" }}>PO number</label>
        <input id="order-identity-po" className="input" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} disabled={!editable} />
        <label className="mono-sm" htmlFor="order-identity-date" style={{ color: "var(--ink-3)" }}>PO date</label>
        <input id="order-identity-date" className="input" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} disabled={!editable} />
        <label className="mono-sm" htmlFor="order-identity-reason" style={{ color: "var(--ink-3)" }}>Why (optional, kept in the audit)</label>
        <input id="order-identity-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!editable} />
        {"customer_id" in body && (
          <p className="mono-sm" style={{ margin: 0, color: "var(--ink-3)" }}>
            A new customer re-maps the lines to that customer's part codes and checks them against that customer's quotes.
          </p>
        )}
        {err && <p className="mono-sm" role="alert" style={{ margin: 0, color: "var(--rust)" }}>{err}</p>}
      </Modal.Body>
      <Modal.Footer>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={!editable || !changed || busy} onClick={save}>{busy ? "Saving..." : "Save"}</Btn>
      </Modal.Footer>
    </Modal>
  );
};

export default OrderIdentityDialog;
