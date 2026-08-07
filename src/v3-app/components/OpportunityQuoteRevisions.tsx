// Opportunity quote-revision timeline (P1). Tracks the external (PDF) quotes a
// sales engineer sends to a customer against one opportunity: budgetary ->
// revised (qty/type) -> discount/final, each with the deal size at that
// revision + who it went to (primary + CC contacts). Backend: /api/opportunities
// /quotes (migration 203). Rendered under the selected opportunity on opps.tsx.
//
// Distinct from OpportunityQuotesPanel, which lists Anvil-*generated* quotes
// (the `quotes` table + approval workflow). This panel is for quote PDFs
// authored *outside* Anvil and uploaded here to track how the deal evolved.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const TYPES = ["budgetary", "revised", "final", "discount"];
const TYPE_CHIP: Record<string, "info" | "warn" | "good" | "ghost"> = { budgetary: "ghost", revised: "info", discount: "warn", final: "good" };
const STATUS_CHIP: Record<string, "info" | "warn" | "good" | "bad" | "ghost"> = { draft: "ghost", sent: "info", accepted: "good", declined: "bad", superseded: "warn" };
const fmtAmt = (a: any, c: string) => (a == null || a === "" ? "—" : (c || "INR") + " " + Number(a).toLocaleString("en-IN"));
const fmtDate = (iso: any) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "—");

