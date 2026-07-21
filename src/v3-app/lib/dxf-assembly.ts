// PDM P2: deterministic assembly-BOM extraction from a DXF (native CAD).
//
// A DXF is already structured, so — unlike a scanned PDF — it does NOT need an
// LLM. This is a pure, dependency-free reader of the subset of DXF we care
// about (the ENTITIES: TEXT / MTEXT / INSERT+ATTRIB) plus a conservative
// interpreter that pulls the title block + the parts-list table into the SAME
// preview shape the LLM path produces (see the from-drawing screen), so both
// paths render + commit identically.
//
// DXF is a flat "group code" stream: alternating lines of an integer code then
// its value. Sections are 0/SECTION..0/ENDSEC; entities start at code 0 with
// the entity type. The codes we use: 1=primary text/value, 2=tag or block name,
// 3=MTEXT continuation, 10/20=x/y. INSERTs carry ATTRIB children (each an
// entity with 2=tag, 1=value) until a SEQEND.
//
// Scope: reliably reads title-block ATTRIBs + parts-list "BOM row" attribute
// blocks (the clean, common CAD cases), with a conservative TEXT-grid fallback
// for tables drawn as free text. It does NOT parse ACAD_TABLE cell geometry or
// binary DWG — a DXF whose parts list can't be read deterministically should
// go through the LLM path (drop the PDF instead). Everything here is pure so
// it is exhaustively unit-testable.

export type DxfAttrib = { tag: string; value: string; x: number; y: number };
export type DxfEntity =
  | { type: "TEXT" | "MTEXT"; text: string; x: number; y: number }
  | { type: "INSERT"; block: string; x: number; y: number; attribs: DxfAttrib[] };

type Raw = { type: string; codes: Array<[number, string]> };

const num = (v: string | undefined): number => {
  const n = Number(String(v == null ? "" : v).trim());
  return Number.isFinite(n) ? n : 0;
};
const first = (codes: Array<[number, string]>, code: number): string | undefined => {
  for (const [c, v] of codes) if (c === code) return v;
  return undefined;
};

// Strip MTEXT inline formatting (\P paragraph breaks, {\f..;} font runs, \A/\H
// alignment codes, braces) down to plain text.
const cleanMText = (s: string): string =>
  String(s || "")
    .replace(/\\P/gi, " ")              // paragraph break
    .replace(/\\[A-Za-z][^;\\]*;/g, "") // font/height/colour formatting runs
    .replace(/[{}]/g, "")               // grouping braces
    .replace(/\\(.)/g, "$1")            // unescape any remaining \x -> x
    .replace(/\s+/g, " ")
    .trim();

// ── DXF group-code parse -> normalized entities ──────────────────────
export const parseDxfEntities = (text: string): DxfEntity[] => {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // Pair each code line with its value line. DXF guarantees one value line per
  // code, so we can walk in steps of two. Tolerate a trailing odd line.
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) { i -= 1; continue; } // resync on a stray line
    pairs.push([code, lines[i + 1]]);
  }

  // Segment into raw entities at each code 0.
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (const [code, value] of pairs) {
    if (code === 0) {
      cur = { type: String(value).trim(), codes: [] };
      raws.push(cur);
    } else if (cur) {
      cur.codes.push([code, value]);
    }
  }

  // Build entities; attach ATTRIB children to the preceding INSERT.
  const out: DxfEntity[] = [];
  for (let i = 0; i < raws.length; i += 1) {
    const r = raws[i];
    if (r.type === "TEXT") {
      out.push({ type: "TEXT", text: String(first(r.codes, 1) ?? "").trim(), x: num(first(r.codes, 10)), y: num(first(r.codes, 20)) });
    } else if (r.type === "MTEXT") {
      const parts = r.codes.filter(([c]) => c === 3 || c === 1).map(([, v]) => v).join("");
      out.push({ type: "MTEXT", text: cleanMText(parts), x: num(first(r.codes, 10)), y: num(first(r.codes, 20)) });
    } else if (r.type === "INSERT") {
      const attribs: DxfAttrib[] = [];
      let j = i + 1;
      while (j < raws.length && raws[j].type === "ATTRIB") {
        const a = raws[j];
        attribs.push({ tag: String(first(a.codes, 2) ?? "").trim(), value: String(first(a.codes, 1) ?? "").trim(), x: num(first(a.codes, 10)), y: num(first(a.codes, 20)) });
        j += 1;
      }
      out.push({ type: "INSERT", block: String(first(r.codes, 2) ?? "").trim(), x: num(first(r.codes, 10)), y: num(first(r.codes, 20)), attribs });
      i = j - 1; // skip the consumed ATTRIBs (and stop before SEQEND)
    }
  }
  return out;
};

