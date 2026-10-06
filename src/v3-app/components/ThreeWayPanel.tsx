import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// The PO, Anvil and the ERP side by side, for one order.
//
// Mode A/B PR 5. The comparison exists to answer a question a person will ask
// once and then act on: where do the three documents disagree, and who was
// right. So the disagreements come first and the agreements are collapsed —
// a table where every row is green teaches somebody to stop reading it.
//
// TWO RATES, never one. Reporting only Anvil's error rate would bury the
// finding that makes this worth running: on the first real pair, two fields
// departed from the PO and neither was Anvil's doing. A customer deciding
// whether to trust Anvil needs to see how often Anvil is wrong AND how often
// the process they have today already is.

type Field = {
  key: string;
  verdict: string;
  authority?: string;
  decidable?: boolean;
  truth?: unknown;
  anvil?: unknown;
  tally?: unknown;
  note?: string;
  reason?: string;
};
type Line = { line: string; aligned_on: string | null; missing_from_erp: boolean; fields: Field[] };
type Report = {
  available: boolean;
  reason?: string;
  detail?: string;
  po_number?: string;
  erp_document?: { voucher_no?: string | null; buyer_ref?: string | null };
  header: Field[];
  lines: Line[];
  erp_only: { part_no?: string; customer_part_no?: string; description?: string; quantity?: number | null }[];
  missing_from_erp: number;
  both_deviated: string[];
  score: {
    decidable: number;
    undecidable: number;
    anvil_error_rate: number | null;
    process_deviation_rate: number | null;
  };
};

// Plain language, because the verdict names are the API's vocabulary and not
// anybody else's. "anvil_correct" is precise and tells an operator nothing.
const VERDICT_COPY: Record<string, { label: string; k: string; blame: string }> = {
  agree:          { label: "Agree",            k: "ok",    blame: "" },
  anvil_correct:  { label: "ERP differs",      k: "warn",  blame: "Anvil matched the PO; the ERP does not." },
  anvil_wrong:    { label: "Anvil differs",    k: "bad",   blame: "The ERP matched the PO; Anvil does not." },
  both_deviate:   { label: "Both differ",      k: "bad",   blame: "Anvil and the ERP agree with each other, and neither matches the PO." },
  all_differ:     { label: "All three differ", k: "bad",   blame: "Three different answers." },
  undecidable:    { label: "Not decidable",    k: "ghost", blame: "The PO does not say, so nobody is scored on it." },
  not_applicable: { label: "Not scored",       k: "ghost", blame: "" },
};

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

const FieldRow: React.FC<{ f: Field }> = ({ f }) => {
  const c = VERDICT_COPY[f.verdict] || { label: f.verdict, k: "ghost", blame: "" };
  return (
    <tr>
      <td className="mono-sm">{f.key}</td>
      <td><Chip k={c.k as never}>{c.label}</Chip></td>
      <td className="mono-sm">{show(f.truth)}</td>
      <td className="mono-sm">{show(f.anvil)}</td>
      <td className="mono-sm">{show(f.tally)}</td>
      <td className="mono-sm" style={{ opacity: 0.75 }}>
        {f.note || c.blame || (f.reason ? f.reason.replace(/_/g, " ") : "")}
      </td>
    </tr>
  );
};