export const OpportunityQuoteRevisions: React.FC<{ opportunityId: string; customerId?: string | null }> = ({ opportunityId, customerId }) => {
  const [quotes, setQuotes] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  // Add-revision form
  const [file, setFile] = useState<File | null>(null);
  const [quoteType, setQuoteType] = useState("budgetary");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [status, setStatus] = useState("sent");
  const [note, setNote] = useState("");
  const [recips, setRecips] = useState<Record<string, "to" | "cc">>({}); // contact_id -> kind

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await AnvilBackend?.sales?.listOpportunityQuotes?.(opportunityId);
      setQuotes(r?.quotes || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [opportunityId]);
  useEffect(() => {
    let cancel = false;
    if (!customerId || !AnvilBackend?.customers?.listContacts) { setContacts([]); return; }
    AnvilBackend.customers.listContacts({ customer_id: customerId })
      .then((r: any) => { if (!cancel) setContacts(r?.contacts || r?.rows || (Array.isArray(r) ? r : [])); })
      .catch(() => { if (!cancel) setContacts([]); });
    return () => { cancel = true; };
  }, [customerId]);

  const resetForm = () => { setFile(null); setQuoteType("budgetary"); setAmount(""); setCurrency("INR"); setStatus("sent"); setNote(""); setRecips({}); };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let document_id: string | null = null;
      let original_filename: string | null = null;
      if (file) {
        const up = await AnvilBackend.documents.upload(file, "quote", { autoScan: false });
        document_id = up.documentId; original_filename = file.name;
      }
      const recipients = Object.entries(recips).map(([contact_id, kind]) => {
        const c = contacts.find((x) => x.id === contact_id) || {};
        return { contact_id, kind, email: c.email || null, name: c.name || null };
      });
      await AnvilBackend.sales.addOpportunityQuote({
        opportunity_id: opportunityId, quote_type: quoteType, document_id, original_filename,
        amount: amount || null, amount_currency: currency, status, change_note: note || null, recipients,
      });
      window.notifySuccess?.("Quote revision added", `v-next · ${quoteType} · ${status}`);
      resetForm(); setShowAdd(false); await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const openDoc = async (documentId: string) => {
    try { const r = await AnvilBackend.documents.fetch(documentId); if (r?.downloadUrl) window.open(r.downloadUrl, "_blank"); }
    catch (e: any) { window.notifyError?.("Open failed", e?.message || String(e)); }
  };
  const setStatusOf = async (id: string, s: string) => {
    setBusy(true);
    try { await AnvilBackend.sales.updateOpportunityQuote(id, { status: s }); await load(); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const removeQuote = async (id: string) => {
    if (!window.confirm("Delete this quote revision?")) return;
    setBusy(true);
    try { await AnvilBackend.sales.deleteOpportunityQuote(id); await load(); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const latestAmount = useMemo(() => (quotes[0] ? fmtAmt(quotes[0].amount, quotes[0].amount_currency) : "—"), [quotes]);

  const recipNames = (q: any, kind: string) => (q.recipients || []).filter((r: any) => r.kind === kind)
    .map((r: any) => r.name || r.email || "contact").join(", ");

  return (
    <Card title="Quotes sent" eyebrow={`revision timeline · latest ${latestAmount}`}
          right={<Btn sm kind="primary" onClick={() => setShowAdd((s) => !s)}>{Icon.plus} Add revision</Btn>}>
      {err && <Banner kind="bad">{err}</Banner>}

      {showAdd && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 2px 12px", borderBottom: "1px solid var(--hairline-2)", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <label className="mono-sm" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px dashed var(--hairline-2)", borderRadius: 8, cursor: "pointer" }}>
              {Icon.upload} {file ? file.name : "Quote PDF…"}
              <input type="file" accept=".pdf" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <div><div className="label">type</div>
              <select className="input" value={quoteType} onChange={(e) => setQuoteType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
            <div><div className="label">deal size</div>
              <div style={{ display: "flex", gap: 4 }}>
                <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 74 }}>{["INR", "USD", "EUR", "JPY", "KRW", "CNY"].map((c) => <option key={c}>{c}</option>)}</select>
                <input className="input mono" type="number" placeholder="amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} />
              </div></div>
            <div><div className="label">status</div>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>{["draft", "sent", "accepted", "declined"].map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          </div>
          <div><div className="label">change note (why this revision — qty / price / discount)</div>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. revised qty for 2 stations; 5% discount to close" style={{ width: "100%" }} /></div>
          <div>
            <div className="label">sent to (pick contacts; mark CC for people copied at the customer)</div>
            {contacts.length === 0
              ? <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No contacts on this customer yet — add them in Customers → Contacts.</div>
              : <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {contacts.map((c) => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span style={{ minWidth: 200 }}>{c.name || c.email || "—"}{c.is_primary ? <span className="mono-sm" style={{ color: "var(--ink-4)" }}> · primary</span> : ""}</span>
                      <span className="mono-sm" style={{ color: "var(--ink-4)", flex: 1 }}>{c.email || ""}</span>
                      {(["", "to", "cc"] as const).map((k) => (
                        <label key={k || "none"} className="mono-sm" style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}>
                          <input type="radio" name={"r-" + c.id} checked={(recips[c.id] || "") === k}
                            onChange={() => setRecips((m) => { const n = { ...m }; if (k) n[c.id] = k; else delete n[c.id]; return n; })} />
                          {k || "—"}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Btn sm kind="primary" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save revision"}</Btn>
            <Btn sm kind="ghost" onClick={() => { setShowAdd(false); resetForm(); }}>Cancel</Btn>
          </div>
        </div>
      )}

      {loading ? <div className="body" style={{ color: "var(--ink-3)" }}>Loading…</div>
        : quotes.length === 0 ? <div className="body" style={{ color: "var(--ink-3)" }}>No quotes tracked yet. Upload the budgetary quote to start the timeline.</div>
        : (
          <table className="tbl">
            <thead><tr><th>Ver</th><th>Type</th><th className="r">Deal size</th><th>Status</th><th>Sent</th><th>To / CC</th><th>Note</th><th>PDF</th><th></th></tr></thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="mono">v{q.version}</td>
                  <td><Chip k={TYPE_CHIP[q.quote_type] || "ghost"}>{q.quote_type}</Chip></td>
                  <td className="r mono">{fmtAmt(q.amount, q.amount_currency)}</td>
                  <td><Chip k={STATUS_CHIP[q.status] || "ghost"}>{q.status}</Chip></td>
                  <td className="mono-sm">{fmtDate(q.sent_at)}</td>
                  <td className="mono-sm" style={{ maxWidth: 200 }}>
                    {recipNames(q, "to") && <div><b>To:</b> {recipNames(q, "to")}</div>}
                    {recipNames(q, "cc") && <div style={{ color: "var(--ink-3)" }}><b>CC:</b> {recipNames(q, "cc")}</div>}
                    {!(q.recipients || []).length && <span style={{ color: "var(--ink-4)" }}>—</span>}
                  </td>
                  <td className="mono-sm" style={{ maxWidth: 240, whiteSpace: "pre-wrap" }}>{q.change_note || "—"}</td>
                  <td>{q.document_id ? <Btn sm kind="ghost" onClick={() => openDoc(q.document_id)} title={q.original_filename || "Open PDF"}>{Icon.doc} open</Btn> : <span className="mono-sm" style={{ color: "var(--ink-4)" }}>—</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {q.status === "draft" && <Btn sm kind="ghost" onClick={() => setStatusOf(q.id, "sent")} disabled={busy} title="Mark sent">sent</Btn>}
                    {(q.status === "sent") && <>
                      <Btn sm kind="ghost" onClick={() => setStatusOf(q.id, "accepted")} disabled={busy} title="Mark accepted">✓</Btn>
                      <Btn sm kind="ghost" onClick={() => setStatusOf(q.id, "declined")} disabled={busy} title="Mark declined">✕</Btn>
                    </>}
                    <Btn icon sm kind="ghost" onClick={() => removeQuote(q.id)} disabled={busy} title="Delete">{Icon.x}</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Card>
  );
};
