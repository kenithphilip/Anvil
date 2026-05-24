import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, fmtINR } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { QuoteComposition } from "./QuoteComposition";

// Quote detail drawer.
//
// Mounts on top of the quotes list when an operator clicks a quote
// row. Surfaces the four quote-header partials from the audit
// (your_ref, attention_contact, template picker / form code,
// validity) plus a first-class per-line editor with listed price,
// discount percent, discounted price, and CGST / SGST / IGST.
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
  const cfg: any = (ObaraBackend as any)?.getConfig?.() || {};
  const session: any = (ObaraBackend as any)?.getSession?.() || null;
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

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
    <label className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</label>
    {children}
    {hint && <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{hint}</span>}
  </div>
);

export const QuoteDetailDrawer: React.FC<{
  quote: Quote;
  onClose: () => void;
  onSaved?: () => void;
}> = ({ quote, onClose, onSaved }) => {
  const [tab, setTab] = useState<"header" | "lines" | "comp" | "terms">("header");
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [linesResp, templatesResp] = await Promise.all([
          fetchJson("/api/admin/quote_lines?quote_id=" + quote.id).catch(() => ({ lines: [] })),
          fetchJson("/api/admin/document_templates?doc_type=quotation").catch(() => ({ templates: [] })),
        ]);
        if (cancelled) return;
        setLines(linesResp.lines || []);
        setTemplates(templatesResp.templates || []);
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

  const addLine = () => setLines((arr) => [...arr, {
    line_index: arr.length,
    part_no: "",
    description: "",
    qty: 1,
    uom: "NO",
    source_country: "",
    listed_unit_price: 0,
    discount_pct: 0,
    cgst_pct: 0.09,
    sgst_pct: 0.09,
    igst_pct: 0,
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
      const resp: any = await ObaraBackend?.admin?.listItemMaster?.({ limit: 1000 });
      setItems(Array.isArray(resp) ? resp : resp?.items || []);
    } catch (e) {
      setItems([]);
      setErr(e);
    }
  };

  // Append a quote line prefilled from an item-master row. Listed price
  // seeds from the catalogue purchase price (the operator marks it up
  // before sending); tax rates and source country carry over verbatim.
  const addFromItem = (item: any) => {
    setLines((arr) => [...arr, {
      line_index: arr.length,
      part_no: item.part_no || "",
      description: item.description || "",
      qty: 1,
      uom: item.uom || "NO",
      hsn_sac: item.hsn_sac || "",
      source_country: item.source_country || "",
      listed_unit_price: item.purchase_price != null ? Number(item.purchase_price) : 0,
      discount_pct: 0,
      cgst_pct: item.cgst_rate != null ? Number(item.cgst_rate) : 0,
      sgst_pct: item.sgst_rate != null ? Number(item.sgst_rate) : 0,
      igst_pct: item.igst_rate != null ? Number(item.igst_rate) : 0,
    }]);
    setPicking(false);
  };

  const itemMatches = (items || []).filter((it) => {
    if (!itemQuery) return true;
    const v = itemQuery.toLowerCase();
    return (it.part_no || "").toLowerCase().includes(v) || (it.description || "").toLowerCase().includes(v);
  }).slice(0, 50);

  // Auto-compute discounted unit + line amount for preview.
  const computedLines = lines.map((ln) => {
    const listed = Number(ln.listed_unit_price || 0);
    const disc = Number(ln.discount_pct || 0);
    const qty = Number(ln.qty || 0);
    const effective = ln.discounted_unit_price != null
      ? Number(ln.discounted_unit_price)
      : (disc > 0 ? listed * (1 - disc) : listed);
    const lineTotal = qty * effective;
    return { ...ln, effective, lineTotal };
  });
  const total = computedLines.reduce((s, ln) => s + (ln.lineTotal || 0), 0);

  return (
    <div role="dialog" aria-modal="true" aria-label="Quote detail"
      style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)", display: "flex", justifyContent: "flex-end", zIndex: 200 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(1000px, 100vw)", height: "100vh", background: "var(--bg)",
        borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Sales . Quote</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{draft.quote_number || quote.id?.slice(0, 8)} . v{draft.version || 1}</div>
          </div>
          {draft.status && <Chip k={String(draft.status) === "DRAFT" ? "info" : String(draft.status) === "SENT" ? "warn" : "good"}>{String(draft.status).toLowerCase()}</Chip>}
          <Btn sm kind="ghost" onClick={onClose}>close</Btn>
        </div>

        {err && <div style={{ padding: "10px 18px" }}><Banner kind="bad" icon={Icon.alert} title="Error"><span className="mono-sm">{String(err.message || err)}</span></Banner></div>}

        <div style={{ display: "flex", gap: 2, padding: "0 18px", borderBottom: "1px solid var(--line)" }}>
          <TabBtn active={tab === "header"} onClick={() => setTab("header")}>Header</TabBtn>
          <TabBtn active={tab === "lines"} onClick={() => setTab("lines")}>Lines</TabBtn>
          <TabBtn active={tab === "comp"} onClick={() => setTab("comp")}>Composition</TabBtn>
          <TabBtn active={tab === "terms"} onClick={() => setTab("terms")}>Terms</TabBtn>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {tab === "header" && (
            <>
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Field label="Your reference (their PO / RFQ)" hint="Buyer's internal reference, prints on the quote header.">
                  <input className="input mono" value={draft.your_ref || ""} onChange={(e) => setField("your_ref", e.target.value)} placeholder="e.g., E-Mail, RFQ-2026-04-23" />
                </Field>
                <Field label="Attention contact (Kind Attn)" hint="Named contact at the buyer.">
                  <input className="input" value={draft.attention_contact || ""} onChange={(e) => setField("attention_contact", e.target.value)} placeholder="e.g., Mr. Prashant Shinde" />
                </Field>
                <Field label="Validity (days)">
                  <input className="input mono r" type="number" value={draft.validity_days || 30} onChange={(e) => setField("validity_days", Number(e.target.value))} />
                </Field>
                <Field label="Currency">
                  <input className="input mono" maxLength={3} value={draft.currency || "INR"} onChange={(e) => setField("currency", e.target.value.toUpperCase())} />
                </Field>
              </div>
              <Field label="Document template (form code)" hint="Pick a template from Admin . Document templates. Defines the form code (e.g., OI/F/SP/19/R-00/020226), header/footer blocks, signatory block, and the 9 standard clauses.">
                <select className="select" value={draft.template_id || ""} onChange={(e) => {
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
              </Field>
              {activeTemplate && (
                <Card title="Template preview" eyebrow={`${activeTemplate.template_name} . ${activeTemplate.form_code || "no form code"}`}>
                  {activeTemplate.standard_message && <div className="mono-sm" style={{ marginBottom: 8 }}><b>Standard message:</b><div style={{ whiteSpace: "pre-wrap" }}>{activeTemplate.standard_message}</div></div>}
                  {activeTemplate.warranty_clause && <div className="mono-sm" style={{ marginBottom: 8 }}><b>Warranty:</b><div style={{ whiteSpace: "pre-wrap" }}>{activeTemplate.warranty_clause}</div></div>}
                  {activeTemplate.penalty_clause && <div className="mono-sm" style={{ marginBottom: 8 }}><b>Penalty:</b><div style={{ whiteSpace: "pre-wrap" }}>{activeTemplate.penalty_clause}</div></div>}
                </Card>
              )}
              <Field label="Conversion factor" hint="From Price Composition. Default 1.0. Excel uses 1.63 for KRW path.">
                <input className="input mono r" type="number" step="0.001" value={draft.conversion_factor || 1.0} onChange={(e) => setField("conversion_factor", Number(e.target.value))} />
              </Field>
              <Field label="FX snapshot (JSON, frozen at quote time)" hint='e.g., {"INR": 1.0, "USD": 96.0, "CNY": 14.0, "JPY": 0.65, "multiplication_factor": {"USD": 126.6}}'>
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
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Quote lines</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{lines.length} line{lines.length === 1 ? "" : "s"} . total {fmtINR(total)}</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Btn sm kind="ghost" onClick={openPicker}>{Icon.plus} From item master</Btn>
                  <Btn sm kind="primary" onClick={addLine}>{Icon.plus} Add line</Btn>
                </div>
              </div>
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
                          <th>Part</th><th>Description</th><th>UoM</th><th>Src</th><th className="r">Price</th><th></th>
                        </tr></thead>
                        <tbody>
                          {itemMatches.map((it) => (
                            <tr key={it.id || it.part_no}>
                              <td className="mono">{it.part_no}</td>
                              <td>{it.description || "-"}</td>
                              <td className="mono">{it.uom || "-"}</td>
                              <td className="mono">{it.source_country || "-"}</td>
                              <td className="r mono">{it.purchase_price != null ? fmtINR(Number(it.purchase_price)) : "-"}</td>
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
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No lines yet. Click <b>Add line</b> to start.</div>
              ) : (
                <table className="tbl" style={{ fontSize: 12 }}>
                  <thead><tr>
                    <th>#</th><th>Part</th><th>Description</th><th className="r">Qty</th><th>UoM</th><th>Src</th>
                    <th className="r">Listed</th><th className="r">Disc %</th><th className="r">Net</th><th className="r">CGST</th><th className="r">SGST</th><th className="r">IGST</th><th className="r">Line</th><th></th>
                  </tr></thead>
                  <tbody>
                    {computedLines.map((ln, i) => (
                      <tr key={i}>
                        <td className="mono">{i + 1}</td>
                        <td><input className="input mono" style={{ width: 110 }} value={ln.part_no || ""} onChange={(e) => setLine(i, "part_no", e.target.value)} /></td>
                        <td><input className="input" style={{ width: 200 }} value={ln.description || ""} onChange={(e) => setLine(i, "description", e.target.value)} /></td>
                        <td className="r"><input className="input mono r" style={{ width: 60 }} type="number" step="0.01" value={ln.qty ?? ""} onChange={(e) => setLine(i, "qty", e.target.value === "" ? null : Number(e.target.value))} /></td>
                        <td><input className="input mono" style={{ width: 60 }} value={ln.uom || ""} onChange={(e) => setLine(i, "uom", e.target.value)} /></td>
                        <td><input className="input mono" style={{ width: 80 }} value={ln.source_country || ""} placeholder="e.g. O-KOREA" onChange={(e) => setLine(i, "source_country", e.target.value)} /></td>
                        <td className="r"><input className="input mono r" style={{ width: 90 }} type="number" step="0.01" value={ln.listed_unit_price ?? ""} onChange={(e) => setLine(i, "listed_unit_price", e.target.value === "" ? null : Number(e.target.value))} /></td>
                        <td className="r"><input className="input mono r" style={{ width: 60 }} type="number" step="0.001" value={ln.discount_pct ?? 0} onChange={(e) => setLine(i, "discount_pct", Number(e.target.value))} /></td>
                        <td className="r mono"><span className="pri">{ln.effective != null ? fmtINR(ln.effective) : "-"}</span></td>
                        <td className="r"><input className="input mono r" style={{ width: 55 }} type="number" step="0.001" value={ln.cgst_pct ?? ""} onChange={(e) => setLine(i, "cgst_pct", e.target.value === "" ? null : Number(e.target.value))} /></td>
                        <td className="r"><input className="input mono r" style={{ width: 55 }} type="number" step="0.001" value={ln.sgst_pct ?? ""} onChange={(e) => setLine(i, "sgst_pct", e.target.value === "" ? null : Number(e.target.value))} /></td>
                        <td className="r"><input className="input mono r" style={{ width: 55 }} type="number" step="0.001" value={ln.igst_pct ?? ""} onChange={(e) => setLine(i, "igst_pct", e.target.value === "" ? null : Number(e.target.value))} /></td>
                        <td className="r mono"><b>{ln.lineTotal != null ? fmtINR(ln.lineTotal) : "-"}</b></td>
                        <td><Btn sm kind="ghost" onClick={() => removeLine(i)}>x</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "var(--paper-2)" }}>
                      <td colSpan={12} className="r mono"><b>Total</b></td>
                      <td className="r mono"><b style={{ fontSize: 13 }}>{fmtINR(total)}</b></td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              )}
              <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <Btn sm kind="primary" disabled={busy} onClick={saveLines}>{busy ? "Saving..." : "Save lines"}</Btn>
              </div>
            </>
          )}

          {tab === "comp" && (
            <>
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>
                Cost composition preview. Enter supplier prices to see the landed-cost waterfall, the
                recommended price, and the realized margin implied by the currently quoted price.
              </div>
              <QuoteComposition lines={lines} currency={draft.currency} />
            </>
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
        </div>
      </div>
    </div>
  );
};

export default QuoteDetailDrawer;
