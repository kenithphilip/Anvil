import React, { useRef, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — BOM from Drawing (PDM P1c)
// Upload a gun/asset ASSEMBLY drawing (PDF or image) → extract its title
// block + balloon-keyed parts list via DocAI (kind='assembly_bom') → review
// the mapped { asset, lines } + completeness warnings → commit to the BOM
// (bom_assets + bom_lines + item_master + bill_of_materials) via the SAME
// derivation chain an XLSX import uses. Extraction is reviewed BEFORE it
// mutates the BOM: a wrong parts list corrupts spare ordering, so the screen
// never auto-commits — the operator confirms.
//
// Backend: documents.extract(file, {kind:'assembly_bom'}) -> run_id + normalized,
// then bom.fromDrawing({run_id[, commit:true, asset overrides]}) (P1b). Mounted
// by routes.ts as items?view=drawing.
// ============================================================

type Warning = { code: string; message: string; [k: string]: unknown };
type PreviewLine = {
  balloon_no: string | null;
  part_no: string | null;
  part_name: string | null;
  qty: number | null;
  material: string | null;
  is_spare: boolean | null;
};
type PreviewAsset = {
  asset_code: string;
  name: string | null;
  revision: string;
  drawing_no: string | null;
};
type Preview = {
  run_id: string;
  confidence_overall: number | null;
  asset: PreviewAsset;
  lines: PreviewLine[];
  warnings: Warning[];
  meta: {
    classification: string | null;
    stated_line_count: number | null;
    extracted_line_count: number;
    importable_line_count: number;
    dropped_no_part_no: number;
  };
};

// A failed/low-confidence extraction reason -> operator-readable copy.
const REASON_COPY: Record<string, string> = {
  non_drawing: "This document was not recognised as an assembly drawing with a parts list.",
  empty_lines: "No parts-list rows were extracted from the drawing.",
  image_pdf_no_text: "The drawing is an image with no text layer and could not be read. A higher-resolution scan may help.",
  low_confidence: "The extractor was not confident in this drawing. Review carefully before committing.",
  model_refused: "The extractor could not process this file.",
};

const WARN_KIND: Record<string, "warn" | "bad" | "info"> = {
  line_count_shortfall: "warn",
  lines_without_part_no: "warn",
  missing_asset_code: "bad",
  no_importable_lines: "bad",
  not_assembly_bom: "bad",
};

const BomFromDrawing = () => {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "extracting" | "preview" | "committing" | "done">("idle");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState<{ status: string; reason: string } | null>(null);
  const [committed, setCommitted] = useState<{ asset_id: string; lines: number; diff?: { added: number; removed: number; changed: number } } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Operator corrections to the title block, applied on commit.
  const [assetCode, setAssetCode] = useState("");
  const [revision, setRevision] = useState("");
  const [assetName, setAssetName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setFile(null); setPhase("idle"); setPreview(null);
    setFailure(null); setCommitted(null);
    setAssetCode(""); setRevision(""); setAssetName("");
  };

  const runExtraction = async (f: File) => {
    setFile(f);
    setPhase("extracting");
    setPreview(null); setFailure(null); setCommitted(null);
    try {
      const ex: any = await AnvilBackend?.documents?.extract?.(f, { kind: "assembly_bom" });
      if (!ex) throw new Error("Extraction backend not configured");
      if (ex.status !== "ok") {
        setFailure({ status: ex.status || "failed", reason: ex.status_reason || "failed" });
        setPhase("idle");
        return;
      }
      // Dry-run the ingestion mapping so the preview EXACTLY matches what a
      // commit will persist (same server-side mapping + warnings).
      const pv: any = await AnvilBackend?.bom?.fromDrawing?.({ run_id: ex.run_id });
      if (!pv || pv.ok === false) {
        setFailure({ status: "map_failed", reason: (pv && pv.message) || "Could not map the extraction to a BOM" });
        setPhase("idle");
        return;
      }
      const p: Preview = {
        run_id: pv.run_id,
        confidence_overall: ex.confidence_overall ?? null,
        asset: pv.asset,
        lines: pv.lines || [],
        warnings: pv.warnings || [],
        meta: pv.meta,
      };
      setPreview(p);
      setAssetCode(p.asset.asset_code || "");
      setRevision(p.asset.revision || "");
      setAssetName(p.asset.name || "");
      setPhase("preview");
    } catch (err: any) {
      window.notifyError?.("Extraction failed", String(err?.message || err));
      setFailure({ status: "error", reason: String(err?.message || err) });
      setPhase("idle");
    }
  };

  const onPick = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (f) runExtraction(f);
    ev.target.value = "";
  };
  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault(); setDragActive(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) runExtraction(f);
  };

  const importableCount = preview?.meta.importable_line_count ?? 0;
  const canCommit = phase === "preview" && !!assetCode.trim() && importableCount > 0;

  const doCommit = async () => {
    if (!preview || !canCommit) return;
    setPhase("committing");
    try {
      const resp: any = await AnvilBackend?.bom?.fromDrawing?.({
        run_id: preview.run_id,
        commit: true,
        asset_code: assetCode.trim(),
        revision: revision.trim(),
        asset_name: assetName.trim() || undefined,
      });
      if (!resp || resp.ok === false) {
        const msg = (resp && (resp.bom_import_error || resp.message)) || "Commit failed";
        window.notifyError?.("Could not commit to BOM", String(msg));
        setPhase("preview");
        return;
      }
      setCommitted({ asset_id: resp.asset_id, lines: resp.lines, diff: resp.diff });
      setPhase("done");
      window.notifySuccess?.(
        "BOM saved from drawing",
        assetCode.trim() + " · " + resp.lines + " part" + (resp.lines === 1 ? "" : "s"),
      );
    } catch (err: any) {
      window.notifyError?.("Could not commit to BOM", String(err?.message || err));
      setPhase("preview");
    }
  };

  const dropStyle: React.CSSProperties = {
    border: "2px dashed " + (dragActive ? "var(--accent)" : "var(--hairline)"),
    borderRadius: 12,
    padding: "28px 18px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 120ms ease, background 120ms ease",
    background: dragActive ? "var(--paper-2)" : undefined,
  };
  const inputStyle: React.CSSProperties = {
    padding: "6px 10px", border: "1px solid var(--hairline)", borderRadius: 6,
    background: "var(--paper)", color: "var(--ink)", fontSize: 13,
  };
  const conf = preview?.confidence_overall;

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · BOM from Drawing"
        title="Extract BOM from an assembly drawing"
        meta="pdf / image · title block + parts list · review before commit"
        right={<>
          <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/items?view=import")}>{Icon.upload} XLSX import</Btn>
          <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/items")}>{Icon.arrowL} back to Items</Btn>
        </>}
      />

      <div className="ws-content">
        {/* ── Card 1 · Drop a drawing ─────────────────────────── */}
        <Card title="Drop an assembly drawing" eyebrow="step 1">
          <div
            className={`dotgrid ${dragActive ? "active" : ""}`}
            style={dropStyle}
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
            role="button"
            tabIndex={0}
            aria-label="Drop an assembly drawing here"
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <span style={{ width: 32, height: 32, display: "grid", placeItems: "center", color: "var(--ink-2)" }}>{Icon.upload}</span>
              <div className="h2" style={{ margin: 0 }}>Drag a PDF or image of the assembly (GA) drawing here</div>
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                The parts list is read by its balloon numbers. Only the customer-facing assembly drawing is used here — never a part drawing.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                <Btn sm kind="primary" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                  {Icon.plus} Choose a drawing
                </Btn>
                {file && phase !== "extracting" && <Chip k="ghost">{file.name}</Chip>}
                {phase === "extracting" && <Chip k="info">Extracting…</Chip>}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
              style={{ display: "none" }}
              onChange={onPick}
            />
          </div>

          {failure && (
            <div style={{ marginTop: 12 }}>
              <Banner kind="bad" icon={Icon.alert} title={"Could not extract a BOM (" + failure.status + ")"}>
                <span className="mono-sm">{REASON_COPY[failure.reason] || failure.reason}</span>
              </Banner>
            </div>
          )}
        </Card>

        {/* ── Card 2 · Review ─────────────────────────────────── */}
        {(phase === "preview" || phase === "committing" || phase === "done") && preview && (
          <Card
            title="Review the extracted BOM"
            eyebrow="step 2"
            right={<>
              {conf != null && <Chip k={conf >= 0.85 ? "good" : conf >= 0.7 ? "warn" : "bad"}>confidence {Math.round(conf * 100)}%</Chip>}
              <Chip k="ghost">{importableCount} of {preview.meta.extracted_line_count} importable</Chip>
            </>}
          >
            {/* warnings */}
            {preview.warnings.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                {preview.warnings.map((w, i) => (
                  <Banner key={i} kind={WARN_KIND[w.code] || "warn"} icon={Icon.alert} title={w.code.replace(/_/g, " ")}>
                    <span className="mono-sm">{w.message}</span>
                  </Banner>
                ))}
              </div>
            )}

            {/* editable asset header */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="h-eyebrow">Assembly / gun no.</span>
                <input
                  className="mono" value={assetCode}
                  onChange={(e) => setAssetCode(e.target.value.toUpperCase())}
                  style={{ ...inputStyle, width: 200 }}
                  aria-label="Assembly / gun number (BOM root)"
                  placeholder="required"
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="h-eyebrow">Revision</span>
                <input className="mono" value={revision} onChange={(e) => setRevision(e.target.value)} style={{ ...inputStyle, width: 90 }} aria-label="Revision" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 200 }}>
                <span className="h-eyebrow">Title</span>
                <input value={assetName} onChange={(e) => setAssetName(e.target.value)} style={{ ...inputStyle, width: "100%" }} aria-label="Assembly title" />
              </label>
              {preview.asset.drawing_no && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="h-eyebrow">Drawing no.</span>
                  <span className="mono" style={{ padding: "6px 0" }}>{preview.asset.drawing_no}</span>
                </label>
              )}
            </div>

            {/* parts list */}
            <table className="tbl">
              <thead><tr>
                <th style={{ width: 70 }}>Balloon</th>
                <th>Part no.</th>
                <th>Description</th>
                <th className="r">Qty</th>
                <th>Material</th>
                <th>Spare</th>
              </tr></thead>
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={i} style={l.part_no ? undefined : { opacity: 0.55 }}>
                    <td className="mono">{l.balloon_no || "-"}</td>
                    <td className="mono">
                      {l.part_no
                        ? <span className="pri">{l.part_no}</span>
                        : <Chip k="warn">no part no.</Chip>}
                    </td>
                    <td>{l.part_name || "-"}</td>
                    <td className="r mono">{l.qty ?? "-"}</td>
                    <td className="mono-sm">{l.material || "-"}</td>
                    <td>{l.is_spare ? <Chip k="info">spare</Chip> : <span className="mono-sm" style={{ color: "var(--ink-4)" }}>-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {/* ── Card 3 · Commit ─────────────────────────────────── */}
        {(phase === "preview" || phase === "committing" || phase === "done") && preview && (
          <Card
            title="Commit to BOM"
            eyebrow="step 3"
            right={phase === "done"
              ? <Btn sm kind="ghost" onClick={reset}>{Icon.plus} Extract another</Btn>
              : <Btn sm kind="primary" disabled={!canCommit} onClick={doCommit}>
                  {phase === "committing" ? "Saving…" : <>{Icon.check} Save to BOM</>}
                </Btn>}
          >
            {phase === "done" && committed ? (
              <Banner kind="good" icon={Icon.check} title={"Saved " + assetCode + " to the BOM"}>
                <span className="mono-sm">
                  {committed.lines} part{committed.lines === 1 ? "" : "s"} imported
                  {committed.diff ? " (+" + committed.diff.added + " / −" + committed.diff.removed + " / ~" + committed.diff.changed + ")" : ""}.
                  {" "}
                  <a href={"#/items?view=guns"} style={{ color: "var(--accent)" }}>View in Guns</a>.
                </span>
              </Banner>
            ) : !assetCode.trim() ? (
              <div className="mono-sm" style={{ color: "var(--bad)" }}>
                Enter the assembly / gun number above — it roots the BOM.
              </div>
            ) : importableCount === 0 ? (
              <div className="mono-sm" style={{ color: "var(--bad)" }}>
                No parts-list row has a part number, so there is nothing to import. Re-extract a clearer drawing.
              </div>
            ) : (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Saves {importableCount} part{importableCount === 1 ? "" : "s"} under <span className="pri">{assetCode.trim()}</span> into
                item master + bill of materials. Existing lines for this assembly + revision are replaced.
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
};

export default BomFromDrawing;
