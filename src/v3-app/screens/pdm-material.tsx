import React, { useRef, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Raw material from a part drawing (PDM C)
// Manufacturing's human-in-the-loop review: drop a PART drawing → the extractor
// reads its material callout + overall dimensions → the determination engine
// proposes the raw material (make: grade / form / stock size / mass; buy: none)
// → the team confirms or corrects → save persists a recipe that drives raw-
// material procurement (composition_material_lines + bill_of_materials). A
// bought-out part is never given a recipe. Mounted by routes.ts as
// items?view=material.
// ============================================================

type Recipe = {
  material: string | null; material_matched?: boolean; density: number | null;
  geometry_class?: string; form: string | null;
  stock_dims?: Record<string, number> | null; gross_mass_kg: number | null;
  yield_pct: number | null; consumption_per_unit_kg: number | null; uom?: string;
};
type Verdict = { procurement_type: "make" | "buy" | "raw_material"; reason?: string; confidence?: number; recipe: Recipe | null; warnings?: string[] };

const REASON_COPY: Record<string, string> = {
  non_drawing: "This wasn't recognised as a single part drawing.",
  image_pdf_no_text: "The drawing is an image with no readable text. A higher-resolution scan may help.",
  low_confidence: "The extractor wasn't confident — review carefully.",
};

const fmtDims = (d?: Record<string, number> | null): string => {
  if (!d) return "—";
  const parts: string[] = [];
  if (d.diameter) parts.push("Ø" + d.diameter);
  if (d.length) parts.push("L " + d.length);
  if (d.width) parts.push("W " + d.width);
  if (d.height) parts.push("H " + d.height);
  if (d.thickness) parts.push("T " + d.thickness);
  return parts.length ? parts.join(" × ") + " mm" : "—";
};

const PdmMaterial = () => {
  const [phase, setPhase] = useState<"idle" | "extracting" | "review" | "saving" | "done">("idle");
  const [file, setFile] = useState<File | null>(null);
  const [partSpec, setPartSpec] = useState<any>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [finishedPartNo, setFinishedPartNo] = useState("");
  const [allowance, setAllowance] = useState(3);
  const [yieldPct, setYieldPct] = useState(0.85);
  const [failure, setFailure] = useState<{ status: string; reason: string } | null>(null);
  const [saved, setSaved] = useState<{ procurement_type: string; raw_material_part_no: string | null } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setPhase("idle"); setFile(null); setPartSpec(null); setVerdict(null);
    setFinishedPartNo(""); setFailure(null); setSaved(null);
  };

  const determine = async (spec: any, opts: { allowanceMm: number; yieldPct: number }) => {
    const resp: any = await AnvilBackend?.pdm?.determineRawMaterial?.({ part_spec: spec, overrides: { allowanceMm: opts.allowanceMm, yieldPct: opts.yieldPct } });
    return resp;
  };

  const runExtraction = async (f: File) => {
    setFile(f); setPhase("extracting"); setFailure(null); setSaved(null); setVerdict(null);
    try {
      const ex: any = await AnvilBackend?.documents?.extract?.(f, { kind: "part_drawing" });
      if (!ex) throw new Error("Extraction backend not configured");
      if (ex.status !== "ok") { setFailure({ status: ex.status || "failed", reason: ex.status_reason || "failed" }); setPhase("idle"); return; }
      const spec = ex.normalized?.part_spec || null;
      if (!spec) { setFailure({ status: "failed", reason: "non_drawing" }); setPhase("idle"); return; }
      setPartSpec(spec);
      setFinishedPartNo(spec.title_block?.part_no || spec.title_block?.drawing_no || "");
      const resp = await determine(spec, { allowanceMm: allowance, yieldPct });
      setVerdict(resp?.verdict || resp || null);
      setPhase("review");
    } catch (err: any) {
      window.notifyError?.("Extraction failed", String(err?.message || err));
      setFailure({ status: "error", reason: String(err?.message || err) }); setPhase("idle");
    }
  };

  const recompute = async () => {
    if (!partSpec) return;
    setPhase("extracting");
    try {
      const resp = await determine(partSpec, { allowanceMm: allowance, yieldPct });
      setVerdict(resp?.verdict || resp || null);
    } catch (err: any) { window.notifyError?.("Recompute failed", String(err?.message || err)); }
    setPhase("review");
  };

  // Operator flips the make/buy verdict. buy -> drop the recipe (never forecast
  // raw material for a bought-out part); make -> recompute from the drawing.
  const setMakeBuy = async (type: "make" | "buy") => {
    if (!verdict) return;
    if (type === "buy") { setVerdict({ ...verdict, procurement_type: "buy", recipe: null }); return; }
    await recompute();
  };

  const doSave = async () => {
    if (!verdict || !finishedPartNo.trim()) return;
    setPhase("saving");
    try {
      const resp: any = await AnvilBackend?.pdm?.saveRawMaterial?.(finishedPartNo.trim(), verdict);
      if (!resp || resp.error) { window.notifyError?.("Could not save", (resp && resp.error && (resp.error.message || resp.error)) || "save failed"); setPhase("review"); return; }
      setSaved({ procurement_type: resp.procurement_type, raw_material_part_no: resp.raw_material_part_no || null });
      setPhase("done");
      window.notifySuccess?.("Raw material saved", finishedPartNo.trim() + " · " + resp.procurement_type);
    } catch (err: any) { window.notifyError?.("Could not save", String(err?.message || err)); setPhase("review"); }
  };

  const onPick = (ev: React.ChangeEvent<HTMLInputElement>) => { const f = ev.target.files?.[0]; if (f) runExtraction(f); ev.target.value = ""; };
  const onDrop = (ev: React.DragEvent) => { ev.preventDefault(); setDragActive(false); const f = ev.dataTransfer?.files?.[0]; if (f) runExtraction(f); };

  const dropStyle: React.CSSProperties = {
    border: "2px dashed " + (dragActive ? "var(--accent)" : "var(--hairline)"), borderRadius: 12,
    padding: "28px 18px", textAlign: "center", cursor: "pointer", background: dragActive ? "var(--paper-2)" : undefined,
  };
  const inputStyle: React.CSSProperties = { padding: "6px 10px", border: "1px solid var(--hairline)", borderRadius: 6, background: "var(--paper)", color: "var(--ink)", fontSize: 13 };
  const isBuy = verdict?.procurement_type === "buy" || verdict?.procurement_type === "raw_material";
  const r = verdict?.recipe;
  const saving = phase === "saving";
  const canSave = phase === "review" && !!finishedPartNo.trim() && !!verdict;

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · Raw material"
        title="Raw material from a part drawing"
        meta="material + dimensions → make/buy → stock form + size · review before saving"
        right={<>
          <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/items?view=drawing")}>{Icon.upload} Assembly drawing</Btn>
          <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/items")}>{Icon.arrowL} Items</Btn>
        </>}
      />

      <div className="ws-content">
        <Card title="Drop a part drawing" eyebrow="step 1">
          <div className={`dotgrid ${dragActive ? "active" : ""}`} style={dropStyle}
            onClick={() => fileInputRef.current?.click()} onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragActive(true); }} onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
            role="button" tabIndex={0} aria-label="Drop a part drawing here"
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <span style={{ width: 32, height: 32, display: "grid", placeItems: "center", color: "var(--ink-2)" }}>{Icon.upload}</span>
              <div className="h2" style={{ margin: 0 }}>Drop a single-part detail drawing (PDF or image)</div>
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Supplier-only. The material callout + overall dimensions determine the raw stock to buy.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                <Btn sm kind="primary" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>{Icon.plus} Choose a drawing</Btn>
                {file && phase !== "extracting" && <Chip k="ghost">{file.name}</Chip>}
                {phase === "extracting" && <Chip k="info">Working…</Chip>}
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" style={{ display: "none" }} onChange={onPick} />
          </div>
          {failure && (
            <div style={{ marginTop: 12 }}>
              <Banner kind="bad" icon={Icon.alert} title={"Could not read the drawing (" + failure.status + ")"}>
                <span className="mono-sm">{REASON_COPY[failure.reason] || failure.reason}</span>
              </Banner>
            </div>
          )}
        </Card>

        {(phase === "review" || phase === "saving" || phase === "done") && verdict && (
          <Card title="Raw-material determination" eyebrow="step 2 · review + correct"
            right={<>
              {verdict.confidence != null && <Chip k={verdict.confidence >= 0.7 ? "good" : "warn"}>confidence {Math.round(verdict.confidence * 100)}%</Chip>}
              <Chip k={isBuy ? "warn" : "good"}>{verdict.procurement_type}</Chip>
            </>}
          >
            {(verdict.warnings || []).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                {verdict.warnings!.map((w, i) => <Banner key={i} kind="warn" icon={Icon.alert} title="check">{<span className="mono-sm">{w}</span>}</Banner>)}
              </div>
            )}

            {/* make/buy toggle + finished part */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="h-eyebrow">Finished part no.</span>
                <input className="mono" value={finishedPartNo} onChange={(e) => setFinishedPartNo(e.target.value.toUpperCase())} style={{ ...inputStyle, width: 200 }} aria-label="Finished part number" placeholder="required" />
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="h-eyebrow">Make or buy</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn sm kind={!isBuy ? "primary" : "ghost"} onClick={() => setMakeBuy("make")}>Make</Btn>
                  <Btn sm kind={isBuy ? "primary" : "ghost"} onClick={() => setMakeBuy("buy")}>Buy</Btn>
                </div>
              </div>
            </div>

            {isBuy ? (
              <Banner kind="info" icon={Icon.check} title="Bought-out — no raw-material recipe">
                <span className="mono-sm">This part is procured whole. It won't be forecast as raw material.</span>
              </Banner>
            ) : r ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
                  <KV label="material" value={r.material || "—"} warn={r.material_matched === false} />
                  <KV label="form" value={r.form || "—"} />
                  <KV label="part dims" value={fmtDims(partSpec?.dimensions)} />
                  <KV label="stock size" value={fmtDims(r.stock_dims)} />
                  <KV label="gross mass" value={r.gross_mass_kg != null ? r.gross_mass_kg + " kg" : "—"} />
                  <KV label="per unit" value={r.consumption_per_unit_kg != null ? r.consumption_per_unit_kg + " kg" : "—"} />
                </div>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="h-eyebrow">Machining allowance (mm)</span>
                    <input type="number" value={allowance} min={0} step={0.5} onChange={(e) => setAllowance(Number(e.target.value))} style={{ ...inputStyle, width: 120 }} aria-label="Machining allowance mm" />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="h-eyebrow">Yield (0–1)</span>
                    <input type="number" value={yieldPct} min={0.1} max={1} step={0.05} onChange={(e) => setYieldPct(Number(e.target.value))} style={{ ...inputStyle, width: 120 }} aria-label="Yield fraction" />
                  </label>
                  <Btn sm kind="ghost" onClick={recompute}>{Icon.cycle} Recompute</Btn>
                </div>
              </>
            ) : (
              <Banner kind="warn" icon={Icon.alert} title="No recipe">
                <span className="mono-sm">The drawing didn't yield a stock size. Add the material + dimensions, or mark it Buy.</span>
              </Banner>
            )}
          </Card>
        )}

        {(phase === "review" || phase === "saving" || phase === "done") && verdict && (
          <Card title="Save" eyebrow="step 3"
            right={phase === "done"
              ? <Btn sm kind="ghost" onClick={reset}>{Icon.plus} Another part</Btn>
              : <Btn sm kind="primary" disabled={saving || !canSave} onClick={doSave}>{saving ? "Saving…" : <>{Icon.check} Save recipe</>}</Btn>}>
            {phase === "done" && saved ? (
              <Banner kind="good" icon={Icon.check} title={"Saved " + finishedPartNo + " as " + saved.procurement_type}>
                <span className="mono-sm">
                  {saved.procurement_type === "make" && saved.raw_material_part_no
                    ? <>Recipe → <span className="pri">{saved.raw_material_part_no}</span>; the demand planner now drives its procurement.</>
                    : "Recorded as bought-out — excluded from raw-material forecasting."}
                </span>
              </Banner>
            ) : !finishedPartNo.trim() ? (
              <div className="mono-sm" style={{ color: "var(--bad)" }}>Enter the finished part number to save.</div>
            ) : (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                {isBuy
                  ? <>Records <span className="pri">{finishedPartNo.trim()}</span> as bought-out (no raw-material recipe).</>
                  : <>Saves the raw-material recipe for <span className="pri">{finishedPartNo.trim()}</span> → item master + bill of materials.</>}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
};

const KV: React.FC<{ label: string; value: React.ReactNode; warn?: boolean }> = ({ label, value, warn }) => (
  <div>
    <div className="h-eyebrow" style={{ marginBottom: 2 }}>{label}</div>
    <div className="mono" style={{ color: warn ? "var(--warn, var(--ink))" : "var(--ink)" }}>{value}{warn ? <Chip k="warn">confirm</Chip> : null}</div>
  </div>
);

export default PdmMaterial;
