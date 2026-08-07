// Opportunity quote-revision timeline (P1). Tracks the external (PDF) quotes a
// sales engineer sends to a customer against one opportunity: budgetary ->
// revised (qty/type) -> discount/final, each with the deal size at that
// revision + who it went to (primary + CC contacts). Backend: /api/opportunities
// /quotes (migration 203). Rendered under the selected opportunity on opps.tsx.
//
// Distinct from OpportunityQuotesPanel, which lists Anvil-*generated* quotes
// (the `quotes` table + approval workflow). This panel is for quote PDFs
// authored *outside* Anvil and uploaded here to track how the deal evolved.
//
// Automation (reduce-clicks): the SE confirms, doesn't re-type. On file pick we
// run the DocAI extractor (documents.extract, same pipeline so-intake uses) to
// pre-fill amount + currency off the PDF; the quote type auto-detects
// budgetary-vs-revised from the timeline; the deal size seeds from the latest
// quote / opportunity.amount / line-item rollup; and the primary contact is
// pre-selected as "To". Every prefill stays editable.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const TYPES = ["budgetary", "revised", "final", "discount"];
const TYPE_CHIP: Record<string, "info" | "warn" | "good" | "ghost"> = { budgetary: "ghost", revised: "info", discount: "warn", final: "good" };
const STATUS_CHIP: Record<string, "info" | "warn" | "good" | "bad" | "ghost"> = { draft: "ghost", sent: "info", accepted: "good", declined: "bad", superseded: "warn" };
const fmtAmt = (a: any, c: string) => (a == null || a === "" ? "—" : (c || "INR") + " " + Number(a).toLocaleString("en-IN"));
const fmtDate = (iso: any) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "—");
const nnum = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Deal size implied by an extraction: Σ(qty × unitPrice × (1+gst%)). Mirrors the
// server-side totalsFromExtraction() in api/invoices/extract.js. There is no
// document-level "Total" field in the normalized schema, so this is a computed
// figure — it can differ from a printed total that bakes in discount/freight,
// which is why the UI asks the SE to verify rather than trusting it silently.
const extractionTotal = (lines: any[]): number =>
  (Array.isArray(lines) ? lines : []).reduce(
    (s, l) => s + nnum(l?.quantity) * nnum(l?.unitPrice) * (1 + nnum(l?.gst_pct) / 100),
    0,
  );

type ExtractInfo = { amount: number | null; currency: string | null; lines: number; confidence: number | null; largePdf: boolean; pages: number | null; error?: boolean };

