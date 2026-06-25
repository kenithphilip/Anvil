import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RfqDetail } from "../components/RfqDetail";

// ============================================================
// ANVIL v3 — Supplier RFQ (Procurement)
// Buyer's workspace: list all internal RFQs, open one to invite vendors,
// capture quote prices + references, compare, and award. RFQs raised from a
// quote (source_quote_id) feed the winner back into that quote's composition.
// Shares the RfqDetail workspace with the quote-drawer Vendor RFQ tab.
// ============================================================

const smFmtTs = (iso?: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

const NewRfqModal: React.FC<{ onCreate: (lines: any[], notes: string) => void; onClose: () => void; busy: boolean }> = ({ onCreate, onClose, busy }) => {
  const [rows, setRows] = useState<any[]>([{ part_number: "", description: "", quantity: 1, uom: "NO" }]);
  const [notes, setNotes] = useState("");
  const setRow = (i: number, patch: any) => setRows((r) => r.map((x, idx) => idx === i ? { ...x, ...patch } : x));
  const addRow = () => setRows((r) => [...r, { part_number: "", description: "", quantity: 1, uom: "NO" }]);
  const delRow = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i));
  const submit = () => {
    const lines = rows
      .filter((r) => r.part_number || r.description)
      .map((r, idx) => ({ line_no: idx, part_number: r.part_number || null, description: r.description || null, quantity: r.quantity != null ? Number(r.quantity) : null, uom: r.uom || null }));
    if (!lines.length) { window.notifyError?.("No lines", "Add at least one line."); return; }
    onCreate(lines, notes);
  };
  return (
    <div className="cmdk-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="New RFQ">
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 680, maxHeight: "85vh" }}>
        <div className="drawer-h">
          <div><div className="h-eyebrow">Procurement</div><div className="h2" style={{ marginTop: 2 }}>New RFQ</div></div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">{Icon.x}</button>
        </div>
        <div style={{ padding: 16, overflow: "auto", flex: 1 }}>
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead><tr><th>#</th><th>Part</th><th>Description</th><th className="r">Qty</th><th>UoM</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{i}</td>
                  <td><input className="input mono" style={{ width: 130 }} value={r.part_number} onChange={(e) => setRow(i, { part_number: e.target.value })} /></td>
                  <td><input className="input" style={{ width: 220 }} value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} /></td>
                  <td className="r"><input className="input mono r" style={{ width: 70 }} type="number" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} /></td>
                  <td><input className="input mono" style={{ width: 60 }} value={r.uom} onChange={(e) => setRow(i, { uom: e.target.value })} /></td>
                  <td><Btn icon sm kind="ghost" onClick={() => delRow(i)}>{Icon.x}</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Btn sm kind="ghost" onClick={addRow} style={{ marginTop: 8 }}>{Icon.plus} Add line</Btn>
          <div style={{ marginTop: 12 }}>
            <div className="label">notes (optional)</div>
            <input className="input" style={{ width: "100%" }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--hairline)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn sm kind="ghost" onClick={onClose}>Cancel</Btn>
          <Btn sm kind="primary" disabled={busy} onClick={submit}>{busy ? "Creating…" : "Create RFQ"}</Btn>
        </div>
      </div>
    </div>
  );
};

const SupplierRfqScreen: React.FC = () => {
  const [rfqs, setRfqs] = useState<any[] | null>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr("");
    try {
      const r: any = await ObaraBackend?.supplierRfq?.list?.();
      const list = Array.isArray(r) ? r : (r?.rfqs || []);
      setRfqs(list);
      if (list.length && !activeId) setActiveId(list[0].id);
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const onCreate = async (lines: any[], notes: string) => {
    setBusy(true);
    try {
      const r: any = await ObaraBackend?.supplierRfq?.create?.({ lines, notes: notes || null });
      const created = r?.rfq || r;
      setShowNew(false);
      await load();
      if (created?.id) setActiveId(created.id);
      window.notifySuccess?.("RFQ created", created?.rfq_number || "");
    } catch (e: any) { window.notifyError?.("Could not create RFQ", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <WSTitle eyebrow="Procurement · Supplier RFQ" title="Supplier RFQ" meta="invite vendors · capture quotes · compare · award"
               right={<Btn sm kind="primary" onClick={() => setShowNew(true)}>{Icon.plus} New RFQ</Btn>} />
      <div className="ws-content">
        {err && <Banner kind="bad" icon={Icon.alert} title="Could not load RFQs"><span className="mono-sm">{err}</span></Banner>}
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14, alignItems: "start" }}>
          <Card flush>
            {rfqs == null ? (
              <div className="body" style={{ padding: 14, color: "var(--ink-3)" }}>Loading…</div>
            ) : rfqs.length === 0 ? (
              <div className="body" style={{ padding: 14, color: "var(--ink-3)" }}>No RFQs yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {rfqs.map((r) => (
                  <div key={r.id} role="button" tabIndex={0}
                       onClick={() => setActiveId(r.id)}
                       onKeyDown={(e) => { if (e.key === "Enter") setActiveId(r.id); }}
                       style={{ padding: "10px 12px", cursor: "pointer", borderBottom: "1px solid var(--hairline-2)", background: r.id === activeId ? "var(--paper-4)" : "transparent" }}>
                    <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>{r.rfq_number || r.id.slice(0, 8)}</span>
                      <Chip k={r.status === "awarded" ? "good" : r.status === "sent" || r.status === "quoting" ? "info" : "ghost"}>{r.status}</Chip>
                    </div>
                    <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10, marginTop: 2 }}>
                      {r.source_quote_id ? "from quote" : r.source_order_id ? "from order" : "manual"} · {smFmtTs(r.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <div>
            {activeId ? <RfqDetail rfqId={activeId} onChanged={load} /> : (
              <Card><div className="body" style={{ padding: 24, textAlign: "center", color: "var(--ink-3)" }}>Select an RFQ, or click <b>New RFQ</b>.</div></Card>
            )}
          </div>
        </div>
      </div>
      {showNew && <NewRfqModal onCreate={onCreate} onClose={() => setShowNew(false)} busy={busy} />}
    </>
  );
};

export default SupplierRfqScreen;
