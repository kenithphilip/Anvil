import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { QuoteComposition } from "./QuoteComposition";
import { QuoteHistoryTab } from "./QuoteHistoryTab";
import { QuoteRfqTab } from "./QuoteRfqTab";

// Quote detail drawer.
//
// Mounts on top of the quotes list when an operator clicks a quote
// row. Surfaces the four quote-header partials from the audit
// (your_ref, attention_contact, template picker / form code,
// validity) plus a per-line editor. Lines capture identity + qty/units/
// source country only (sourced from the item master); pricing, source
// selection and overheads are decided later at the Composition stage.
//
// Schema backing the drawer:
//   - `quotes.your_ref`, `attention_contact`, `template_id`,
//     `fx_snapshot`, `conversion_factor` from migration 106
//   - `quote_lines` proper table from migration 108
//   - `document_templates` from migration 106 for the picker
//
// Each tab posts to its own endpoint so partial saves are safe.

type Quote = any;
type Line = any;
type Template = any;

const fetchJson = async (path: string, opts?: RequestInit) => {
  const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
  const session: any = (AnvilBackend as any)?.getSession?.() || null;
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers: any = { "Content-Type": "application/json", ...(opts?.headers as any || {}) };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + path;
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("HTTP " + resp.status + (text ? ": " + text.slice(0, 200) : ""));
  }
  return resp.json();
};

const TabBtn: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button type="button" onClick={onClick} style={{
    padding: "8px 12px", fontFamily: "var(--mono)", fontSize: 11,
    letterSpacing: "0.04em", textTransform: "uppercase", border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    background: "transparent", color: active ? "var(--ink)" : "var(--ink-3)",
    cursor: "pointer", fontWeight: 600,
  }}>{children}</button>
);

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string; provenance?: React.ReactNode }> = ({ label, children, hint, provenance }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <label className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</label>
      {provenance}
    </div>
    {children}
    {hint && <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{hint}</span>}
  </div>
);

// Renders a small provenance chip next to a header field label, sourced
// from quotes.field_sources (migration 138 / PR 2A). Maps source
// strings to a human label; raw source goes on the chip's tooltip.
const ProvenancePill: React.FC<{ source?: string | null }> = ({ source }) => {
  if (!source) return null;
  const label = source.startsWith("customer.") ? "from customer"
    : source.startsWith("opportunity.") ? "from opportunity"
    : source === "operator_override" ? "edited"
    : source === "template" ? "from template"
    : null;
  if (!label) return null;
  const tone = source === "operator_override" ? "info" : "ghost";
  return <span title={source}><Chip k={tone}>{label}</Chip></span>;
};