export const ThreeWayPanel: React.FC<{ orderId: string }> = ({ orderId }) => {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAgreed, setShowAgreed] = useState(false);

  const load = () => {
    if (!orderId) return;
    setBusy(true); setErr(null);
    Promise.resolve(AnvilBackend?.orders?.threeWayReport?.(orderId))
      .then((r: any) => setRep(r || null))
      .catch((e: any) => setErr(e?.message || String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(load, [orderId]);

  if (err) return <Banner kind="bad" title="Could not build the comparison">{err}</Banner>;
  if (busy && !rep) return <Card><div className="body mono-sm" style={{ padding: 18 }}>Comparing…</div></Card>;
  if (!rep) return null;

  if (!rep.available) {
    // "Nothing attached" and "compared, no differences" are opposite states
    // that look identical in any summary reporting only a score.
    return (
      <Card title="PO vs Anvil vs ERP">
        <Banner kind="info" title={rep.reason === "no_sales_order_attached" ? "No sales order attached" : "Nothing to compare"}>
          <span className="mono-sm">{rep.detail}</span>
        </Banner>
      </Card>
    );
  }

  const disagreed = (f: Field) => f.verdict !== "agree" && f.verdict !== "not_applicable";
  const headerBad = rep.header.filter(disagreed);
  const headerOk = rep.header.filter((f) => !disagreed(f));
  const lineRows = rep.lines.filter((l) => !l.missing_from_erp);
  const linesBad = lineRows.filter((l) => l.fields.some(disagreed));
  const linesOk = lineRows.filter((l) => !l.fields.some(disagreed));

  return (
    <Card
      title="PO vs Anvil vs ERP"
      eyebrow={`${rep.po_number || "this order"} · ERP voucher ${rep.erp_document?.voucher_no || "—"}`}
      right={<Btn sm kind="ghost" onClick={load} disabled={busy}>Re-compare</Btn>}
    >
      <KPIRow>
        {/* Anvil's rate first because it is the one being evaluated, but the
            process rate is the same size beside it, not a footnote. */}
        <KPI lbl="Anvil differs from the PO" v={pct(rep.score.anvil_error_rate)} />
        <KPI lbl="Your process differs from the PO" v={pct(rep.score.process_deviation_rate)} />
        <KPI lbl="Fields compared" v={String(rep.score.decidable)} />
        {rep.score.undecidable > 0 && (
          <KPI lbl="Not decidable" v={String(rep.score.undecidable)} />
        )}
      </KPIRow>

      {rep.score.decidable === 0 && (
        <Banner kind="warn" title="Nothing could be decided">
          <span className="mono-sm">
            Every field was undecidable — the PO does not state them, or they could not be read. The rates
            above are blank rather than zero, because a rate over nothing is not a perfect score.
          </span>
        </Banner>
      )}

      {rep.both_deviated.length > 0 && (
        // The finding a two-way comparison structurally cannot make. Given its
        // own banner because it is the one most likely to be acted on, and the
        // easiest to miss inside a table of verdicts.
        <Banner kind="bad" title="Anvil and the ERP agree — and the PO says otherwise">
          <span className="mono-sm">
            {rep.both_deviated.join(", ")}. Both sides recorded the same thing and the purchase order does
            not support it, so comparing them against each other would have shown no problem at all.
          </span>
        </Banner>
      )}

      {rep.missing_from_erp > 0 && (
        <Banner kind="bad" title={`${rep.missing_from_erp} ordered line${rep.missing_from_erp === 1 ? "" : "s"} not in the ERP`}>
          <span className="mono-sm">The customer ordered them and no sales-order line records them.</span>
        </Banner>
      )}

      {rep.erp_only.length > 0 && (
        <Banner kind="warn" title={`${rep.erp_only.length} ERP line${rep.erp_only.length === 1 ? "" : "s"} not on the order`}>
          <span className="mono-sm">
            {rep.erp_only.map((e) => e.customer_part_no || e.part_no || e.description).join(", ")} — added by
            hand, and not on the purchase order Anvil read.
          </span>
        </Banner>
      )}

      {(headerBad.length > 0 || linesBad.length > 0) ? (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="tbl" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Field</th><th>Verdict</th><th>PO</th><th>Anvil</th><th>ERP</th><th>Why</th>
              </tr>
            </thead>
            <tbody>
              {headerBad.map((f) => <FieldRow key={"h-" + f.key} f={f} />)}
              {linesBad.map((l) => (
                <React.Fragment key={l.line}>
                  <tr>
                    <td colSpan={6} className="mono-sm" style={{ opacity: 0.7, paddingTop: 10 }}>
                      {l.line}{l.aligned_on ? ` · matched on ${l.aligned_on.replace(/_/g, " ")}` : ""}
                    </td>
                  </tr>
                  {l.fields.filter(disagreed).map((f) => <FieldRow key={l.line + f.key} f={f} />)}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Banner kind="ok" title="Every decidable field agrees">
          <span className="mono-sm">
            The purchase order, Anvil and the ERP say the same thing on all {rep.score.decidable} fields
            that could be compared.
          </span>
        </Banner>
      )}

      {(headerOk.length > 0 || linesOk.length > 0) && (
        // Collapsed by default. A table where every row is green teaches
        // somebody to stop reading it, and then they miss the row that is not.
        <div style={{ marginTop: 12 }}>
          <Btn sm kind="ghost" onClick={() => setShowAgreed((v) => !v)}>
            {showAgreed ? "Hide" : "Show"} the {headerOk.length + linesOk.reduce((n, l) => n + l.fields.length, 0)} fields that agree
          </Btn>
          {showAgreed && (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table className="tbl" style={{ width: "100%" }}>
                <thead>
                  <tr><th>Field</th><th>Verdict</th><th>PO</th><th>Anvil</th><th>ERP</th><th>Why</th></tr>
                </thead>
                <tbody>
                  {headerOk.map((f) => <FieldRow key={"ho-" + f.key} f={f} />)}
                  {linesOk.flatMap((l) => l.fields.map((f) => <FieldRow key={l.line + f.key} f={f} />))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
