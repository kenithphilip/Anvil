// CM PDM P1b: bridge a DocAI assembly_bom extraction to the /api/bom/import
// { asset, lines } contract.
//
// The assembly drawing's normalized output (from claude.js/gemini.js
// normalizeAssemblyBom) is a title block + a flat parts-list keyed by balloon
// number. The BOM ingestion path wants { asset:{asset_code,...}, lines:[{part_no,
// qty,...}] }. This is the pure, I/O-free translation between them, kept
// separate from the endpoint so it is exhaustively unit-testable.
//
// Field traps this handles (see the P1b scout):
//   - normalized lines use camelCase partNumber/quantity -> part_no/qty.
//   - title_block.asset_code is frequently NULL on a drawing; fall back to
//     drawing_no so the BOM root has an identity (import.js 400s without one).
//   - a balloon row with no part number can't become a bom_line (import.js
//     drops it); surface the drop rather than silently reporting success.
//   - the parts list is a single flat level under the assembly -> level 1.

const trimOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

// mapAssemblyBomToImport(normalized, overrides?) -> { asset, lines, warnings, meta }
//   overrides: operator corrections applied over the title block —
//     { asset_code?, revision?, asset_name?, drawing_no?, customer_id? }.
//   asset.asset_code may be "" when neither the title block nor an override
//   supplies one; the caller must refuse to commit in that case.
export const mapAssemblyBomToImport = (normalized, overrides = {}) => {
  const norm = normalized || {};
  const tb = norm.title_block || {};
  const ov = overrides || {};

  const assetCode = trimOrNull(ov.asset_code) || trimOrNull(tb.asset_code) || trimOrNull(tb.drawing_no) || "";
  // revision is part of the (tenant, asset_code, revision) dedupe key; "" is a
  // deliberate, deterministic default (a blank revision is one asset, not a fork).
  const revision = ov.revision != null ? String(ov.revision)
    : (tb.revision != null ? String(tb.revision) : "");
  const drawingNo = trimOrNull(ov.drawing_no) || trimOrNull(tb.drawing_no);

  const asset = {
    asset_code: assetCode,
    name: trimOrNull(ov.asset_name) || trimOrNull(tb.title),
    revision,
    drawing_no: drawingNo,
    customer_id: ov.customer_id || null,
    source_format: "assembly_drawing",
    metadata: {
      extracted_from: "assembly_drawing",
      title: trimOrNull(tb.title),
      title_block_material: trimOrNull(tb.material),
      sheet: trimOrNull(tb.sheet),
      scale: trimOrNull(tb.scale),
    },
  };

  const srcLines = Array.isArray(norm.lines) ? norm.lines : [];
  // Map every parts-list row (unfiltered) into the bom_lines shape. importBom
  // itself drops rows without part_no; we keep them here so the caller can
  // count and warn on how many balloon rows lack a part number.
  const lines = srcLines.map((l) => ({
    part_no: trimOrNull(l?.partNumber),
    part_name: trimOrNull(l?.description),
    qty: l?.quantity ?? null,
    material: trimOrNull(l?.material),
    is_spare: l?.is_spare ?? null,
    bought_out: l?.bought_out ?? null,
    balloon_no: trimOrNull(l?.balloon_no),
    level: 1,
    uom: null,
  }));

  const extractedLineCount = lines.length;
  const importableLineCount = lines.filter((l) => l.part_no).length;
  const droppedNoPartNo = extractedLineCount - importableLineCount;
  const statedLineCount = Number.isFinite(norm.stated_line_count) ? norm.stated_line_count : null;

  const warnings = [];
  if (norm.classification && norm.classification !== "assembly_bom") {
    warnings.push({ code: "not_assembly_bom", message: "classified as " + norm.classification });
  }
  if (!assetCode) {
    warnings.push({
      code: "missing_asset_code",
      message: "no asset_code or drawing_no in the title block; supply asset_code to root the BOM",
    });
  }
  if (statedLineCount != null && importableLineCount < statedLineCount) {
    warnings.push({
      code: "line_count_shortfall",
      message: "drawing declares " + statedLineCount + " items; " + importableLineCount + " importable",
      declared: statedLineCount,
      importable: importableLineCount,
    });
  }
  if (droppedNoPartNo > 0) {
    warnings.push({
      code: "lines_without_part_no",
      message: droppedNoPartNo + " parts-list row(s) have a balloon number but no part number",
      count: droppedNoPartNo,
    });
  }
  if (importableLineCount === 0) {
    warnings.push({ code: "no_importable_lines", message: "no parts-list row has a part number" });
  }

  return {
    asset,
    lines,
    warnings,
    meta: {
      classification: norm.classification || null,
      stated_line_count: statedLineCount,
      extracted_line_count: extractedLineCount,
      importable_line_count: importableLineCount,
      dropped_no_part_no: droppedNoPartNo,
    },
  };
};