export const OpportunityQuoteRevisions: React.FC<{
  opportunityId: string;
  customerId?: string | null;
  opportunityAmount?: number | string | null;
}> = ({ opportunityId, customerId, opportunityAmount }) => {
  const [quotes, setQuotes] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [oppLines, setOppLines] = useState<any[]>([]);
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
  const [extracting, setExtracting] = useState(false);
  const [extractInfo, setExtractInfo] = useState<ExtractInfo | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await AnvilBackend?.sales?.listOpportunityQuotes?.(opportunityId);
      setQuotes(r?.quotes || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [opportunityId]);

  // Opportunity line items — used both as a read-only cross-check block in the
  // form and as the last-resort deal-size fallback (Σ qty × expected_unit_price).
  useEffect(() => {
    let cancel = false;
    if (!opportunityId || !AnvilBackend?.sales?.listOpportunityLines) { setOppLines([]); return; }
    AnvilBackend.sales.listOpportunityLines(opportunityId)
      .then((r: any) => { if (!cancel) setOppLines(r?.line_items || (Array.isArray(r) ? r : [])); })
      .catch(() => { if (!cancel) setOppLines([]); });
    return () => { cancel = true; };
  }, [opportunityId]);

  useEffect(() => {
    let cancel = false;
    if (!customerId || !AnvilBackend?.customers?.listContacts) { setContacts([]); return; }
    AnvilBackend.customers.listContacts({ customer_id: customerId })
      .then((r: any) => {
        if (cancel) return;
        const list = r?.contacts || r?.rows || (Array.isArray(r) ? r : []);
        setContacts(list);
        // Default the primary contact (or the only contact) to "To", but never
        // clobber a selection the operator has already started.
        const primary = list.find((c: any) => c.is_primary) || list[0];
        if (primary?.id) setRecips((cur) => (Object.keys(cur).length ? cur : { [primary.id]: "to" }));
      })
      .catch(() => { if (!cancel) setContacts([]); });
    return () => { cancel = true; };
  }, [customerId]);

  const lineItemsTotal = useMemo(() => {
    const t = (oppLines || []).reduce((s, l) => s + nnum(l.qty) * nnum(l.expected_unit_price), 0);
    return t > 0 ? Number(t.toFixed(2)) : null;
  }, [oppLines]);

  // What to seed the deal-size field with: the latest tracked quote, else the
  // opportunity header amount, else the line-item rollup. All already in Anvil.
  const suggestedAmount = useMemo(() => {
    if (quotes[0]?.amount != null && quotes[0]?.amount !== "") return quotes[0].amount;
    if (opportunityAmount != null && opportunityAmount !== "") return opportunityAmount;
    return lineItemsTotal;
  }, [quotes, opportunityAmount, lineItemsTotal]);

  // Seed the form with smart defaults instead of blanks. First quote on an
  // opportunity is a budgetary; anything after is a revision.
  const seedForm = () => {
    setFile(null);
    setExtractInfo(null);
    setExtracting(false);
    setQuoteType(quotes.length ? "revised" : "budgetary");
    setAmount(suggestedAmount != null && suggestedAmount !== "" ? String(suggestedAmount) : "");
    setCurrency(quotes[0]?.amount_currency || "INR");
    setStatus("sent");
    setNote("");
    const primary = contacts.find((c) => c.is_primary) || contacts[0];
    setRecips(primary?.id ? { [primary.id]: "to" } : {});
  };

  const openAdd = () => { if (!showAdd) seedForm(); setShowAdd((s) => !s); };

  // On file pick: run the shared DocAI extractor and pre-fill amount + currency
  // off the PDF. kind:'invoice' (not the default 'po') so a seller-issued
  // quotation isn't early-classified as non_po and dropped with empty lines.
  const onPickFile = async (f: File | null) => {
    setFile(f);
    setExtractInfo(null);
    if (!f || !AnvilBackend?.documents?.extract) return;
    setExtracting(true);
    try {
      const out: any = await AnvilBackend.documents.extract(f, { kind: "invoice" });
      const lines = Array.isArray(out?.normalized?.lines) ? out.normalized.lines : [];
      const total = extractionTotal(lines);
      const ccy = out?.normalized?.customer?.currency || null;
      const info: ExtractInfo = {
        amount: total > 0 ? Number(total.toFixed(2)) : null,
        currency: ccy,
        lines: lines.length,
        confidence: typeof out?.confidence_overall === "number" ? out.confidence_overall : null,
        largePdf: !!out?.large_pdf,
        pages: out?.total_pages || null,
      };
      if (info.amount != null) setAmount(String(info.amount)); // PDF is authoritative over the seeded guess
      if (ccy) setCurrency(ccy);
      setExtractInfo(info);
    } catch {
      setExtractInfo({ amount: null, currency: null, lines: 0, confidence: null, largePdf: false, pages: null, error: true });
    } finally { setExtracting(false); }
  };

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
      setShowAdd(false); seedForm(); await load();
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
          right={<Btn sm kind="primary" onClick={openAdd}>{Icon.plus} Add revision</Btn>}>
      {err && <Banner kind="bad">{err}</Banner>}

      {showAdd && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 2px 12px", borderBottom: "1px solid var(--hairline-2)", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <label className="mono-sm" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px dashed var(--hairline-2)", borderRadius: 8, cursor: "pointer" }}>
              {Icon.upload} {extracting ? "Reading…" : file ? file.name : "Quote PDF…"}
              <input type="file" accept=".pdf" style={{ display: "none" }} onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
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

          {extracting && <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Reading the quote PDF to pre-fill the deal size…</div>}
          {extractInfo && !extractInfo.error && extractInfo.amount != null && (
            <Banner kind="info">
              Read from the PDF: {extractInfo.currency || currency} {Number(extractInfo.amount).toLocaleString("en-IN")}
              {extractInfo.lines ? ` · ${extractInfo.lines} line${extractInfo.lines > 1 ? "s" : ""}` : ""}
              {extractInfo.confidence != null ? ` · ${Math.round(extractInfo.confidence * 100)}% confidence` : ""}. Verify the figure — discounts/freight may not be included
              {extractInfo.largePdf ? `; only page 1 of ${extractInfo.pages || "many"} was read` : ""}.
            </Banner>
          )}
          {extractInfo && (extractInfo.error || extractInfo.amount == null) && (
            <Banner kind="warn">
              Couldn&apos;t read a total off this PDF{extractInfo.largePdf ? ` (large PDF — only page 1 read)` : ""}. Enter the deal size manually.
            </Banner>
          )}

          {oppLines.length > 0 && (
            <div>
              <div className="label">opportunity line items (reference — confirm the PDF matches)</div>
              <div className="mono-sm" style={{ color: "var(--ink-3)", display: "flex", flexDirection: "column", gap: 2, maxHeight: 120, overflowY: "auto" }}>
                {oppLines.map((l) => (
                  <div key={l.id} style={{ display: "flex", gap: 8 }}>
                    <span style={{ flex: 1 }}>{l.product_family}{l.part_no ? ` · ${l.part_no}` : ""}</span>
                    <span>×{l.qty}</span>
                    <span style={{ minWidth: 90, textAlign: "right" }}>{l.expected_unit_price != null ? `${l.expected_currency || currency} ${Number(l.expected_unit_price).toLocaleString("en-IN")}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div><div className="label">change note (why this revision — qty / price / discount)</div>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. revised qty for 2 stations; 5% discount to close" style={{ width: "100%" }} /></div>
          <div>
            <div className="label">sent to (primary is pre-picked; mark CC for people copied at the customer)</div>
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
            <Btn sm kind="primary" onClick={submit} disabled={busy || extracting}>{busy ? "Saving…" : "Save revision"}</Btn>
            <Btn sm kind="ghost" onClick={() => { setShowAdd(false); seedForm(); }}>Cancel</Btn>
          </div>
        </div>
      )}

      {loading ? <div className="body" style={{ color: "var(--ink-3)" }}>Loading…</div>
        : quotes.length === 0 ? <div className="body" style={{ color: "var(--ink-3)" }}>No quotes tracked yet. Upload the budgetary quote — the deal size and recipient pre-fill, so you just confirm.</div>
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
