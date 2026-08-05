import React, { useMemo, useState } from "react";
import { Banner, Btn } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { useFetch } from "../lib/helpers";
import { parseParts, joinParts, normPart } from "../lib/spare-parts";

// Constrained editor for a spare-matrix cell's part number(s). Instead of free
// typing in the grid (which let typos / non-existent parts in — the integrity
// hole), you SELECT parts from the gun's own BOM. An off-BOM part can still be
// added manually, but it is flagged (⚠) so the divergence is visible.
export const SparePartPicker: React.FC<{
  gunNo: string; category: string; value: string;
  onApply: (v: string) => void; onClose: () => void;
}> = ({ gunNo, category, value, onApply, onClose }) => {
  const data = useFetch(() => (AnvilBackend?.bom?.assetByCode ? AnvilBackend.bom.assetByCode(gunNo) : Promise.resolve(null)), [gunNo]);
  const lines: any[] = (data.data as any)?.lines || [];
  const bomSet = useMemo(() => new Set(lines.map((l) => normPart(l.part_no)).filter(Boolean)), [lines]);

  const [selected, setSelected] = useState<string[]>(() => parseParts(value));
  const selSet = useMemo(() => new Set(selected.map(normPart)), [selected]);
  const [q, setQ] = useState("");
  const [sparesOnly, setSparesOnly] = useState(false);
  const [manual, setManual] = useState("");

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return lines.filter((l) => {
      if (sparesOnly && !l.is_spare) return false;
      if (!term) return true;
      return String(l.part_no || "").toLowerCase().includes(term) || String(l.part_name || "").toLowerCase().includes(term);
    });
  }, [lines, q, sparesOnly]);

  const toggle = (partNo: string) => setSelected((s) => {
    const k = normPart(partNo);
    return s.some((p) => normPart(p) === k) ? s.filter((p) => normPart(p) !== k) : [...s, partNo];
  });
  const addManual = () => {
    const p = manual.trim();
    if (p && !selSet.has(normPart(p))) setSelected((s) => [...s, p]);
    setManual("");
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 55, display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={"Pick part for " + category}
        style={{ width: "min(680px, 94vw)", maxHeight: "86vh", background: "var(--paper)", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.04 }}>Spare part · {category}</div>
            <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>Gun {gunNo}</div>
          </div>
          <Btn icon kind="ghost" sm onClick={onClose} title="Close">{Icon.x}</Btn>
        </div>

        <div style={{ padding: "10px 16px", display: "flex", gap: 10, alignItems: "center", borderBottom: "1px solid var(--hairline-2)" }}>
          <input className="input mono" placeholder="Search this gun's BOM parts…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
          <label className="mono-sm" style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--ink-3)", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={sparesOnly} onChange={(e) => setSparesOnly(e.target.checked)} /> spares only
          </label>
        </div>

        <div style={{ overflow: "auto", flex: 1, padding: 8 }}>
          {data.loading && !data.data ? <div className="mono-sm" style={{ padding: 12, color: "var(--ink-3)" }}>Loading BOM…</div>
            : !lines.length ? <Banner kind="info">No BOM found for gun <b>{gunNo}</b>. Import it (Import BOM) so parts can be selected from it — or add one manually below.</Banner>
            : filtered.length === 0 ? <div className="mono-sm" style={{ padding: 12, color: "var(--ink-3)" }}>No parts match.</div>
            : filtered.map((l, i) => (
              <label key={l.id || i} className="cmdk-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", cursor: "pointer", borderRadius: 6 }}>
                <input type="checkbox" checked={selSet.has(normPart(l.part_no))} onChange={() => toggle(l.part_no)} />
                <span className="mono-sm" style={{ fontWeight: 600, minWidth: 120 }}>{l.part_no || "—"}</span>
                <span className="mono-sm" style={{ color: "var(--ink-3)", flex: 1 }}>{l.part_name || ""}</span>
                {l.is_spare ? <span className="mono-sm" style={{ fontSize: 10, color: "var(--good, #0e7490)", fontWeight: 700 }}>SPARE</span> : null}
                {l.std_category ? <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{l.std_category}</span> : null}
              </label>
            ))}
        </div>

        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--hairline)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Selected:</span>
            {selected.length === 0 ? <span className="mono-sm" style={{ color: "var(--ink-4)" }}>none</span>
              : selected.map((p, i) => {
                const off = bomSet.size > 0 && !bomSet.has(normPart(p));
                return (
                  <span key={i} className="mono-sm" title={off ? "Not in this gun's BOM" : ""}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--hairline-2)", background: off ? "var(--warn-bg, #fdf3e3)" : "var(--paper-2)", color: off ? "var(--warn, #b45309)" : "var(--ink)" }}>
                    {p}{off ? " ⚠" : ""}
                    <button onClick={() => toggle(p)} title="Remove" style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", padding: 0, fontSize: 12 }}>×</button>
                  </span>
                );
              })}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input className="input mono" placeholder="Add a part not in the BOM (flagged)…" value={manual}
              onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }} style={{ flex: 1 }} />
            <Btn sm kind="ghost" onClick={addManual} disabled={!manual.trim()}>Add manual</Btn>
            <span style={{ width: 12 }} />
            <Btn sm kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn sm kind="primary" onClick={() => { onApply(joinParts(selected)); onClose(); }}>Apply</Btn>
          </div>
        </div>
      </div>
    </div>
  );
};