// ── tag classification ───────────────────────────────────────────────
const normTag = (t: string): string => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isDrawingNo = (t: string) => /^(DWG|DRG|DRAWING)(NO|NUM|NUMBER)?$/.test(t) || /^DWGNO$|^DRAWINGNUMBER$/.test(t);
const isRevision = (t: string) => /^REV(ISION|NO|LEVEL)?$/.test(t);
const isTitle = (t: string) => /^(TITLE|DESCRIPTION|DESC|PARTNAME|DRAWINGTITLE)$/.test(t) || /^TITLE\d$/.test(t);
const isMaterial = (t: string) => /^(MATERIAL|MATL|MAT|MATLSPEC|MATSPEC)$/.test(t);
const isScale = (t: string) => t === "SCALE";
const isSheet = (t: string) => /^(SHEET|SHT)(NO|NUM)?$/.test(t);
const isAssetTag = (t: string) => /^(PART(NO|NUMBER)?|ASSY(NO|NUMBER)?|ASSEMBLY(NO|NUMBER)?|MODEL(NO)?)$/.test(t);
// Parts-list per-row tags.
const isItemTag = (t: string) => /^(ITEM(NO)?|SL(NO)?|BALLOON|FIND(NO)?|POS(NO)?|NO)$/.test(t);
const isPartTag = (t: string) => /^(PART(NO|NUMBER)?|PN|PARTNUM|DWGNO)$/.test(t);
const isDescTag = (t: string) => /^(DESC(RIPTION)?|NAME|PARTNAME|NOMEN(CLATURE)?|TITLE)$/.test(t);
const isQtyTag = (t: string) => /^(QTY(NO|OFF)?|NOOFF|NOOF|QNTY|QUANTITY)$/.test(t);
const isSpareTag = (t: string) => /^(SPARE|WEAR|RECSPARE|RECOMMENDEDSPARE)$/.test(t);

const truthy = (v: string) => /^(1|y|yes|true|x|spare|s)$/i.test(String(v || "").trim());

// ── preview shape (matches the from-drawing dry-run response) ────────
export type DrawingLine = {
  balloon_no: string | null; part_no: string | null; part_name: string | null;
  qty: number | null; material: string | null; is_spare: boolean | null;
};
export type DrawingAsset = { asset_code: string; name: string | null; revision: string; drawing_no: string | null; source_format: string };
export type Warning = { code: string; message: string; [k: string]: unknown };
export type DrawingExtract = {
  ok: boolean;
  asset: DrawingAsset;
  lines: DrawingLine[];
  warnings: Warning[];
  meta: { classification: string; stated_line_count: number | null; extracted_line_count: number; importable_line_count: number; dropped_no_part_no: number; method: string };
  confidence: number;
};

const trimN = (v: string | undefined | null): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

