import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Modal } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";

// New-quote-from-scratch modal.
//
// The quote backend (migration 068 + /api/quotes) and the editor
// drawer already existed, but the only way to give birth to a quote
// was to convert an order. This modal is the missing entry point:
// pick a customer, set currency + validity, and POST a DRAFT. The
// caller then drops the operator straight into the detail drawer to
// add lines (item-master picker + per-line source country).
//
// Only `customer_id` is required server-side; everything else has a
// sensible default. Validity prefills from the customer's
// default_quote_validity_days when present.

interface Customer {
  id: string;
  customer_name?: string | null;
  customer_key?: string | null;
  default_quote_validity_days?: number | null;
}

export const NewQuoteModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: (quote: any) => void;
}> = ({ open, onClose, onCreated }) => {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [query, setQuery] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [validityDays, setValidityDays] = useState(30);
  // Reference contact from the customer's contact master. Loaded after a
  // customer is picked; defaults to the customer's primary contact.
  const [contacts, setContacts] = useState<any[] | null>(null);
  const [contactId, setContactId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load the customer list once when the modal opens. Reset the form
  // each time it reopens so a prior selection does not leak in.
  useEffect(() => {
    if (!open) return;
    setCustomerId("");
    setQuery("");
    setCurrency("INR");
    setValidityDays(30);
    setContacts(null);
    setContactId("");
    setErr(null);
    setCustomers(null);
    Promise.resolve(ObaraBackend?.customers?.list?.())
      .then((data: any) => setCustomers(Array.isArray(data) ? data : data?.customers || []))
      .catch((e: any) => setErr(e?.message || String(e)));
  }, [open]);

  // When a customer is picked, fetch that customer's contacts and
  // default the picker to the primary contact (if any). Best-effort:
  // if the lookup fails the operator can still create the quote.
  useEffect(() => {
    if (!open || !customerId) { setContacts(null); setContactId(""); return; }
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await ObaraBackend?.customers?.listContacts?.({ customer_id: customerId });
        if (cancelled) return;
        const list = Array.isArray(resp) ? resp : resp?.contacts || [];
        setContacts(list);
        const primary = list.find((c: any) => c.is_primary) || list[0];
        if (primary?.id) setContactId(primary.id);
      } catch { /* contacts are optional */ }
    })();
    return () => { cancelled = true; };
  }, [open, customerId]);

  const filtered = useMemo(() => {
    const list = customers || [];
    if (!query) return list;
    const v = query.toLowerCase();
    return list.filter((c) =>
      (c.customer_name || "").toLowerCase().includes(v) ||
      (c.customer_key || "").toLowerCase().includes(v));
  }, [customers, query]);

  // When a customer is chosen, adopt its default quote validity if set.
  const pick = (id: string) => {
    setCustomerId(id);
    const c = (customers || []).find((x) => x.id === id);
    if (c?.default_quote_validity_days) setValidityDays(Number(c.default_quote_validity_days));
  };

  const create = async () => {
    if (!customerId) { setErr("Pick a customer first."); return; }
    setBusy(true);
    setErr(null);
    try {
      const resp: any = await ObaraBackend?.quotes?.create?.({
        customer_id: customerId,
        customer_contact_id: contactId || null,
        currency: currency || "INR",
        validity_days: Number(validityDays) || 30,
      });
      const quote = resp?.quote || resp;
      if (!quote?.id) throw new Error("Quote was not created");
      window.notifySuccess?.("Quote created", quote.quote_number || quote.id?.slice(0, 8));
      onCreated(quote);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErr(msg);
      window.notifyError?.("Could not create quote", msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New quote" maxWidth={520}>
      <Modal.Body>
        {err && <Banner kind="bad" title="Could not create quote">{err}</Banner>}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Customer</label>
          <input
            className="input"
            placeholder="search customer name or key..."
            aria-label="Search customers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="select"
            aria-label="Customer"
            value={customerId}
            onChange={(e) => pick(e.target.value)}
            style={{ marginTop: 6 }}
          >
            <option value="">
              {customers == null ? "Loading customers..." : filtered.length === 0 ? "No customers found" : "Select a customer"}
            </option>
            {filtered.map((c) => (
              <option key={c.id} value={c.id}>
                {c.customer_name || c.customer_key || c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>

        {customerId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Contact (from customer master)</label>
            <select
              className="select"
              aria-label="Contact"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">
                {contacts == null ? "Loading contacts..." : contacts.length === 0 ? "No contacts on file" : "No contact"}
              </option>
              {(contacts || []).map((c: any) => (
                <option key={c.id} value={c.id}>
                  {(c.name || c.email || c.id.slice(0, 8)) + (c.is_primary ? " [primary]" : "") + (c.role ? " - " + c.role : "")}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="row" style={{ gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Currency</label>
            <input
              className="input mono"
              aria-label="Currency"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              style={{ width: 90 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Validity (days)</label>
            <input
              className="input mono r"
              aria-label="Validity days"
              type="number"
              value={validityDays}
              onChange={(e) => setValidityDays(Number(e.target.value))}
              style={{ width: 110 }}
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={busy || !customerId} onClick={create}>
          {busy ? "Creating..." : "Create draft"}
        </Btn>
      </Modal.Footer>
    </Modal>
  );
};

export default NewQuoteModal;
