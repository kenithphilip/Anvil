// "Where is my TNA-16-04-40-2?"
//
// shipment_import has persisted per-part rows into shipment_lines (mig 209)
// since PR #393, and until now exactly one thing read them — the Pending Sales
// Order tracker, server-side. So the data to answer a customer's question was
// already in the database and nothing could ask it. An operator answered from
// the spreadsheet the import exists to replace.
//
// Each hit shows the shipment's ladder rather than a row id, because the useful
// answer is "on XIN MEI ZHOU, arrived Nhava Sheva 12 Aug, received 15 Aug".

import React, { useCallback, useRef, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

interface Row {
  id: string;
  part_no: string;
  description?: string | null;
  qty?: number | null;
  received_qty?: number | null;
  receipt_date?: string | null;
  remark?: string | null;
  stage: "received" | "at_port" | "in_transit" | "booked";
  shipment: Record<string, any>;
}

const STAGE: Record<string, { label: string; kind: string }> = {
  received:   { label: "received",   kind: "good" },
  at_port:    { label: "at port",    kind: "info" },
  in_transit: { label: "in transit", kind: "warn" },
  booked:     { label: "booked",     kind: "ghost" },
};

const d = (v?: string | null) => (v ? String(v).slice(0, 10) : null);

export const PartTrackingSearch: React.FC = () => {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Guards against an older, slower response overwriting a newer one — the
  // classic search race, and the reason a fast typist sees stale results.
  const seq = useRef(0);

  const run = useCallback(async (term: string) => {
    const text = term.trim();
    if (!text) { setRows(null); setMeta(null); setErr(null); return; }
    const mine = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const r: any = await AnvilBackend?.partTracking?.search?.(text);
      if (mine !== seq.current) return;
      setRows(r?.rows || []);
      setMeta({ total: r?.total ?? 0, truncated: !!r?.truncated });
    } catch (e: any) {
      if (mine !== seq.current) return;
      setErr(e?.message ? String(e.message) : "Search failed.");
      setRows(null);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  return (
    <Card>
      <div style={{ padding: "14px 16px" }}>
        <WSTitle title="Find a part" />
        <p className="mono-sm" style={{ color: "var(--ink-3)", margin: "4px 0 10px", maxWidth: "62ch" }}>
          Search every inbound shipment line by part number or description. Matches show which
          shipment carried the part and how far along it is.
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); run(q); }}
          style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="TNA-16-04-40-2, or 'oil seal'"
            aria-label="Part number or description"
            disabled={busy}
            style={{
              flex: 1, minWidth: 0, border: "1px solid var(--hairline)", borderRadius: 8,
              padding: "7px 10px", font: "inherit", fontSize: 12.5,
              background: "var(--paper)", color: "var(--ink)",
            }}
          />
          <Btn kind="primary" disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search"}</Btn>
        </form>

        {err && <Banner kind="bad" icon={Icon.alert} title="Search failed"><div className="mono-sm">{err}</div></Banner>}

        {rows && rows.length === 0 && !busy && (
          <Banner kind="info" icon={Icon.info} title="No shipment line matches that">
            <div className="mono-sm">
              Inbound lines only appear after the “In Transit Items Details” workbook has been
              imported alongside its shipment summary. If a part is missing, that pair may not have
              been uploaded together.
            </div>
          </Banner>
        )}

        {rows && rows.length > 0 && (
          <>
            <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>
              {meta?.total} match{meta?.total === 1 ? "" : "es"}
              {/* Saying only "showing 50" would read as "there are 50". */}
              {meta?.truncated && <> · showing the {rows.length} most recent</>}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Part</th><th>Qty</th><th>Stage</th><th>Invoice</th>
                    <th>Vessel / flight</th><th>Discharge</th>
                    <th>Sailed</th><th>Arrived</th><th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const s = r.shipment || {};
                    const st = STAGE[r.stage] || STAGE.booked;
                    return (
                      <tr key={r.id}>
                        <td>
                          <span className="mono">{r.part_no || "—"}</span>
                          {r.description && (
                            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.description}</div>
                          )}
                        </td>
                        <td className="mono">{r.qty ?? "—"}</td>
                        <td><Chip k={st.kind as any}>{st.label}</Chip></td>
                        <td className="mono-sm">{s.shipper_invoice_no || "—"}</td>
                        <td className="mono-sm">
                          {s.vessel_or_flight || s.carrier || "—"}
                          {s.mode && <> <Chip k="ghost">{s.mode}</Chip></>}
                        </td>
                        <td className="mono-sm">{s.port_of_discharge || "—"}</td>
                        <td className="mono-sm">{d(s.vessel_sailing_date) || "—"}</td>
                        <td className="mono-sm">{d(s.port_arrival_date) || "—"}</td>
                        <td className="mono-sm">{d(r.receipt_date || s.warehouse_receipt_date) || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
};
