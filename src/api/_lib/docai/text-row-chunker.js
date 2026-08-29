// Density-aware row-window chunking for line-dense, page-few documents.
//
// WHY. The PDF chunker (pdf-chunker.js) splits by PAGE, so a document that is
// dense WITHIN few pages -- a 78-line annual rate contract on 4 pages, the FIAT
// ARC -- is never split and chokes a single extractor call (the cheap tier
// punts the table; even the generation tier's larger budget runs out past
// ~120 lines). Raising the page threshold cannot help: the lines are not on
// more pages, they are packed onto the same ones.
//
// WHAT. Split the TEXT LAYER by row windows instead of the PDF by pages. Find
// the table's header block and its line-item rows, group the rows into logical
// items (an item may span several physical rows -- HMIL-style 4-row blocks),
// and emit windows of <= maxItemsPerWindow items. EACH window carries the
// document preamble (customer / quote context) AND the column header, so the
// text-mode extractor sees full context for every window and never faces the
// headerless-mid-table shred that made page-chunking unsafe. The caller runs
// each window's bodyText through the extractor and concatenates the lines.
//
// PURE. No I/O, no model calls, entity-agnostic (no brand tokens, no fixed
// column positions). Heuristic, and deliberately lenient: a stray non-item line
// inside a window is harmless (the model ignores it); the one property that
// must hold is that a window boundary NEVER falls inside a logical item block,
// which is guaranteed by cutting only on detected item-row starts.

// A header row names two or more table columns. Kept broad + entity-agnostic;
// two hits is enough to distinguish a header from a prose line.
const HEADER_TOKENS = "qty|quantity|description|item|part|parts\\s*no|hsn|sac|rate|amount|unit\\s*price|uom|drawing|remark|price|sr\\s*no|s\\.?\\s*no";
const headerHits = (line) => (String(line).match(new RegExp(HEADER_TOKENS, "gi")) || []).length;
const looksLikeHeaderRow = (line) => headerHits(line) >= 2;

// A logical item row starts with a leading number (the S.No / Item column):
// "1  ADAPTER ...", "12) ...", " 207   Holder ...". The leading integer is the
// block boundary; everything from one item number to the next is ONE item.
const ITEM_LEAD = /^\s*(\d{1,4})[.)]?\s+\S/;
export const leadingItemNumber = (line) => {
  const m = ITEM_LEAD.exec(line == null ? "" : String(line));
  return m ? Number(m[1]) : null;
};

const isBlank = (l) => !l || !l.trim();

// Tunables (env-overridable so an operator can shift them without a deploy).
const DEFAULT_MAX_ITEMS_PER_WINDOW = Math.max(
  5, Number(process.env.DOCAI_ROW_CHUNK_ITEMS_PER_WINDOW) || 25,
);
// Below this item count a single call is fine; row-chunking only earns its
// extra calls on a genuinely dense table. Matches the observed ~45-line
// practical single-call ceiling with margin.
const DEFAULT_MIN_ITEMS_TO_CHUNK = Math.max(
  10, Number(process.env.DOCAI_ROW_CHUNK_MIN_ITEMS) || 46,
);

// Locate the item-row line indices: lines matching ITEM_LEAD whose leading
// numbers form a predominantly increasing sequence (a real item column climbs;
// this rejects stray numeric lines in a preamble or terms block). Returns the
// indices in document order.
const findItemRowIndices = (lines) => {
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const n = leadingItemNumber(lines[i]);
    if (n != null) candidates.push({ i, n });
  }
  if (candidates.length < 2) return candidates.map((c) => c.i);
  // Keep the longest run that is non-decreasing (allowing gaps, e.g. FIAT jumps
  // 78 -> 202): walk candidates, dropping any whose number dips below the
  // running max (those are not part of the item column).
  const kept = [];
  let runMax = -Infinity;
  for (const c of candidates) {
    if (c.n >= runMax) { kept.push(c.i); runMax = c.n; }
  }
  return kept;
};

// Public: is this text dense enough that row-window chunking is worth it?
export const shouldRowChunk = (text, opts = {}) => {
  const minItems = Number(opts.minItems) || DEFAULT_MIN_ITEMS_TO_CHUNK;
  if (!text || typeof text !== "string") return false;
  const lines = text.split(/\r?\n/);
  return findItemRowIndices(lines).length >= minItems;
};

