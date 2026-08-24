import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Mode A / Mode B: whether Anvil processes sales orders or only watches.
//
// This is the screen where a customer decides whether software may write to
// their financial ledger, so both paths are laid out in full and side by side
// rather than hidden behind a toggle with a one-line label. Somebody choosing
// this needs to see what they are giving up as clearly as what they are
// getting.
//
// The descriptions come from the API, not from this file. Two copies of what
// the modes mean would drift, and the copy on the screen is the one a customer
// reads before deciding. Saved via /api/admin/so_processing_mode; enforced in
// tally/push.js, which refuses to push in Mode B.

// Em-dash, never 0%, when a rate is null: a rate over an empty denominator
// reads as a perfect score.
const pctOf = (v: number | null | undefined) =>
  (v === null || v === undefined ? "—" : `${Math.round(v * 1000) / 10}%`);

type ModeInfo = {
  mode: string;
  label: string;
  summary: string;
  anvil_does: string[];
  you_do: string[];
  tradeoff: string;
};

export const SoProcessingModeEditor: React.FC = () => {
  const canEdit = RBAC.isAdmin?.() ?? false;
  const [mode, setMode] = useState<string | null>(null);
  const [modes, setModes] = useState<Record<string, ModeInfo>>({});
  const [applied, setApplied] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // The running score. This is what makes the choice evidence-led rather than
  // a leap: a month of the customer's OWN orders with both answers side by
  // side, rather than a vendor's accuracy claim about a benchmark.
  const [summary, setSummary] = useState<any>(null);

  const load = () => {
    setErr(null);
    Promise.resolve(AnvilBackend?.docai?.soProcessingMode?.())
      .then((r: any) => {
        setMode(r?.mode || "A");
        setModes(r?.modes || {});
        setApplied(r?.applied !== false);
      })
      .catch((e: any) => setErr(e?.message || String(e)));
    // Separate and non-fatal: a comparison that cannot be summarised must not
    // stop somebody reading, or changing, their mode.
    Promise.resolve(AnvilBackend?.orders?.threeWaySummary?.())
      .then((r: any) => setSummary(r || null))
      .catch(() => setSummary(null));
  };

  useEffect(load, []);

  const choose = async (next: string) => {
    if (!canEdit || next === mode) return;
    setBusy(true); setErr(null); setFlash(null);
    try {
      const r: any = await AnvilBackend?.docai?.setSoProcessingMode?.(next);
      setMode(r?.mode || next);
      setFlash(next === "B"
        ? "Mode B. Anvil will not push vouchers to your ERP. Everything else — reading POs, reconciling, proposing — carries on."
        : "Mode A. Anvil will push approved sales orders to your ERP.");
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setBusy(false); }
  };

  const order = ["A", "B"];

  return (
    <Card title="Sales-order processing" eyebrow="who raises the sales order">
      {err && <Banner kind="bad" title="Could not load or save">{err}</Banner>}
      {flash && <Banner kind="ok" title="Saved">{flash}</Banner>}
      {!applied && (
        <Banner kind="warn" title="Not stored yet">
          <span className="mono-sm">
            Migration 221 has not been applied to this database, so the choice cannot be saved. Until it is,
            every tenant behaves as Mode A — Anvil pushes.
          </span>
        </Banner>
      )}
      {!canEdit && (
        <Banner kind="info" title="Read-only">
          <span className="mono-sm">
            This decides whether Anvil writes to your ERP, so only an admin can change it.
          </span>
        </Banner>
      )}

      {summary?.available && (
        <div style={{ marginTop: 12 }}>
          <KPIRow>
            <KPI lbl="Anvil differs from the PO" v={pctOf(summary.score?.anvil_error_rate)} />
            <KPI lbl="Your process differs from the PO" v={pctOf(summary.score?.process_deviation_rate)} />
            <KPI lbl="Orders compared" v={String(summary.orders_compared ?? 0)} />
            <KPI lbl="Fields compared" v={String(summary.score?.decidable ?? 0)} />
          </KPIRow>

          {/* A thin score read as a verdict is how somebody hands over their
              sales-order processing on four fields of evidence. */}
          {summary.confidence && !summary.confidence.sufficient && (
            <Banner kind="warn" title="Not enough compared yet to decide on">
              <span className="mono-sm">{summary.confidence.detail}</span>
            </Banner>
          )}

          {summary.both_deviated_orders > 0 && (
            <Banner kind="bad" title={`${summary.both_deviated_orders} order${summary.both_deviated_orders === 1 ? "" : "s"} where Anvil and your ERP agreed — and the PO did not`}>
              <span className="mono-sm">
                Comparing the two against each other would have shown no problem at all. Only checking both
                against the purchase order finds these.
              </span>
            </Banner>
          )}

          {Array.isArray(summary.by_field) && summary.by_field.length > 0 && (
            <div className="mono-sm" style={{ marginTop: 8, opacity: 0.85 }}>
              Most disagreed field{summary.by_field.length === 1 ? "" : "s"}:{" "}
              {summary.by_field.slice(0, 3).map((f: any) => `${f.field} (${f.anvil_wrong + f.process_wrong} of ${f.decidable})`).join(", ")}
            </div>
          )}

          {Array.isArray(summary.skipped) && summary.skipped.length > 0 && (
            // Named rather than dropped: an order silently missing from a
            // denominator is how a score flatters itself.
            <div className="mono-sm" style={{ marginTop: 6, opacity: 0.7 }}>
              {summary.skipped.length} attached sales order{summary.skipped.length === 1 ? "" : "s"} could not
              be read, and {summary.skipped.length === 1 ? "is" : "are"} excluded from the figures above.
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 12 }}>
        {order.map((key) => {
          const m = modes[key];
          if (!m) return null;
          const selected = mode === key;
          return (
            <div
              key={key}
              style={{
                border: "1px solid var(--line)",
                // The selected card carries the accent; the other stays quiet.
                // Two competing highlights on a two-way choice reads as neither
                // being chosen.
                outline: selected ? "2px solid var(--accent)" : "none",
                borderRadius: 10,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                background: selected ? "var(--surface-2)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                <strong>Mode {m.mode} — {m.label}</strong>
                {selected && <Chip k="ok">Current</Chip>}
              </div>

              <div className="mono-sm" style={{ opacity: 0.9 }}>{m.summary}</div>

              <div>
                <div className="mono-sm" style={{ opacity: 0.7, marginBottom: 4 }}>Anvil does</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {m.anvil_does.map((line, i) => (
                    <li key={i} className="mono-sm">{line}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="mono-sm" style={{ opacity: 0.7, marginBottom: 4 }}>You do</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {m.you_do.map((line, i) => (
                    <li key={i} className="mono-sm">{line}</li>
                  ))}
                </ul>
              </div>

              {/* The trade-off, not buried. It is the sentence the decision
                  actually turns on. */}
              <div className="mono-sm" style={{ opacity: 0.85, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                {m.tradeoff}
              </div>

              <Btn
                kind={selected ? "ghost" : "primary"}
                disabled={!canEdit || busy || selected}
                onClick={() => choose(key)}
              >
                {selected ? "Currently selected" : `Switch to Mode ${m.mode}`}
              </Btn>
            </div>
          );
        })}
      </div>
    </Card>
  );
};
