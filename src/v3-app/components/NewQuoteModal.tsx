import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Modal } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

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
//
// The quote can name the opportunity it is for (quotes.opportunity_id).
// The picker lists the chosen customer's open opportunities. Opened from
// an opportunity, the modal starts with that customer and opportunity.

interface Customer {
  id: string;
  customer_name?: string | null;
  customer_key?: string | null;
  default_quote_validity_days?: number | null;
  currency?: string | null;
}

// Stages after which an opportunity takes no new quote by default.
const CLOSED_STAGES = new Set(["CLOSE_WON", "CLOSE_LOST", "REGRETTED"]);

export const NewQuoteModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: (quote: any) => void;
  // Opened from an opportunity: start with its customer and itself.
  initialCustomerId?: string | null;
  initialOpportunityId?: string | null;
}> = ({ open, onClose, onCreated, initialCustomerId, initialOpportunityId }) => {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [query, setQuery] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [validityDays, setValidityDays] = useState(30);
  // Reference contact from the customer's contact master. Loaded after a
  // customer is picked; defaults to the customer's primary contact.
  const [contacts, setContacts] = useState<any[] | null>(null);
  const [contactId, setContactId] = useState("");
  // The customer's open opportunities, loaded after a customer is picked.
  const [opps, setOpps] = useState<any[] | null>(null);
  const [oppId, setOppId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A customer's own currency and validity, when it has them.
  const adoptCustomerDefaults = (list: Customer[] | null, id: string) => {
    const c: any = (list || []).find((x) => x.id === id);
    if (c?.default_quote_validity_days) setValidityDays(Number(c.default_quote_validity_days));
    if (c?.currency) setCurrency(String(c.currency).toUpperCase());
  };

  // Load the customer list once when the modal opens. Reset the form
  // each time it reopens so a prior selection does not leak in.
  useEffect(() => {
    if (!open) return;
    setCustomerId(initialCustomerId || "");
    setQuery("");
    setCurrency("INR");
    setValidityDays(30);
    setContacts(null);
    setContactId("");
    setOpps(null);
    setOppId(initialOpportunityId || "");
    setErr(null);
    setCustomers(null);
    // Seed validity from the tenant default (Admin > Settings) before any
    // customer is picked. A customer's own default overrides this in pick().
    const tenantDefault = Promise.resolve(AnvilBackend?.admin?.quoteSettings?.())
      .then((r: any) => { const v = r?.quote_default_validity_days; if (v != null) setValidityDays(Number(v)); })
      .catch(() => { /* keep the 30-day default */ });
    Promise.resolve(AnvilBackend?.customers?.list?.())
      .then(async (data: any) => {
        const list = Array.isArray(data) ? data : data?.customers || [];
        setCustomers(list);
        // Opened for a known customer: its defaults land after the tenant
        // default, so the customer's own value wins, as it does in pick().
        if (initialCustomerId) { await tenantDefault; adoptCustomerDefaults(list, initialCustomerId); }
      })
      .catch((e: any) => setErr(e?.message || String(e)));
  }, [open, initialCustomerId, initialOpportunityId]);

  // When a customer is picked, list its open opportunities. The one the
  // modal was opened from stays listed whatever its stage. A single open
  // opportunity is preselected; the operator can still pick "No opportunity".
  useEffect(() => {
    setOpps(null);
    if (!open || !customerId) return;
    let cancelled = false;
    (async () => {
      let list: any[];
      try {
        const resp: any = await AnvilBackend?.sales?.listOpportunities?.({ customer_id: customerId });
        const all = Array.isArray(resp) ? resp : resp?.opportunities || [];
        list = all.filter((o: any) => o?.id
          && (!o.customer_id || String(o.customer_id) === String(customerId))
          && (!CLOSED_STAGES.has(o.stage) || o.id === initialOpportunityId));
      } catch {
        // Keep the opportunity the modal was opened from; the server checks it.
        list = initialOpportunityId && customerId === initialCustomerId ? [{ id: initialOpportunityId }] : [];
      }
      if (cancelled) return;
      setOpps(list);
      setOppId((cur) => {
        if (cur && list.some((o) => o.id === cur)) return cur;
        return list.length === 1 ? list[0].id : "";
      });
    })();
    return () => { cancelled = true; };
  }, [open, customerId, initialCustomerId, initialOpportunityId]);

  // When a customer is picked, fetch that customer's contacts and
  // default the picker to the primary contact (if any). Best-effort:
  // if the lookup fails the operator can still create the quote.
  useEffect(() => {
    if (!open || !customerId) { setContacts(null); setContactId(""); return; }
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await AnvilBackend?.customers?.listContacts?.({ customer_id: customerId });
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

  // When a customer is chosen, adopt its currency + default quote
  // validity if set. The POST handler does the same fallback server-
  // side (and records `quote_auto_populate` in the audit), so this
  // preview just keeps the modal honest.
  const pick = (id: string) => {
    setCustomerId(id);
    adoptCustomerDefaults(customers, id);
  };

  const create = async () => {
    if (!customerId) { setErr("Pick a customer first."); return; }
    setBusy(true);
    setErr(null);
    try {
      const resp: any = await AnvilBackend?.quotes?.create?.({
        customer_id: customerId,
        customer_contact_id: contactId || null,
        opportunity_id: oppId || null,
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

        {customerId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Opportunity</label>
            <select
              className="select"
              aria-label="Opportunity"
              value={oppId}
              onChange={(e) => setOppId(e.target.value)}
            >
              <option value="">
                {opps == null ? "Loading opportunities..." : opps.length === 0 ? "No open opportunities" : "No opportunity"}
              </option>
              {(opps || []).map((o: any) => (
                <option key={o.id} value={o.id}>
                  {(o.opportunity_name || o.name || o.id.slice(0, 8)) + (o.stage ? " - " + o.stage : "")}
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
