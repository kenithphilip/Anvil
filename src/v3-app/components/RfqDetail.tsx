import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// RFQ workspace for ONE supplier RFQ. Shared by the quote-drawer RFQ tab
// and the standalone Supplier RFQ screen.
//   - invite vendors + send (drafts emails via the comms path)
//   - capture each vendor's quote: unit price, currency, lead time,
//     validity, and the vendor's quote reference (per vendor)
//   - compare line x vendor, lowest price flagged
//   - award per line -> when the RFQ is linked to a quote, the winning
//     vendor's price + ref are fed into that quote's composition (server).
// ============================================================

type Any = any;

export const RfqDetail: React.FC<{ rfqId: string; onChanged?: () => void }> = ({ rfqId, onChanged }) => {
  const [data, setData] = useState<Any>(null);
  const [vendors, setVendors] = useState<Any[]>([]);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [addVendorId, setAddVendorId] = useState("");
  const [newVendor, setNewVendor] = useState("");
  // Per-invitation capture draft: { [invitationId]: { ref, currency, lines: {line_no: {unit_price, lead_time_days}} } }
  const [capture, setCapture] = useState<Record<string, Any>>({});
  const [picks, setPicks] = useState<Record<number, string>>({}); // line_no -> invitation_id
  const [currencyOptions, setCurrencyOptions] = useState<string[]>(["INR", "USD", "EUR", "CNY", "KRW", "JPY", "GBP"]);
  useEffect(() => {
    let cancel = false;
    Promise.resolve(AnvilBackend?.admin?.quoteSettings?.())
      .then((qs: any) => { if (!cancel && Array.isArray(qs?.quote_currencies) && qs.quote_currencies.length) setCurrencyOptions(qs.quote_currencies); })
      .catch(() => {});
    return () => { cancel = true; };
  }, []);

  const load = async () => {
    setErr("");
    try {
      const [d, v] = await Promise.all([
        AnvilBackend?.supplierRfq?.get?.(rfqId),
        AnvilBackend?.supplierRfq?.listVendors?.(),
      ]);
      setData(d || null);
      setVendors(Array.isArray(v) ? v : (v?.vendors || []));
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [rfqId]);

  const rfq = data?.rfq;
  const lines: Any[] = data?.lines || [];
  const invitations: Any[] = data?.invitations || [];
  const quotes: Any[] = data?.quotes || [];
  const customerName: string | null = data?.customer_name || null;
  const refByVendor = useMemo(
    () => new Map<string, string>((data?.customer_refs || []).map((r: Any) => [String(r.vendor_id), String(r.customer_ref || "")])),
    [data]
  );

  // Save the RFQ-level default customer reference (used when a vendor has no
  // specific code of its own).
  const saveDefaultRef = async (val: string) => {
    if (val === (rfq?.customer_ref || "")) return;
    try { await AnvilBackend?.supplierRfq?.update?.(rfqId, { customer_ref: val }); await load(); }
    catch (e: any) { window.notifyError?.("Could not save reference", e?.message || String(e)); }
  };
  // Save a vendor's own reference/code for this end customer (reused across RFQs).
  const saveVendorRef = async (vendorId: string, val: string) => {
    if (!rfq?.customer_id) return;
    if (val === (refByVendor.get(vendorId) || "")) return;
    try {
      await AnvilBackend?.supplierRfq?.setCustomerRef?.({ vendor_id: vendorId, customer_id: rfq.customer_id, customer_ref: val });
      await load();
    } catch (e: any) { window.notifyError?.("Could not save vendor reference", e?.message || String(e)); }
  };

  const vendorById = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);
  const uninvited = useMemo(
    () => vendors.filter((v) => v.active !== false && !invitations.some((i) => i.vendor_id === v.id)),
    [vendors, invitations]
  );

  // Existing quote lookup: invitationId|line_no -> supplier_quote
  const quoteFor = (invId: string, lineNo: number) => quotes.find((q) => q.invitation_id === invId && q.line_no === lineNo);

  // Default winner picks = lowest unit_price per line (computed once data loads).
  useEffect(() => {
    if (!lines.length) return;
    const next: Record<number, string> = {};
    for (const ln of lines) {
      let best: Any = null;
      for (const inv of invitations) {
        const q = quoteFor(inv.id, ln.line_no);
        if (q?.unit_price == null) continue;
        if (!best || Number(q.unit_price) < Number(best.q.unit_price)) best = { inv, q };
      }
      if (best) next[ln.line_no] = best.inv.id;
    }
    setPicks((prev) => ({ ...next, ...prev })); // keep any manual overrides
    // eslint-disable-next-line
  }, [data]);

  const addVendor = async () => {
    if (!addVendorId) return;
    setBusy(true);
    try {
      await AnvilBackend?.supplierRfq?.send?.({ rfq_id: rfqId, vendor_ids: [addVendorId] });
      setAddVendorId("");
      await load();
      window.notifySuccess?.("Vendor invited", "RFQ email drafted");
      onChanged?.();
    } catch (e: any) { window.notifyError?.("Could not invite", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const quickAddVendor = async () => {
    const name = newVendor.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r: any = await AnvilBackend?.supplierRfq?.createVendor?.({ vendor_name: name });
      const created = r?.vendor || r;
      setNewVendor("");
      const v = await AnvilBackend?.supplierRfq?.listVendors?.();
      setVendors(Array.isArray(v) ? v : (v?.vendors || []));
      if (created?.id) setAddVendorId(created.id);
      window.notifySuccess?.("Vendor added", name);
    } catch (e: any) { window.notifyError?.("Could not add vendor", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const setCap = (invId: string, patch: Any) =>
    setCapture((c) => ({ ...c, [invId]: { ...(c[invId] || {}), ...patch } }));
  const setCapLine = (invId: string, lineNo: number, patch: Any) =>
    setCapture((c) => ({ ...c, [invId]: { ...(c[invId] || {}), lines: { ...((c[invId] || {}).lines || {}), [lineNo]: { ...(((c[invId] || {}).lines || {})[lineNo] || {}), ...patch } } } }));

  // Seed capture draft from existing quotes when opening.
  const ensureDraft = (inv: Any) => {
    if (capture[inv.id]) return capture[inv.id];
    const existing = quotes.filter((q) => q.invitation_id === inv.id);
    const linesDraft: Any = {};
    existing.forEach((q) => { linesDraft[q.line_no] = { unit_price: q.unit_price ?? "", lead_time_days: q.lead_time_days ?? "" }; });
    const draft = {
      ref: existing[0]?.supplier_quote_ref || "",
      currency: existing[0]?.currency || "USD",
      lines: linesDraft,
    };
    setCapture((c) => ({ ...c, [inv.id]: draft }));
    return draft;
  };

  const saveCapture = async (inv: Any) => {
    const d = capture[inv.id] || ensureDraft(inv);
    const linesPayload = lines
      .map((ln) => {
        const cell = (d.lines || {})[ln.line_no] || {};
        if (cell.unit_price === "" || cell.unit_price == null) return null;
        return {
          line_no: ln.line_no,
          unit_price: Number(cell.unit_price),
          lead_time_days: cell.lead_time_days === "" || cell.lead_time_days == null ? null : Number(cell.lead_time_days),
          currency: d.currency || "USD",
          supplier_quote_ref: d.ref || null,
        };
      })
      .filter(Boolean);
    if (!linesPayload.length) { window.notifyError?.("Nothing to save", "Enter at least one unit price."); return; }
    setBusy(true);
    try {
      await AnvilBackend?.supplierRfq?.submitQuote?.({ invitation_id: inv.id, supplier_quote_ref: d.ref || null, lines: linesPayload });
      await load();
      window.notifySuccess?.("Quote captured", vendorById.get(inv.vendor_id)?.vendor_name || "vendor");
      onChanged?.();
    } catch (e: any) { window.notifyError?.("Could not save quote", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const award = async () => {
    const awards = Object.entries(picks)
      .filter(([, invId]) => invId)
      .map(([lineNo, invId]) => ({ line_no: Number(lineNo), invitation_id: invId }));
    if (!awards.length) { window.notifyError?.("No winners selected", "Pick a vendor per line first."); return; }
    setBusy(true);
    try {
      const r: any = await AnvilBackend?.supplierRfq?.award?.({ rfq_id: rfqId, awards });
      await load();
      const fed = r?.fed || 0;
      const eligible = r?.eligible || 0;
      if (!r?.source_quote_id) {
        window.notifyWarn?.("Awarded", "This RFQ isn't linked to a quote, so nothing was fed to a composition. Raise the RFQ from a quote's Vendor RFQ tab to enable that.");
      } else if (fed > 0) {
        window.notifySuccess?.("Awarded", `${fed} line(s) fed into the quote composition. Open the Composition tab to review + recompute.`);
      } else {
        const why = r?.feed_errors?.[0] || (eligible === 0 ? "no captured winning prices matched" : "no composition lines matched the awarded line numbers");
        window.notifyError?.("Awarded, but not mapped to composition", why);
      }
      onChanged?.();
    } catch (e: any) { window.notifyError?.("Could not award", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  if (err) return <Banner kind="bad" icon={Icon.alert} title="RFQ"><span className="mono-sm">{err}</span></Banner>;
  if (!data) return <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 12 }}>Loading RFQ…</div>;

  const statusChip = (s: string) => <Chip k={s === "awarded" ? "good" : s === "sent" || s === "quoting" ? "info" : "ghost"}>{s}</Chip>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <datalist id="rfq-currencies">{currencyOptions.map((c) => <option key={c} value={c} />)}</datalist>
      {/* Header */}
      <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{rfq?.rfq_number || "RFQ"}</div>
        {statusChip(rfq?.status || "draft")}
        {rfq?.source_quote_id ? <Chip k="info">linked to quote</Chip> : <Chip k="ghost">not linked to a quote</Chip>}
        <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{lines.length} line(s) · {invitations.length} vendor(s)</span>
      </div>

      {/* End customer + default reference (special-rate basis) */}
      {rfq?.customer_id && (
        <Card title="End customer" eyebrow="vendors are asked to quote this customer's special rates">
          <div className="row" style={{ gap: 12, alignItems: "end", flexWrap: "wrap" }}>
            <div>
              <div className="label">customer</div>
              <div className="mono">{customerName || rfq.customer_id.slice(0, 8)}</div>
            </div>
            <div>
              <div className="label">default customer reference</div>
              <input className="input mono" style={{ width: 200 }} defaultValue={rfq.customer_ref || ""}
                     placeholder="ref used in the RFQ email"
                     onBlur={(e) => saveDefaultRef(e.target.value.trim())} />
            </div>
            <span className="mono-sm" style={{ color: "var(--ink-4)" }}>
              Sent to vendors so subsidiaries apply the agreed customer rate. Each vendor's own code can override below.
            </span>
          </div>
        </Card>
      )}

      {/* Invite vendors */}
      <Card title="Vendors" eyebrow="invite + send RFQ email">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <div>
            <div className="label">add a vendor</div>
            <select className="select" value={addVendorId} onChange={(e) => setAddVendorId(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">select vendor…</option>
              {uninvited.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
            </select>
          </div>
          <Btn sm kind="primary" disabled={!addVendorId || busy} onClick={addVendor}>{Icon.send} Invite + send</Btn>
          <div style={{ flex: 1 }} />
          <div>
            <div className="label">new vendor</div>
            <input className="input" value={newVendor} placeholder="vendor name" onChange={(e) => setNewVendor(e.target.value)} style={{ width: 180 }} />
          </div>
          <Btn sm kind="ghost" disabled={!newVendor.trim() || busy} onClick={quickAddVendor}>{Icon.plus} Add vendor</Btn>
        </div>
        {invitations.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {invitations.map((inv) => (
              <div key={inv.id} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Chip k={inv.response_status === "quoted" ? "good" : "ghost"}>
                  {vendorById.get(inv.vendor_id)?.vendor_name || "vendor"} · {inv.response_status}
                </Chip>
                {rfq?.customer_id && (
                  <span className="row" style={{ gap: 4, alignItems: "center" }}>
                    <span className="mono-sm" style={{ color: "var(--ink-4)" }}>cust ref:</span>
                    <input className="input mono" style={{ width: 150 }}
                           defaultValue={refByVendor.get(inv.vendor_id) || ""}
                           placeholder={rfq.customer_ref || "this vendor's code"}
                           title="The reference this vendor knows the customer by (used in the RFQ email). Reused across RFQs."
                           onBlur={(e) => saveVendorRef(inv.vendor_id, e.target.value.trim())} />
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Capture per vendor */}
      {invitations.map((inv) => {
        const d = capture[inv.id] || ensureDraft(inv);
        const vname = vendorById.get(inv.vendor_id)?.vendor_name || "vendor";
        return (
          <Card key={inv.id} title={vname} eyebrow="capture this vendor's quote"
                right={<Btn sm kind="primary" disabled={busy} onClick={() => saveCapture(inv)}>{Icon.check} Save quote</Btn>}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <div>
                <div className="label">quote reference</div>
                <input className="input mono" style={{ width: 180 }} value={d.ref || ""} placeholder="vendor quote no." onChange={(e) => setCap(inv.id, { ref: e.target.value })} />
              </div>
              <div>
                <div className="label">currency</div>
                <input className="input mono" style={{ width: 90 }} list="rfq-currencies" value={d.currency || "USD"} onChange={(e) => setCap(inv.id, { currency: e.target.value.toUpperCase() })} />
              </div>
            </div>
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead><tr><th>#</th><th>Part</th><th>Description</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">Lead (days)</th></tr></thead>
              <tbody>
                {lines.map((ln) => {
                  const cell = (d.lines || {})[ln.line_no] || {};
                  return (
                    <tr key={ln.line_no}>
                      <td className="mono">{ln.line_no}</td>
                      <td className="mono">{ln.part_number || "—"}</td>
                      <td>{ln.description || "—"}</td>
                      <td className="r mono">{ln.quantity ?? "—"}</td>
                      <td className="r"><input className="input mono r" style={{ width: 90 }} type="number" step="0.01" value={cell.unit_price ?? ""} onChange={(e) => setCapLine(inv.id, ln.line_no, { unit_price: e.target.value })} /></td>
                      <td className="r"><input className="input mono r" style={{ width: 70 }} type="number" value={cell.lead_time_days ?? ""} onChange={(e) => setCapLine(inv.id, ln.line_no, { lead_time_days: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        );
      })}

      {/* Compare + award */}
      {invitations.length > 0 && (
        <Card title="Compare + award" eyebrow="lowest price flagged · pick a winner per line"
              right={<Btn sm kind="primary" disabled={busy} onClick={award}>{Icon.check} Award {rfq?.source_quote_id ? "+ feed composition" : ""}</Btn>}>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead><tr>
                <th>#</th><th>Part</th><th className="r">Qty</th>
                {invitations.map((inv) => <th key={inv.id} className="r">{vendorById.get(inv.vendor_id)?.vendor_name || "vendor"}</th>)}
              </tr></thead>
              <tbody>
                {lines.map((ln) => {
                  // lowest price across invitations for this line
                  let lowest = Infinity;
                  invitations.forEach((inv) => { const q = quoteFor(inv.id, ln.line_no); if (q?.unit_price != null) lowest = Math.min(lowest, Number(q.unit_price)); });
                  return (
                    <tr key={ln.line_no}>
                      <td className="mono">{ln.line_no}</td>
                      <td className="mono">{ln.part_number || "—"}</td>
                      <td className="r mono">{ln.quantity ?? "—"}</td>
                      {invitations.map((inv) => {
                        const q = quoteFor(inv.id, ln.line_no);
                        const isLow = q?.unit_price != null && Number(q.unit_price) === lowest;
                        const picked = picks[ln.line_no] === inv.id;
                        return (
                          <td key={inv.id} className="r" style={{ background: picked ? "var(--paper-3)" : undefined }}>
                            {q?.unit_price != null ? (
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }} title={q.supplier_quote_ref ? "ref: " + q.supplier_quote_ref : ""}>
                                <input type="radio" name={"win-" + ln.line_no} checked={picked} onChange={() => setPicks((p) => ({ ...p, [ln.line_no]: inv.id }))} />
                                <span className="mono" style={{ fontWeight: isLow ? 700 : 400 }}>
                                  {q.currency} {Number(q.unit_price).toLocaleString()}{isLow ? " ★" : ""}
                                </span>
                              </label>
                            ) : <span className="mono-sm" style={{ color: "var(--ink-4)" }}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rfq?.source_quote_id && (
            <div className="mono-sm" style={{ color: "var(--ink-4)", marginTop: 8 }}>
              Awarding feeds each winner's price + currency + quote reference into this quote's composition line.
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

export default RfqDetail;