// Pull the title block from ATTRIBs across all INSERTs. When several match a
// field, prefer the one furthest bottom-right (largest x, then smallest y) —
// the conventional title-block corner.
const extractTitleBlock = (attribs: DxfAttrib[]) => {
  const tb: Record<string, { value: string; x: number; y: number }> = {};
  const consider = (key: string, a: DxfAttrib) => {
    if (!a.value) return;
    const prev = tb[key];
    if (!prev || a.x > prev.x || (a.x === prev.x && a.y < prev.y)) tb[key] = { value: a.value, x: a.x, y: a.y };
  };
  for (const a of attribs) {
    const t = normTag(a.tag);
    if (isDrawingNo(t)) consider("drawing_no", a);
    else if (isRevision(t)) consider("revision", a);
    else if (isTitle(t)) consider("title", a);
    else if (isMaterial(t)) consider("material", a);
    else if (isScale(t)) consider("scale", a);
    else if (isSheet(t)) consider("sheet", a);
    else if (isAssetTag(t)) consider("asset_code", a);
  }
  const val = (k: string) => (tb[k] ? tb[k].value : null);
  return { drawing_no: val("drawing_no"), revision: val("revision"), title: val("title"), material: val("material"), scale: val("scale"), sheet: val("sheet"), asset_code: val("asset_code") };
};

// Classify one INSERT as a parts-list BOM row: it carries a part number AND (a
// quantity OR an item/balloon number). Returns the row, or null if it isn't a
// BOM row (e.g. the title block). This is the reliable, high-confidence path.
// The caller excludes BOM-row INSERTs from title-block extraction so a child
// PART_NO never leaks into the assembly's own asset_code.
const bomRowFromInsert = (e: DxfEntity): DrawingLine | null => {
  if (e.type !== "INSERT" || !e.attribs.length) return null;
  let balloon: string | null = null, part: string | null = null, desc: string | null = null;
  let qty: string | null = null, material: string | null = null, spare: boolean | null = null;
  for (const a of e.attribs) {
    const t = normTag(a.tag);
    if (part == null && isPartTag(t)) part = a.value || null;
    else if (balloon == null && isItemTag(t)) balloon = a.value || null;
    else if (desc == null && isDescTag(t)) desc = a.value || null;
    else if (qty == null && isQtyTag(t)) qty = a.value || null;
    else if (material == null && isMaterial(t)) material = a.value || null;
    else if (spare == null && isSpareTag(t)) spare = truthy(a.value);
  }
  if (!part || (qty == null && balloon == null)) return null;
  const q = qty != null ? Number(String(qty).replace(/[^0-9.\-]/g, "")) : null;
  return {
    balloon_no: trimN(balloon), part_no: trimN(part), part_name: trimN(desc),
    qty: q != null && Number.isFinite(q) ? q : null, material: trimN(material), is_spare: spare,
  };
};

// Conservative TEXT-grid fallback: only produces rows when a header row with
// recognisable column labels is found, so a random scatter of dimension text
// never becomes a fake parts list. Lower confidence; always warned.
const rowsFromTextGrid = (entities: DxfEntity[]): DrawingLine[] => {
  const texts = entities.filter((e): e is Extract<DxfEntity, { type: "TEXT" | "MTEXT" }> => e.type === "TEXT" || e.type === "MTEXT").filter((t) => t.text);
  if (texts.length < 6) return [];
  // Cluster into rows by Y (tolerance from the median text spread).
  const ys = texts.map((t) => t.y).sort((a, b) => a - b);
  const span = (ys[ys.length - 1] - ys[0]) || 1;
  const tol = Math.max(span / 200, 0.5);
  const sorted = [...texts].sort((a, b) => b.y - a.y || a.x - b.x);
  type Cell = { text: string; x: number };
  const rows: Array<{ y: number; cells: Cell[] }> = [];
  for (const t of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - t.y) <= tol) last.cells.push({ text: t.text, x: t.x });
    else rows.push({ y: t.y, cells: [{ text: t.text, x: t.x }] });
  }
  // Find a header row: cells that label item / part / qty / desc columns.
  let headerIdx = -1;
  let cols: { key: keyof DrawingLine | "skip"; x: number }[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const cells = rows[i].cells.slice().sort((a, b) => a.x - b.x);
    const mapped = cells.map((c) => {
      const t = normTag(c.text);
      const key: keyof DrawingLine | "skip" = isPartTag(t) ? "part_no" : isItemTag(t) ? "balloon_no" : isQtyTag(t) ? "qty" : isDescTag(t) ? "part_name" : isMaterial(t) ? "material" : "skip";
      return { key, x: c.x };
    });
    const recognized = mapped.filter((m) => m.key !== "skip");
    if (recognized.some((m) => m.key === "part_no") && recognized.length >= 2) { headerIdx = i; cols = mapped; break; }
  }
  if (headerIdx < 0) return [];
  const colFor = (x: number): keyof DrawingLine | "skip" => {
    let best: { key: keyof DrawingLine | "skip"; d: number } = { key: "skip", d: Infinity };
    for (const c of cols) { const d = Math.abs(c.x - x); if (d < best.d) best = { key: c.key, d }; }
    return best.key;
  };
  const out: DrawingLine[] = [];
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const cells = rows[i].cells.slice().sort((a, b) => a.x - b.x);
    const rec: DrawingLine = { balloon_no: null, part_no: null, part_name: null, qty: null, material: null, is_spare: null };
    for (const c of cells) {
      const key = colFor(c.x);
      if (key === "skip") continue;
      if (key === "qty") { const q = Number(String(c.text).replace(/[^0-9.\-]/g, "")); rec.qty = Number.isFinite(q) ? q : null; }
      else if (key === "part_name") rec.part_name = rec.part_name ? rec.part_name + " " + c.text : c.text;
      else (rec as any)[key] = c.text;
    }
    if (rec.part_no) out.push(rec);
  }
  return out;
};