export const QuoteDetailDrawer: React.FC<{
  quote: Quote;
  onClose: () => void;
  onSaved?: () => void;
  // Controlled tab (deep-link + keyboard nav from the Quotes screen). When
  // omitted the drawer manages its own tab state.
  tab?: string;
  onTab?: (t: string) => void;
}> = ({ quote, onClose, onSaved, tab: tabProp, onTab }) => {
  const [tabState, setTabState] = useState<string>("header");
  const tab = tabProp != null ? tabProp : tabState;
  const setTab = (t: string) => { onTab ? onTab(t) : setTabState(t); };
  // Keep heavy data tabs mounted once visited so switching back is instant
  // (no refetch). Light tabs (header/lines/terms) are state-backed already.
  const [visited, setVisited] = useState<Set<string>>(() => new Set([tab]));
  useEffect(() => { setVisited((s) => (s.has(tab) ? s : new Set(s).add(tab))); }, [tab]);
  const [draft, setDraft] = useState<Quote>({ ...quote });
  const [lines, setLines] = useState<Line[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  // Item-master picker: lets the operator append a quote line straight
  // from the item master so the line carries the catalogue part_no,
  // HSN, source country and tax rates. This makes the quote a usable
  // reference for downstream PO-price / source-country matching.
  const [picking, setPicking] = useState(false);
  const [items, setItems] = useState<any[] | null>(null);
  const [itemQuery, setItemQuery] = useState("");
  // Reference contact from the customer's contact master. Drives the
  // recipient on send and seeds attention_contact for the printed quote.
  const [contacts, setContacts] = useState<any[] | null>(null);
  // Inline "create contact" form, shown when the customer has no suitable
  // contact on file (or the operator wants to add one). Writes straight to
  // the customer contact master so the new person is reusable everywhere.
  const [addingContact, setAddingContact] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [newContact, setNewContact] = useState<{ name: string; email: string; phone: string; role: string; is_primary: boolean }>(
    { name: "", email: "", phone: "", role: "", is_primary: false }
  );
  // Admin-defined option lists for line-item dropdowns (Admin > Settings).
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [linesResp, templatesResp, contactsResp, quoteSettings] = await Promise.all([
          fetchJson("/api/admin/quote_lines?quote_id=" + quote.id).catch(() => ({ lines: [] })),
          fetchJson("/api/admin/document_templates?doc_type=quotation").catch(() => ({ templates: [] })),
          quote.customer_id
            ? Promise.resolve((AnvilBackend as any)?.customers?.listContacts?.({ customer_id: quote.customer_id }))
                .then((r: any) => Array.isArray(r) ? { contacts: r } : (r || { contacts: [] }))
                .catch(() => ({ contacts: [] }))
            : Promise.resolve({ contacts: [] }),
          Promise.resolve((AnvilBackend as any)?.admin?.quoteSettings?.()).catch(() => ({})),
        ]);
        if (cancelled) return;
        setLines(linesResp.lines || []);
        setTemplates(templatesResp.templates || []);
        setContacts(contactsResp.contacts || []);
        setUnitOptions(Array.isArray(quoteSettings?.quote_line_units) ? quoteSettings.quote_line_units : []);
        setSourceOptions(Array.isArray(quoteSettings?.quote_line_source_countries) ? quoteSettings.quote_line_source_countries : []);
        if (quote.template_id) {
          const t = (templatesResp.templates || []).find((x: any) => x.id === quote.template_id);
          if (t) setActiveTemplate(t);
        }
      } catch (e) { if (!cancelled) setErr(e); }
    })();
    return () => { cancelled = true; };
  }, [quote.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setField = (k: string, v: any) => setDraft((d: Quote) => ({ ...d, [k]: v }));

  // Pick a contact from the master: this is the source of truth for the
  // printed "Kind Attn" line, so selecting one overwrites attention_contact
  // (the field stays editable afterwards for salutation/format tweaks).
  const pickContact = (id: string | null) => {
    setField("customer_contact_id", id);
    const c = (contacts || []).find((x: any) => x.id === id);
    if (c) setField("attention_contact", c.name || c.email || "");
  };

  const reloadContacts = async () => {
    if (!quote.customer_id) return [];
    const r: any = await (AnvilBackend as any)?.customers?.listContacts?.({ customer_id: quote.customer_id });
    const list = Array.isArray(r) ? r : (r?.contacts || []);
    setContacts(list);
    return list;
  };

  // Create a contact in the customer's contact master, then select it as
  // the quote's attention contact. Available even when contacts exist so
  // operators can add a missing person inline.
  const createContact = async () => {
    if (!quote.customer_id) { window.notifyError?.("Cannot add contact", "This quote has no linked customer."); return; }
    const name = newContact.name.trim();
    const email = newContact.email.trim();
    if (!name && !email) { window.notifyError?.("Contact needs a name or email", "Enter at least one."); return; }
    setSavingContact(true);
    try {
      const resp: any = await (AnvilBackend as any)?.customers?.upsertContact?.({
        customer_id: quote.customer_id,
        name: name || null,
        email: email || null,
        phone: newContact.phone.trim() || null,
        role: newContact.role || null,
        is_primary: !!newContact.is_primary,
        source: "operator",
      });
      const created = resp?.contact || resp;
      await reloadContacts();
      if (created?.id) {
        setField("customer_contact_id", created.id);
        setField("attention_contact", created.name || created.email || "");
      }
      setAddingContact(false);
      setNewContact({ name: "", email: "", phone: "", role: "", is_primary: false });
      window.notifySuccess?.("Contact added", created?.name || created?.email || "saved to customer master");
    } catch (e: any) {
      window.notifyError?.("Could not add contact", e?.message || String(e));
    } finally { setSavingContact(false); }
  };

  // Audit fix May 2026: saveHeader used to also send `terms` from
  // the same draft, so a concurrent edit on the Terms tab could
  // be overwritten when an operator clicked "Save header". The
  // two tabs now patch only their own fields. saveTerms patches
  // only `terms`; saveHeader patches only the header columns.
  const saveHeader = async () => {
    setBusy(true);
    try {
      const url = `/api/quotes/${quote.id}`;
      await fetchJson(url, {
        method: "PATCH",
        body: JSON.stringify({
          your_ref: draft.your_ref || null,
          attention_contact: draft.attention_contact || null,
          customer_contact_id: draft.customer_contact_id || null,
          template_id: draft.template_id || null,
          validity_days: draft.validity_days != null ? Number(draft.validity_days) : null,
          conversion_factor: draft.conversion_factor != null ? Number(draft.conversion_factor) : null,
          fx_snapshot: draft.fx_snapshot || null,
        }),
      });
      window.notifySuccess?.("Quote header saved", quote.quote_number || quote.id?.slice(0, 8));
      onSaved?.();
    } catch (e: any) {
      window.notifyError?.("Could not save header", e?.message || String(e));
      setErr(e);
    } finally { setBusy(false); }
  };

  const saveTerms = async () => {
    setBusy(true);
    try {
      const url = `/api/quotes/${quote.id}`;
      await fetchJson(url, {
        method: "PATCH",
        body: JSON.stringify({
          terms: draft.terms || null,
        }),
      });
      window.notifySuccess?.("Quote terms saved", quote.quote_number || quote.id?.slice(0, 8));
      onSaved?.();
    } catch (e: any) {
      window.notifyError?.("Could not save terms", e?.message || String(e));
      setErr(e);
    } finally { setBusy(false); }
  };

  const saveLines = async () => {
    setBusy(true);
    try {
      await fetchJson("/api/admin/quote_lines", {
        method: "POST",
        body: JSON.stringify({ quote_id: quote.id, lines }),
      });
      const refreshed = await fetchJson("/api/admin/quote_lines?quote_id=" + quote.id);
      setLines(refreshed.lines || []);
      window.notifySuccess?.("Lines saved", `${lines.length} line${lines.length === 1 ? "" : "s"}`);
      onSaved?.();
    } catch (e: any) {
      window.notifyError?.("Could not save lines", e?.message || String(e));
    } finally { setBusy(false); }
  };

  // Blank line for ad-hoc entries (e.g. freight). Identity + qty/uom/source
  // only; pricing + overheads are set at the Composition stage.
  const addLine = () => setLines((arr) => [...arr, {
    line_index: arr.length,
    part_no: "",
    description: "",
    qty: 1,
    uom: "NO",
    source_country: "",
  }]);
  const setLine = (i: number, k: string, v: any) => setLines((arr) => arr.map((ln, idx) => idx === i ? { ...ln, [k]: v } : ln));
  const removeLine = (i: number) => setLines((arr) => arr.filter((_, idx) => idx !== i).map((ln, idx) => ({ ...ln, line_index: idx })));

  // Lazy-load the item master the first time the picker opens. Loaded
  // once and filtered client-side so typing stays instant.
  const openPicker = async () => {
    setPicking(true);
    setItemQuery("");
    if (items != null) return;
    try {
      const resp: any = await AnvilBackend?.admin?.listItemMaster?.({ limit: 1000 });
      setItems(Array.isArray(resp) ? resp : resp?.items || []);
    } catch (e) {
      setItems([]);
      setErr(e);
    }
  };

  // Append a quote line from an item-master row. Only identity + qty/uom/
  // source country carry over - pricing, tax and overheads are decided at
  // the Composition stage, not here.
  const addFromItem = (item: any) => {
    setLines((arr) => [...arr, {
      line_index: arr.length,
      part_no: item.part_no || "",
      description: item.description || "",
      qty: 1,
      uom: item.uom || "NO",
      hsn_sac: item.hsn_sac || "",
      source_country: item.source_country || "",
    }]);
    setPicking(false);
  };

  const itemMatches = (items || []).filter((it) => {
    if (!itemQuery) return true;
    const v = itemQuery.toLowerCase();
    return (it.part_no || "").toLowerCase().includes(v) || (it.description || "").toLowerCase().includes(v);
  }).slice(0, 50);

  // Lines carry only identity + qty/uom/source at this stage; pricing,
  // source selection and overheads are decided later at the Composition
  // stage. We keep this passthrough so the table can render uniformly.
  const computedLines = lines.map((ln) => ({ ...ln }));

  // ---- Lifecycle actions (Send / accept / decline / revise / convert /
  // cancel). Errors surface the server's friendly message; the
  // margin-floor block (409 MARGIN_FLOOR_BLOCK) shows as a clear nudge.
  const [lifeBusy, setLifeBusy] = useState<string | null>(null);
  const runLife = async (key: string, fn: () => Promise<any>, okMsg: string) => {
    setLifeBusy(key);
    try {
      const resp = await fn();
      const next = resp?.quote || resp;
      if (next?.status) setDraft((d: Quote) => ({ ...d, status: next.status, version: next.version ?? d.version }));
      if (resp?.margin_floor_override) window.notifyWarn?.("Sent below margin floor", "Recorded for approval review");
      window.notifySuccess?.(okMsg, draft.quote_number || quote.id?.slice(0, 8));
      onSaved?.();
    } catch (e: any) {
      const code = e?.body?.error?.code;
      const msg = code === "MARGIN_FLOOR_BLOCK"
        ? e.message
        : e?.status === 403
          ? "Needs sales_manager / finance / admin"
          : (e?.message || String(e));
      window.notifyError?.("Action failed", msg);
      setErr(e);
    } finally { setLifeBusy(null); }
  };
  const transition = (status: string, label: string) =>
    runLife(status, () => (AnvilBackend as any)?.quotes?.transition?.(quote.id, status), label);
  const sendToCustomer = () =>
    runLife("send", () => (AnvilBackend as any)?.quotes?.sendQuote?.(quote.id), "Quote sent to customer");
  const revise = () =>
    runLife("revise", async () => {
      const r = await (AnvilBackend as any)?.quotes?.revise?.(quote.id);
      onSaved?.();
      return r;
    }, "New revision created");
  const convert = () =>
    runLife("convert", () => (AnvilBackend as any)?.quotes?.convertToOrder?.(quote.id), "Converted to order");
  const cancelQuote = () => {
    if (typeof confirm === "function" && !confirm("Cancel this quote?")) return;
    runLife("cancel", () => (AnvilBackend as any)?.quotes?.cancel?.(quote.id), "Quote cancelled");
  };

  const status = String(draft.status || "DRAFT");
  const LB = (key: string) => lifeBusy === key;
  const anyBusy = lifeBusy != null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Quote detail"
      style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)", display: "flex", justifyContent: "flex-end", zIndex: 200 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(1000px, 100vw)", height: "100vh", background: "var(--bg)",
        borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column",
      }}>
        <div style={{ flexShrink: 0, padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Sales . Quote</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{draft.quote_number || quote.id?.slice(0, 8)} . v{draft.version || 1}</div>
          </div>
          {quote.opportunity?.opportunity_name && (
            <a href={"#/opps?id=" + encodeURIComponent(quote.opportunity.id)}
              title={"Open opportunity " + quote.opportunity.opportunity_name}
              style={{ textDecoration: "none" }}>
              <Chip k="ghost">for opp: {quote.opportunity.opportunity_name}</Chip>
            </a>
          )}
          {draft.status && <Chip k={String(draft.status) === "DRAFT" ? "info" : String(draft.status) === "SENT" ? "warn" : "good"}>{String(draft.status).toLowerCase()}</Chip>}
          <Btn sm kind="ghost" onClick={onClose}>close</Btn>
        </div>

        {err && <div style={{ padding: "10px 18px" }}><Banner kind="bad" icon={Icon.alert} title="Error"><span className="mono-sm">{String(err.message || err)}</span></Banner></div>}

        <div style={{ flexShrink: 0, display: "flex", gap: 2, padding: "0 18px", borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
          <TabBtn active={tab === "header"} onClick={() => setTab("header")}>Header</TabBtn>
          <TabBtn active={tab === "lines"} onClick={() => setTab("lines")}>Lines</TabBtn>
          <TabBtn active={tab === "comp"} onClick={() => setTab("comp")}>Composition</TabBtn>
          <TabBtn active={tab === "rfq"} onClick={() => setTab("rfq")}>Vendor RFQ</TabBtn>
          <TabBtn active={tab === "terms"} onClick={() => setTab("terms")}>Terms</TabBtn>
          <TabBtn active={tab === "history"} onClick={() => setTab("history")}>History</TabBtn>
          {onTab && (
            <span className="mono-sm" style={{ marginLeft: "auto", alignSelf: "center", color: "var(--ink-4)", fontSize: 10, whiteSpace: "nowrap" }} title="Keyboard: j / k next & previous quote · ← / → switch tabs · Esc close">
              j/k quote · ←/→ tab · esc
            </span>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18 }}>
          {tab === "header" && (
            <>
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Field label="Contact (from customer master)" hint="Source of the Kind Attn line. Pick from the customer's contacts, or add one if missing." provenance={<ProvenancePill source={draft.field_sources?.customer_contact_id} />}>
                  <div className="row" style={{ gap: 6, alignItems: "center" }}>
                    <select
                      className="select"
                      aria-label="Contact"
                      style={{ flex: 1 }}
                      value={draft.customer_contact_id || ""}
                      disabled={addingContact}
                      onChange={(e) => pickContact(e.target.value || null)}
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
                    {!addingContact && (
                      <Btn sm kind="ghost" disabled={!quote.customer_id}
                           title={quote.customer_id ? "Add a new contact to the customer master" : "Link a customer first"}
                           onClick={() => { setNewContact({ name: "", email: "", phone: "", role: "", is_primary: (contacts || []).length === 0 }); setAddingContact(true); }}>
                        {Icon.plus} New contact
                      </Btn>
                    )}
                  </div>
                  {addingContact && (
                    <div style={{ marginTop: 8, padding: 12, border: "1px solid var(--line)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div className="mono-sm" style={{ color: "var(--ink-3)" }}>New contact - saved to the customer master</div>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <input className="input" style={{ flex: 2, minWidth: 160 }} autoFocus placeholder="Name *" value={newContact.name} onChange={(e) => setNewContact((n) => ({ ...n, name: e.target.value }))} />
                        <input className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Email" value={newContact.email} onChange={(e) => setNewContact((n) => ({ ...n, email: e.target.value }))} />
                        <input className="input mono" style={{ flex: 1, minWidth: 120 }} placeholder="Phone" value={newContact.phone} onChange={(e) => setNewContact((n) => ({ ...n, phone: e.target.value }))} />
                        <select className="select" style={{ minWidth: 130 }} aria-label="Contact role" value={newContact.role} onChange={(e) => setNewContact((n) => ({ ...n, role: e.target.value }))}>
                          <option value="">role...</option>
                          {["primary", "procurement", "accounts", "dispatch", "qa", "engineering", "owner", "other"].map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <label className="mono-sm" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-3)" }}>
                        <input type="checkbox" checked={newContact.is_primary} onChange={(e) => setNewContact((n) => ({ ...n, is_primary: e.target.checked }))} />
                        Set as primary contact
                      </label>
                      <div className="row" style={{ gap: 6 }}>
                        <Btn sm kind="primary" disabled={savingContact} onClick={createContact}>{savingContact ? "Saving..." : "Add contact"}</Btn>
                        <Btn sm kind="ghost" disabled={savingContact} onClick={() => setAddingContact(false)}>Cancel</Btn>
                      </div>
                    </div>
                  )}
                </Field>
                <Field label="Your reference (their PO / RFQ)" hint="Buyer's internal reference, prints on the quote header." provenance={<ProvenancePill source={draft.field_sources?.your_ref} />}>
                  <input className="input mono" value={draft.your_ref || ""} onChange={(e) => setField("your_ref", e.target.value)} placeholder="e.g., E-Mail, RFQ-2026-04-23" />
                </Field>
                <Field label="Attention contact (Kind Attn)" hint="Auto-filled from the selected contact; edit only to adjust salutation/format." provenance={<ProvenancePill source={draft.field_sources?.attention_contact} />}>
                  <input className="input" value={draft.attention_contact || ""} onChange={(e) => setField("attention_contact", e.target.value)} placeholder="e.g., Mr. Prashant Shinde" />
                </Field>
                <Field label="Validity (days)" provenance={<ProvenancePill source={draft.field_sources?.validity_days} />}>
                  <input className="input mono r" type="number" value={draft.validity_days || 30} onChange={(e) => setField("validity_days", Number(e.target.value))} />
                </Field>
                <Field label="Currency" provenance={<ProvenancePill source={draft.field_sources?.currency} />}>
                  <input className="input mono" maxLength={3} value={draft.currency || "INR"} onChange={(e) => setField("currency", e.target.value.toUpperCase())} />
                </Field>
              </div>
              <Field label="Document template (form code)" hint="Defines the form code (e.g., OI/F/SP/19/R-00/020226), header/footer blocks, signatory block, and the 9 standard clauses including inco terms." provenance={<ProvenancePill source={draft.field_sources?.template_id} />}>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <select className="select" style={{ flex: 1, minWidth: 0 }} value={draft.template_id || ""} onChange={(e) => {
                    const id = e.target.value || null;
                    setField("template_id", id);
                    setActiveTemplate(id ? templates.find((t) => t.id === id) || null : null);
                  }}>
                    <option value="">Not set (use ad-hoc terms below)</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.template_name}{t.form_code ? " . " + t.form_code : ""} v{t.version}
                      </option>
                    ))}
                  </select>
                  {/* Quick path to the admin tab where operators set up
                      / edit document templates (inco terms, warranty
                      clauses, payment terms etc. all live there). */}
                  <a className="mono-sm" href="#/admin?tab=doc_templates"
                    title="Open Admin > Document templates"
                    style={{ color: "var(--accent)", textDecoration: "underline", whiteSpace: "nowrap", fontSize: 11 }}>
                    Manage templates
                  </a>
                </div>
              </Field>
              {activeTemplate && (
                <Card title="Template preview" eyebrow={`${activeTemplate.template_name} . ${activeTemplate.form_code || "no form code"}`}>
                  {activeTemplate.standard_message && <div className="mono-sm" style={{ marginBottom: 8 }}><b>Standard message:</b><div style={{ whiteSpace: "pre-wrap" }}>{activeTemplate.standard_message}</div></div>}
                  {activeTemplate.warranty_clause && <div className="mono-sm" style={{ marginBottom: 8 }}><b>Warranty:</b><div style={{ whiteSpace: "pre-wrap" }}>{activeTemplate.warranty_clause}</div></div>}
                  {activeTemplate.penalty_clause && <div className="mono-sm" style={{ marginBottom: 8 }}><b>Penalty:</b><div style={{ whiteSpace: "pre-wrap" }}>{activeTemplate.penalty_clause}</div></div>}
                </Card>
              )}
              <Field label="Conversion factor" hint="From Price Composition. Default 1.0. Excel uses 1.63 for KRW path." provenance={<ProvenancePill source={draft.field_sources?.conversion_factor} />}>
                <input className="input mono r" type="number" step="0.001" value={draft.conversion_factor || 1.0} onChange={(e) => setField("conversion_factor", Number(e.target.value))} />
              </Field>
              <Field label="FX snapshot (JSON, frozen at quote time)" hint='e.g., {"INR": 1.0, "USD": 96.0, "CNY": 14.0, "JPY": 0.65, "multiplication_factor": {"USD": 126.6}}' provenance={<ProvenancePill source={draft.field_sources?.fx_snapshot} />}>
                <textarea className="input mono-sm" rows={4} style={{ width: "100%" }} value={typeof draft.fx_snapshot === "string" ? draft.fx_snapshot : JSON.stringify(draft.fx_snapshot || {}, null, 2)} onChange={(e) => setField("fx_snapshot", e.target.value)} />
              </Field>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <Btn sm kind="ghost" onClick={onClose}>Cancel</Btn>
                <Btn sm kind="primary" disabled={busy} onClick={saveHeader}>{busy ? "Saving..." : "Save header"}</Btn>
              </div>
            </>
          )}

          {tab === "lines" && (
            <>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div>
                  <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Quote lines</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{lines.length} line{lines.length === 1 ? "" : "s"}</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Btn sm kind="primary" onClick={openPicker}>{Icon.plus} Add from item master</Btn>
                  <Btn sm kind="ghost" onClick={addLine}>{Icon.plus} Blank line</Btn>
                </div>
              </div>
              <div className="mono-sm" style={{ color: "var(--ink-4)", marginBottom: 10 }}>
                Add or remove items and set quantity, units and source country (from the item master).
                Pricing, source selection and overheads are decided at the Composition stage.
              </div>
              {/* Admin-defined dropdowns (Admin > Settings). Datalists allow a
                  controlled list while still accepting a free-typed value. */}
              <datalist id="qd-unit-options">
                {unitOptions.map((u) => <option key={u} value={u} />)}
              </datalist>
              <datalist id="qd-source-options">
                {sourceOptions.map((s) => <option key={s} value={s} />)}
              </datalist>
              {picking && (
                <Card title="Item master" eyebrow="Pick an item to append a prefilled line" style={{ marginBottom: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <input
                      className="input"
                      aria-label="Search item master"
                      placeholder="search part number or description..."
                      value={itemQuery}
                      onChange={(e) => setItemQuery(e.target.value)}
                      style={{ width: 320 }}
                    />
                    <Btn sm kind="ghost" onClick={() => setPicking(false)}>Close</Btn>
                  </div>
                  {items == null ? (
                    <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 10 }}>Loading items...</div>
                  ) : itemMatches.length === 0 ? (
                    <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 10 }}>
                      {(items.length === 0) ? "No items in the item master yet." : "No items match."}
                    </div>
                  ) : (
                    <div style={{ maxHeight: 220, overflowY: "auto" }}>
                      <table className="tbl" style={{ fontSize: 12 }}>
                        <thead><tr>
                          <th>Part</th><th>Description</th><th>UoM</th><th>Src</th><th></th>
                        </tr></thead>
                        <tbody>
                          {itemMatches.map((it) => (
                            <tr key={it.id || it.part_no}>
                              <td className="mono">{it.part_no}</td>
                              <td>{it.description || "-"}</td>
                              <td className="mono">{it.uom || "-"}</td>
                              <td className="mono">{it.source_country || "-"}</td>
                              <td><Btn sm kind="primary" onClick={() => addFromItem(it)}>Add</Btn></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )}
              {computedLines.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No lines yet. Click <b>Add from item master</b> to start.</div>
              ) : (
                <table className="tbl" style={{ fontSize: 12 }}>
                  <thead><tr>
                    <th>#</th><th>Part</th><th>Description</th><th className="r">Qty</th><th>Units</th><th>Source country</th><th></th>
                  </tr></thead>
                  <tbody>
                    {computedLines.map((ln, i) => (
                      <tr key={i}>
                        <td className="mono">{i + 1}</td>
                        <td><input className="input mono" style={{ width: 120 }} value={ln.part_no || ""} onChange={(e) => setLine(i, "part_no", e.target.value)} /></td>
                        <td><input className="input" style={{ width: 240 }} value={ln.description || ""} onChange={(e) => setLine(i, "description", e.target.value)} /></td>
                        <td className="r"><input className="input mono r" style={{ width: 70 }} type="number" step="0.01" value={ln.qty ?? ""} onChange={(e) => setLine(i, "qty", e.target.value === "" ? null : Number(e.target.value))} /></td>
                        <td><input className="input mono" list="qd-unit-options" style={{ width: 80 }} value={ln.uom || ""} onChange={(e) => setLine(i, "uom", e.target.value)} /></td>
                        <td><input className="input mono" list="qd-source-options" style={{ width: 120 }} value={ln.source_country || ""} placeholder="e.g. O-KOREA" onChange={(e) => setLine(i, "source_country", e.target.value)} /></td>
                        <td><Btn sm kind="ghost" onClick={() => removeLine(i)} title="Remove line">x</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <Btn sm kind="primary" disabled={busy} onClick={saveLines}>{busy ? "Saving..." : "Save lines"}</Btn>
              </div>
            </>
          )}

          {visited.has("comp") && (
            <div style={{ display: tab === "comp" ? undefined : "none" }}>
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>
                Cost composition preview. Enter supplier prices to see the landed-cost waterfall, the
                recommended price, and the realized margin implied by the currently quoted price.
              </div>
              <QuoteComposition lines={lines} currency={draft.currency} quoteId={quote.id} />
            </div>
          )}

          {visited.has("rfq") && (
            <div style={{ display: tab === "rfq" ? undefined : "none" }}>
              <QuoteRfqTab quoteId={quote.id} lines={lines} />
            </div>
          )}

          {tab === "terms" && (
            <>
              <Card title="Ad-hoc terms" eyebrow="Free text. Use when no template is selected.">
                <textarea className="input" rows={10} style={{ width: "100%" }} value={draft.terms || ""} onChange={(e) => setField("terms", e.target.value)} placeholder="Prices: Prices are exclusive of Taxes ..." />
              </Card>
              {activeTemplate && (
                <Card title="Inherited from template" eyebrow={activeTemplate.template_name}>
                  {[["Warranty", activeTemplate.warranty_clause],
                    ["Penalty", activeTemplate.penalty_clause],
                    ["Cancellation", activeTemplate.cancellation_clause],
                    ["Force majeure", activeTemplate.force_majeure_clause],
                    ["Payment terms", activeTemplate.payment_terms_clause],
                    ["Delivery terms", activeTemplate.delivery_terms_clause]].map(([label, text]) => text && (
                    <div key={label as string} className="mono-sm" style={{ marginBottom: 10 }}>
                      <b>{label}:</b>
                      <div style={{ whiteSpace: "pre-wrap" }}>{text as string}</div>
                    </div>
                  ))}
                </Card>
              )}
              <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <Btn sm kind="primary" disabled={busy} onClick={saveTerms}>{busy ? "Saving..." : "Save terms"}</Btn>
              </div>
            </>
          )}

          {visited.has("history") && (
            <div style={{ display: tab === "history" ? undefined : "none" }}>
              <QuoteHistoryTab quoteId={quote.id} />
            </div>
          )}
        </div>

        {/* Lifecycle action bar: status-appropriate transitions. */}
        <div style={{ flexShrink: 0, padding: "12px 18px", borderTop: "1px solid var(--line)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mono-sm" style={{ color: "var(--ink-3)", marginRight: "auto" }}>{status.toLowerCase().replace(/_/g, " ")}</span>
          {(status === "DRAFT" || status === "PENDING_INTERNAL_APPROVAL") && (
            <Btn sm kind="primary" disabled={anyBusy} onClick={sendToCustomer}>{LB("send") ? "Sending..." : "Send to customer"}</Btn>
          )}
          {status === "DRAFT" && (
            <Btn sm kind="ghost" disabled={anyBusy} onClick={() => transition("PENDING_INTERNAL_APPROVAL", "Sent for approval")}>{LB("PENDING_INTERNAL_APPROVAL") ? "..." : "Request approval"}</Btn>
          )}
          {status === "PENDING_INTERNAL_APPROVAL" && (
            <Btn sm kind="ghost" disabled={anyBusy} onClick={() => transition("DRAFT", "Returned to draft")}>{LB("DRAFT") ? "..." : "Back to draft"}</Btn>
          )}
          {status === "SENT" && (<>
            <Btn sm kind="primary" disabled={anyBusy} onClick={() => transition("ACCEPTED", "Marked accepted")}>{LB("ACCEPTED") ? "..." : "Mark accepted"}</Btn>
            <Btn sm kind="ghost" disabled={anyBusy} onClick={() => transition("DECLINED", "Marked declined")}>{LB("DECLINED") ? "..." : "Mark declined"}</Btn>
          </>)}
          {status === "ACCEPTED" && (
            <Btn sm kind="primary" disabled={anyBusy} onClick={convert}>{LB("convert") ? "Converting..." : "Convert to order"}</Btn>
          )}
          {(status === "SENT" || status === "DECLINED" || status === "EXPIRED") && (
            <Btn sm kind="ghost" disabled={anyBusy} onClick={revise}>{LB("revise") ? "..." : "Revise"}</Btn>
          )}
          {!["CONVERTED", "CANCELLED"].includes(status) && (
            <Btn sm kind="ghost" disabled={anyBusy} onClick={cancelQuote}>{LB("cancel") ? "..." : "Cancel quote"}</Btn>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuoteDetailDrawer;