// Public: plan the row windows.
//
// Returns:
//   {
//     tableFound: boolean,        // an item column was located
//     itemCount: number,          // logical items detected
//     preamble: string,           // context before the table (customer, quote no)
//     header: string,             // the column-header block (may be "")
//     windows: [ { index, itemCount, text } ],  // text = header block + this window's rows
//   }
// Each window's bodyText for the extractor is: preamble + "\n" + window.text
// (use buildWindowBodyText). preamble + header are repeated into every window
// on purpose -- that is what keeps a mid-table window extractable.
export const planRowWindows = (text, opts = {}) => {
  const maxItems = Math.max(1, Number(opts.maxItemsPerWindow) || DEFAULT_MAX_ITEMS_PER_WINDOW);
  const empty = { tableFound: false, itemCount: 0, preamble: text || "", header: "", windows: [] };
  if (!text || typeof text !== "string") return empty;

  const lines = text.split(/\r?\n/);
  const itemIdx = findItemRowIndices(lines);
  if (itemIdx.length === 0) return empty;

  const firstItem = itemIdx[0];

  // Header block: the contiguous run of column-header lines above the first
  // item row. There is often a blank gap between the header and the first row
  // (pdftotext -layout), so skip blanks first, then walk up capturing only
  // lines that carry >= 1 column token -- a stacked header ("... DISCOUNTED
  // PRICE / GST CGST SGST IGST") has tokens on each visual line, while the
  // preamble above it does not, which is where the block stops.
  let i = firstItem - 1;
  while (i >= 0 && isBlank(lines[i])) i--;
  const headerEnd = i + 1; // exclusive; end of the header block (before the gap)
  let headerStart = headerEnd;
  let sawHeaderToken = false;
  for (; i >= 0; i--) {
    const l = lines[i];
    if (isBlank(l) || leadingItemNumber(l) != null) break;
    if (headerHits(l) < 1) break; // a non-header line: the preamble starts here
    headerStart = i;
    sawHeaderToken = true;
  }
  const headerLines = sawHeaderToken ? lines.slice(headerStart, headerEnd) : [];
  const preambleEnd = sawHeaderToken ? headerStart : firstItem;
  const preamble = lines.slice(0, preambleEnd).join("\n").trim();
  const header = headerLines.join("\n").trim();

  // Group rows into logical item blocks: block k spans [itemIdx[k], itemIdx[k+1])
  // ; the last runs to end of document, minus a trailing non-item tail (terms /
  // totals) which we drop from the LAST block's span so terms don't bloat it.
  const lastItem = itemIdx[itemIdx.length - 1];
  // trailing tail = lines after the last item row up to the first blank-run that
  // precedes prose; keep the last block tight to its own physical rows by
  // ending it at the next blank line after lastItem.
  let lastBlockEnd = lines.length;
  for (let i = lastItem + 1; i < lines.length; i++) {
    if (isBlank(lines[i]) && (i + 1 >= lines.length || isBlank(lines[i + 1]))) { lastBlockEnd = i; break; }
  }

  const blocks = [];
  for (let k = 0; k < itemIdx.length; k++) {
    const start = itemIdx[k];
    const end = k + 1 < itemIdx.length ? itemIdx[k + 1] : lastBlockEnd;
    blocks.push(lines.slice(start, end).join("\n").replace(/\s+$/g, ""));
  }

  const windows = [];
  for (let w = 0; w < blocks.length; w += maxItems) {
    const slice = blocks.slice(w, w + maxItems);
    const body = (header ? header + "\n" : "") + slice.join("\n");
    windows.push({ index: windows.length, itemCount: slice.length, text: body });
  }

  return { tableFound: true, itemCount: blocks.length, preamble, header, windows };
};

// Public: assemble the extractor bodyText for one window (preamble + header +
// rows). Kept separate so the planner stays about structure, not formatting.
export const buildWindowBodyText = (plan, window) => {
  const parts = [];
  if (plan?.preamble) parts.push(plan.preamble);
  if (window?.text) parts.push(window.text);
  return parts.join("\n\n");
};

export const __test = { findItemRowIndices, looksLikeHeaderRow, headerHits };
export const __consts__ = { DEFAULT_MAX_ITEMS_PER_WINDOW, DEFAULT_MIN_ITEMS_TO_CHUNK };