// extractAssemblyFromDxf(dxfText) -> the same preview shape the server's
// from-drawing dry-run returns, so the screen renders both paths identically.
export const extractAssemblyFromDxf = (text: string, overrides: { asset_code?: string; revision?: string } = {}): DrawingExtract => {
  const entities = parseDxfEntities(text);

  // Split INSERTs into BOM rows vs everything else; the title block is read
  // ONLY from the non-row attribs so a child part number never becomes the
  // assembly's asset_code.
  let lines: DrawingLine[] = [];
  const titleAttribs: DxfAttrib[] = [];
  for (const e of entities) {
    if (e.type !== "INSERT") continue;
    const row = bomRowFromInsert(e);
    if (row) lines.push(row);
    else titleAttribs.push(...e.attribs);
  }
  const tb = extractTitleBlock(titleAttribs);

  let method = "attribute_blocks";
  let confidence = 0.9;
  if (!lines.length) {
    lines = rowsFromTextGrid(entities);
    method = "text_grid";
    confidence = lines.length ? 0.55 : 0.2;
  }

  const assetCode = trimN(overrides.asset_code) || trimN(tb.asset_code) || trimN(tb.drawing_no) || "";
  const revision = overrides.revision != null ? String(overrides.revision) : (tb.revision != null ? String(tb.revision) : "");
  const importable = lines.filter((l) => l.part_no).length;
  const dropped = lines.length - importable;

  const warnings: Warning[] = [];
  if (!entities.length) warnings.push({ code: "unreadable_dxf", message: "no DXF entities were parsed; the file may be empty or not a DXF" });
  if (!assetCode) warnings.push({ code: "missing_asset_code", message: "no drawing/part number in the title block; enter the assembly no. to root the BOM" });
  if (!lines.length) warnings.push({ code: "no_parts_list", message: "no parts list could be read deterministically; try the PDF/image (LLM) path instead" });
  if (method === "text_grid" && lines.length) warnings.push({ code: "parts_list_heuristic", message: "parts list was inferred from free text — verify every row before committing" });
  if (dropped > 0) warnings.push({ code: "lines_without_part_no", message: dropped + " row(s) had no part number", count: dropped });

  return {
    ok: lines.length > 0,
    asset: { asset_code: assetCode, name: trimN(tb.title), revision, drawing_no: trimN(tb.drawing_no), source_format: "assembly_dxf" },
    lines,
    warnings,
    meta: { classification: "assembly_bom", stated_line_count: null, extracted_line_count: lines.length, importable_line_count: importable, dropped_no_part_no: dropped, method },
    confidence,
  };
};
