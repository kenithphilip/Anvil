import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
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

  const load = () => {
    setErr(null);
    Promise.resolve(AnvilBackend?.docai?.soProcessingMode?.())
      .then((r: any) => {
        setMode(r?.mode || "A");
        setModes(r?.modes || {});
        setApplied(r?.applied !== false);
      })
      .catch((e: any) => setErr(e?.message || String(e)));
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
