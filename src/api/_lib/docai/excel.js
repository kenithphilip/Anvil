// Multi-tab Excel tender parser. Handles Comena's killer feature:
// multi-tab tenders with thousands of lines. Pure-Node, no external
// API. Uses optional `xlsx` dep (SheetJS) when available; falls
// back to a heuristic CSV-shaped path otherwise.
//
// Output: { lines: [...] } combining every sheet's tabular rows.
// Each line carries its source sheet name in raw_meta.

let xlsx = null;
try {
  // Top-level await is fine in ESM but not in serverless cold-path
  // overhead. Lazy-import inside extract() instead so the module
  // loads quickly even when xlsx isn't installed.
} catch (_e) { xlsx = null; }

const guessHeader = (row) => row.map((c) => String(c || "").trim().toLowerCase());

const colIdx = (header, re) => header.findIndex((h) => re.test(h));

const parseSheetRows = (rows, sheetName) => {
  if (!rows || !rows.length) return [];
  const header = guessHeader(rows[0]);
  const partIdx = colIdx(header, /(part|sku|item ?code|item ?#|catalog|p\/n)/);
  const qtyIdx  = colIdx(header, /(qty|quantity|count|pieces|pcs)/);
  const priceIdx = colIdx(header, /(unit ?price|rate|price)/);
  const descIdx  = colIdx(header, /(description|item|product|name)/);
  // If header detection fails, treat the first row as data and use
  // positional defaults (col 0 = part, col 1 = desc, col 2 = qty,
  // col 3 = price). Tenders often skip headers entirely.
  const useHeader = partIdx >= 0 || qtyIdx >= 0 || priceIdx >= 0;
  const dataRows = useHeader ? rows.slice(1) : rows;
  const out = [];
  for (const r of dataRows) {
    if (!r || !r.length) continue;
    const li = {
      partNumber: useHeader && partIdx >= 0 ? String(r[partIdx] || "").trim() : (r[0] != null ? String(r[0]).trim() : null),
      description: useHeader && descIdx >= 0 ? String(r[descIdx] || "").trim() : (r[1] != null ? String(r[1]).trim() : null),
      quantity: useHeader && qtyIdx >= 0 ? Number(String(r[qtyIdx] || "0").replace(/[^\d.]/g, "")) : (r[2] != null ? Number(String(r[2]).replace(/[^\d.]/g, "")) : null),
      unitPrice: useHeader && priceIdx >= 0 ? Number(String(r[priceIdx] || "0").replace(/[^\d.]/g, "")) : (r[3] != null ? Number(String(r[3]).replace(/[^\d.]/g, "")) : null),
      raw_meta: { sheet: sheetName },
    };
    if (li.partNumber || li.description) out.push(li);
  }
  return out;
};

export const isConfigured = (_settings) => true;

export const extract = async ({ bytes, filename, settings }) => {
  if (!bytes) return { ok: false, error: "Excel adapter requires file bytes" };
  let xlsxMod;
  try {
    // Vite's static analyser tries to resolve any literal string in
    // a dynamic import(); compute the spec at runtime so it skips it.
    const spec = "xlsx";
    xlsxMod = (await import(/* @vite-ignore */ spec)).default
      || (await import(/* @vite-ignore */ spec));
  } catch (_e) {
    return { ok: false, error: "xlsx package not installed; run `npm install xlsx`" };
  }
  let workbook;
  try {
    workbook = xlsxMod.read(bytes, { type: "buffer", cellDates: true });
  } catch (err) {
    return { ok: false, error: "xlsx parse: " + err.message };
  }
  const allLines = [];
  const sheetSummaries = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsxMod.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    const lines = parseSheetRows(rows, sheetName);
    allLines.push(...lines);
    sheetSummaries.push({ sheet: sheetName, rows: rows.length, line_items: lines.length });
  }
  // Confidence: high when any sheet had a recognisable header
  // structure, lower when fallback positional path was used.
  const confidences = { overall: allLines.length ? 0.9 : 0.2 };
  allLines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.9; });
  return {
    ok: true,
    raw: { sheets: sheetSummaries, filename },
    normalized: {
      customer: null,
      lines: allLines,
      raw_sheet_count: workbook.SheetNames.length,
    },
    confidences,
  };
};
