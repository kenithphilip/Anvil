import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RfqDetail } from "./RfqDetail";

// Vendor-RFQ tab inside the quote drawer. Raises an internal RFQ from the
// quote's own lines (linked via source_quote_id), lists RFQs for this quote,
// and embeds the shared RfqDetail workspace. Awarding a winner feeds the
// vendor's price + quote reference back into this quote's composition.

export const QuoteRfqTab: React.FC<{ quoteId: string; lines: any[] }> = ({ quoteId, lines }) => {
  const [rfqs, setRfqs] = useState<any[] | null>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const load = async () => {
    setErr("");
    try {
      const r: any = await ObaraBackend?.supplierRfq?.list?.({ source_quote_id: quoteId });
      const list = Array.isArray(r) ? r : (r?.rfqs || []);
      setRfqs(list);
      if (list.length && !activeId) setActiveId(list[0].id);
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [quoteId]);

  const raise = async () => {
    const payloadLines = (lines || [])
      .filter((ln) => ln.part_no || ln.description)
      .map((ln) => ({
        line_no: ln.line_index,
        part_number: ln.part_no || null,
        description: ln.description || null,
        quantity: ln.qty != null ? Number(ln.qty) : null,
        uom: ln.uom || null,
      }));
    if (!payloadLines.length) { window.notifyError?.("No lines", "Add quote lines first (Lines tab)."); return; }
    setBusy(true);
    try {
      const r: any = await ObaraBackend?.supplierRfq?.create?.({ source_quote_id: quoteId, lines: payloadLines });
      const created = r?.rfq || r;
      await load();
      if (created?.id) setActiveId(created.id);
      window.notifySuccess?.("RFQ raised", `${payloadLines.length} line(s) from this quote`);
    } catch (e: any) { window.notifyError?.("Could not raise RFQ", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {err && <Banner kind="bad" icon={Icon.alert} title="Vendor RFQ"><span className="mono-sm">{err}</span></Banner>}

      <Card title="Vendor RFQs for this quote" eyebrow="raise an internal RFQ from the quote lines"
            right={<Btn sm kind="primary" disabled={busy} onClick={raise}>{Icon.plus} Raise RFQ from quote lines</Btn>}>
        {rfqs == null ? (
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Loading…</div>
        ) : rfqs.length === 0 ? (
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
            No RFQs yet. Click <b>Raise RFQ from quote lines</b> to send one to vendors and capture their prices + quote references.
          </div>
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {rfqs.map((r) => (
              <Btn key={r.id} sm kind={r.id === activeId ? "primary" : "ghost"} onClick={() => setActiveId(r.id)}>
                {r.rfq_number || r.id.slice(0, 8)} <Chip k={r.status === "awarded" ? "good" : "ghost"}>{r.status}</Chip>
              </Btn>
            ))}
          </div>
        )}
      </Card>

      {activeId && <RfqDetail rfqId={activeId} onChanged={load} />}
    </div>
  );
};

export default QuoteRfqTab;
