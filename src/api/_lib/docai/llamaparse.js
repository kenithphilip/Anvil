// LlamaParse (LlamaCloud) extraction adapter — plug-and-play alongside
// gemini / claude / the other engines in the DocAI provider chain.
//
// LlamaParse is a DOCUMENT-PARSING engine (PDF/scan -> structured markdown +
// tables), NOT a chat LLM. Its home is the docai extraction chain, where it is
// switchable in place of the Claude-vision extractor / Mistral OCR — NOT the
// reasoning-LLM abstraction (llm.js), which it cannot serve.
//
// Keyed like the other DocAI adapters: a PER-TENANT encrypted key first
// (docai_llamacloud_api_key_enc, set in Admin > AI & diagnostics > DocAI
// providers, issue #210), then the server env var. It's just another selectable
// engine — add "llamaparse" to docai_provider_order and set the key. OFF by
// default (not in the default order; no key => isConfigured() false =>
// dispatcher skips it).
//
// KEY: tenant docai_llamacloud_api_key_enc (shared docai_creds_iv envelope),
// else LLAMAPARSE_API_KEY (the var the deployment sets), else LLAMA_CLOUD_API_KEY
// for older configs. Tier via LLAMAPARSE_TIER (fast|cost_effective|agentic|
// agentic_plus); default "agentic" (best accuracy).
//
// DATA RESIDENCY: LlamaCloud is US/EU only. Enabling it sends document content
// to a US/EU SaaS — a deliberate opt-in (the Admin panel shows a DPDPA warning).

import { safeFetch } from "../safe-fetch.js";
import { decryptField } from "../secrets.js";
import { parsePoDate } from "../parse-date.js";
import { readPoHeader } from "./po-header-text.js";

// Per-tenant key (encrypted, shared docai_creds_iv) first, then env vars.
const apiKey = (settings) => {
  if (settings?.docai_llamacloud_api_key_enc && settings?.docai_creds_iv) {
    try { const k = decryptField(settings.docai_llamacloud_api_key_enc, settings.docai_creds_iv); if (k) return k; }
    catch (_e) { /* fall through to env */ }
  }
  return process.env.LLAMAPARSE_API_KEY || process.env.LLAMA_CLOUD_API_KEY || null;
};
const tier = () => process.env.LLAMAPARSE_TIER || "agentic";

// LlamaParse v2 requires BOTH tier and version — sending `tier` alone is
// rejected with:
//   400 Invalid configuration: 1 validation error for
//   LlamaParseMultipartConfiguration / version / Field required
// which is exactly how this adapter was failing in production.
//
// "latest" tracks whatever LlamaParse currently ships, so the OUTPUT FORMAT can
// change with no deploy on our side — and it did: the adapter returned zero
// lines for weeks on documents it had parsed perfectly, because it only spoke
// pipe tables. A silent behaviour change in a dependency is the worst kind, so
// pin by default and bump deliberately.
//
// VERSIONS ARE PER TIER — a version string belongs to exactly one tier, and
// pairing an agentic version with cost_effective is a validation error. Since
// LLAMAPARSE_TIER is env-overridable, the pin has to follow the tier rather than
// being one global constant. Values from the v2 API reference (the current
// `latest` for each tier); the live list is GET /api/v2/parse/versions.
const PINNED_VERSION_BY_TIER = {
  fast: "2026-06-15",
  cost_effective: "2026-06-26",
  agentic: "2026-07-15",
  agentic_plus: "2026-07-08",
};

// LLAMAPARSE_VERSION overrides (including back to "latest" if a pin ever needs
// to be abandoned in a hurry). An unrecognised tier falls back to "latest"
// rather than sending a version that belongs to a different tier.
const parseVersion = () =>
  process.env.LLAMAPARSE_VERSION || PINNED_VERSION_BY_TIER[tier()] || "latest";

// Config is the presence of a tenant OR env key (mirrors gemini/unstructured).
export const isConfigured = (settings) => !!apiKey(settings);

// ── canonical mapping: markdown table -> line items ─────────────────
export const parseMarkdownTable = (md) => {
  const rows = [];
  for (const l of String(md || "").split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith("|")) { if (rows.length) break; else continue; }
    if (/^\|[\s:|-]+\|?$/.test(t)) continue; // separator row
    rows.push(t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  return rows;
};

// ── HTML tables ────────────────────────────────────────────────────────────
//
// The agentic tier emits rich tables as <table> MARKUP inside the markdown, not
// as pipe tables. A real 13-page PO came back as 51,613 characters containing
// the complete line-item table — Line / Item Number / Item Description /
// Quantity / UOM / Unit Price / Taxes / Line Total, every row present — and
// parseMarkdownTable found ZERO pipe rows in it, so the adapter reported "no
// parsable line-item table" on a document it had parsed perfectly.
//
// Nothing in Anvil changed. The adapter sends version: "latest" (see
// parseVersion below), so LlamaParse changed what its output looks like
// underneath us. Hence: parse BOTH shapes, and treat neither-shape-parsed as
// the loud failure it is.
//
// Entities are decoded in ONE pass, numeric ones included: LlamaParse writes
// "P&F" as "P&#x26;F" inside a cell, and a two-pass decode would turn a
// literal "&amp;lt;" into "<".
const ENTITY = /&(nbsp|amp|lt|gt|quot|apos|#x[0-9a-f]{1,6}|#\d{1,7});/gi;
const NAMED = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decodeEntities = (s) => String(s).replace(ENTITY, (m, e) => {
  const k = e.toLowerCase();
  if (NAMED[k] != null) return NAMED[k];
  const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, " "))
  .replace(/\s+/g, " ").trim();

// A line break written as an ESCAPED tag: "&#x3C;br/>", "&lt;br/&gt;",
// "&#60;br>". LlamaParse emits these inside a header cell that stacks several
// labels ("Item No&#x3C;br/>Description&#x3C;br/>..."). Made a real <br/> first,
// so it splits labels (cellParts) and strips to a space like any other tag.
const ESCAPED_BR = /(?:&lt;|&#x0*3c;|&#0*60;)\s*br\s*\/?\s*(?:&gt;|&#x0*3e;|&#0*62;|>)/gi;
const unescapeBreaks = (s) => String(s).replace(ESCAPED_BR, "<br/>");

// The labels a header cell stacks, top first: its text split at each line
// break (<br>, or a newline). A cell that is one label gives one part. Parts
// keep their positions; trailing empty ones are dropped.
const cellParts = (cellHtml) => {
  // Leading structural tags (and the whitespace between them) are not a label
  // position: a bare <th> matched from "<thead>\n<tr>\n<th>" starts with them.
  const inner = String(cellHtml)
    .replace(/^(?:\s*<\/?(?:thead|tbody|tr|th|td)\b[^>]*>)+/i, "")
    .replace(/<\/t[hd]>\s*$/i, "")
    .trim();
  const parts = inner.split(/\s*<br\s*\/?>\s*|\s*\n\s*/i).map(stripTags);
  while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
  return parts;
};

// Rows for every <table> in the document. Header recovery matters: emitters
// differ on whether header cells sit inside a <tr>. Observed in production:
// <thead> holds bare <th> while <tbody> rows are wrapped. A naive <tr> scan
// therefore captures data rows but NO header, the first data row becomes row 0,
// the column-label test fails, and the whole table is discarded.
//
// Each table also says how many of its leading rows are HEADER rows: rows
// inside <thead>, or rows made only of <th> cells. A stacked layout prints its
// column labels on several header rows (see headerBlockOf), and once the rows
// are plain arrays of text there is no other way to tell a label row from data.
//
// `parts[i]` is, for a row of <th> cells, each cell's stacked labels
// (cellParts); null for a data row. A data cell's line breaks are wrapped
// text, never separate labels.
const parseHtmlTablesDetailed = (html) => {
  const tables = [];
  for (const raw of String(html || "").match(/<table[\s\S]*?<\/table>/gi) || []) {
    const tbl = unescapeBreaks(raw);
    const rows = [];
    const parts = [];
    let sawHeaderRow = false;
    let headRows = 0;
    let inHead = true;
    const theadEnd = tbl.search(/<\/thead>/i);
    for (const m of tbl.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const tr = m[0];
      const cellHtml = tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || [];
      const cells = cellHtml.map(stripTags);
      if (!cells.length) continue;
      rows.push(cells);
      const isTh = /<th[\s>]/i.test(tr);
      parts.push(isTh ? cellHtml.map(cellParts) : null);
      if (isTh) sawHeaderRow = true;
      const inThead = theadEnd >= 0 && m.index < theadEnd;
      if (inHead && (inThead || (isTh && !/<td[\s>]/i.test(tr)))) headRows++;
      else inHead = false;
    }
    // Synthesise a header from bare <th> ONLY when no <tr> carried one.
    //
    // The earlier rule compared the concatenated <th> list against row 0, which
    // breaks on the real documents: their <thead> holds a `<th colspan="14">Line
    // Details</th>` banner ABOVE the labels, so row 0 is that banner, the
    // comparison fails, and a 15-wide synthetic header gets prepended in front
    // of 14-wide data. Every column then reads one to the left — the parser
    // returns confidently-shaped garbage instead of nothing, which is worse.
    const thHtml = tbl.match(/<th[\s\S]*?<\/th>/gi) || [];
    const ths = thHtml.map(stripTags);
    if (ths.length && !sawHeaderRow) { rows.unshift(ths); parts.unshift(thHtml.map(cellParts)); headRows = 1; }
    // No <tr> anywhere: chunk the <td> stream by header width. Exact for a
    // rectangular table, which a rendered PO table is.
    if (rows.length <= 1 && ths.length) {
      const tds = (tbl.match(/<td[\s\S]*?<\/td>/gi) || []).map(stripTags);
      for (let i = 0; i + ths.length <= tds.length; i += ths.length) { rows.push(tds.slice(i, i + ths.length)); parts.push(null); }
    }
    if (rows.length) tables.push({ rows, parts, headRows: Math.min(headRows, rows.length) });
  }
  return tables;
};

export const parseHtmlTables = (html) => parseHtmlTablesDetailed(html).map((t) => t.rows);

// Column labels that mark a table as the line-item table rather than the
// vendor/address block or the tax summary that bracket it.
const HEADER_HINTS = [
  /\bpart\s*(no|number|code)?\b/i, /\bitem\s*(no|code|number)?\b/i, /\bdescription\b/i,
  /\bq(ua)?nt(it)?y\b|\bqty\b/i, /\bunit\s*price\b|\brate\b/i, /\bamount\b|\bvalue\b|\btotal\b/i,
  /\bhsn\b|\bsac\b/i, /\buom\b|\bu\/m\b/i, /\bs\.?\s*no\b|\bsl\.?\s*no\b|\bline\b/i,
];
// 3 hits, so a two-column address table that happens to contain "item" loses.
const MIN_HEADER_HITS = 3;
const headerScore = (row) => {
  const joined = (row || []).join(" ");
  return HEADER_HINTS.reduce((n, re) => n + (re.test(joined) ? 1 : 0), 0);
};
const shapeKey = (row) => (row || []).map((c) => c.toLowerCase().replace(/[^a-z]/g, "")).join("|");
const looksLikeDataRow = (row) => (row || []).some((c) => /^\d+(?:[.,]\d+)?$/.test(String(c).replace(/[,\s]/g, "")));

// The header is the best-scoring row near the top, NOT row 0.
//
// Real pages open with a spanning banner — "Line Details", or the buyer's name
// and GST repeated as a page header — which collapses to a single cell. Taking
// row 0 blindly either mis-selects that banner or, worse, aligns the data to a
// header that is one column too wide.
//
// The >=4 width test is what rejects a banner: a colspan cell is ONE cell no
// matter how many columns it spans, and its prose can still contain "ORDER" or
// "TOTAL" and score hits.
const HEADER_SEARCH_ROWS = 5;
const MIN_HEADER_WIDTH = 4;
export const pickHeaderRow = (rows) => {
  let best = -1, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    const row = rows[i] || [];
    if (row.length < MIN_HEADER_WIDTH) continue;
    const s = headerScore(row);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return bestScore >= MIN_HEADER_HITS ? best : -1;
};

// Continuation pages wrap each row in spacer cells — a leading empty <td>, a
// trailing one — so the row is wider than the header by exactly the padding
// (16 cells against a 14-column header, in the document that motivated this).
//
// Trim empties from the ends until the widths match. Never trim a NON-empty
// cell: that would silently drop a real value and shift everything after it.
// A row that cannot be aligned returns null and is counted, not guessed at.
export const alignRow = (row, width) => {
  if (!Array.isArray(row)) return null;
  if (row.length === width) return row;
  if (row.length < width) return null;          // cannot invent missing cells
  let a = 0, b = row.length;
  while (b - a > width && String(row[a] ?? "").trim() === "") a++;
  while (b - a > width && String(row[b - 1] ?? "").trim() === "") b--;
  return b - a === width ? row.slice(a, b) : null;
};

// First regex that matches any column wins — lets us express preference order.
const firstIdx = (header, res) => {
  for (const re of res) { const i = header.findIndex((c) => re.test(c)); if (i >= 0) return i; }
  return -1;
};
const cellNum = (s) => {
  const n = Number(String(s ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const EMPTY_CELL = /^[-–—]$/;   // this layout writes an absent value as "-"

// ── stacked records: one item printed across several rows ──────────────────
//
// Many OEM purchase orders print each item as a BLOCK of physical rows under a
// header that is itself several rows deep:
//
//   S.No | Item No       | Qty | Ex-Price     | SGST  | Unit Price | ...
//        | Description   | U/M | Tooling Cost | CGST  | TotAmt     | ...
//        | Specification | CUR | P&F          | IGST  |            | Delivery
//        | Req.No        |     | Others       | UTGST | Inspection | ...
//
// Each label row describes the matching row of every item block. Reading only
// the first header row, as the one-row path does, turned a 25-item PO into 103
// "lines": the three lower header rows, then four lines per item, three of them
// carrying a description, a drawing code or a requisition number where the
// item code belongs. Nothing grouped the rows, because the only continuation
// logic here handles a TABLE with no labels (a continuation page), and a
// document whose pages LlamaParse merged into one table never has one.
//
// So: when the header is K rows deep, an item is a RECORD of up to K body rows,
// read through a per-(row offset, column) label map. A record starts at a row
// that prints its own line number, or its own quantity where the layout has no
// other field. The header rows themselves are never data.

const MAX_RECORD_ROWS = 6;

// Labels a stacked layout prints on its second and later header rows. Used
// only to recognise such a row when the emitter put it in <tbody> rather than
// <thead>; a <thead> row needs no recognising.
const SUB_HEADER_LABELS = [
  /\bdesc(ription)?\b/i, /\bspec(ification)?\b|\bdrawing\b|\bdrg\b/i,
  /\breq(uisition)?\b|\bp\.?\s*r\.?\s*no\b|\bindent\b/i, /\bu\s*\/\s*m\b|\buom\b|\bunits?\b/i,
  /^cur(rency)?\.?$/i, /\bdeliver/i, /\btot\.?\s*amt\b|\btotal\b|\bamount\b/i,
  /\b(c|s|i|ut)gst\b|\bgst\b|\bvat\b|\bcess\b|\bexcise\b|\btax/i,
  /\btooling\b|\bp\s*&\s*f\b|\bothers?\b|\bfreight\b/i,
  /\binspection\b|\bmaker\b|\bremarks?\b|\bitem\b|\bhsn\b|\bsac\b/i,
];

// A label row carries words and no figures, and most of its words are labels.
const isLabelRow = (row) => {
  const cells = (row || []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (cells.length < 2) return false;
  if (cells.some((c) => /\d/.test(c))) return false;
  const hits = cells.filter((c) => SUB_HEADER_LABELS.some((re) => re.test(c))).length;
  return hits >= 2 && hits * 2 >= cells.length;
};

// The header rows of one record: the picked header row, then every row below
// it that is a header too, either because it sat in <thead> or because it is
// recognisably a label row. Each must align to the header's width: a narrower
// row is a column-GROUP header (one label over two sub-columns), a different
// structure that this does not claim to read.
// Returns { block, physical }: the header rows of one record, and how many
// table rows they occupied (the same here; see stackedHeaderOf for the case
// where they differ).
const headerBlockOf = (t, hi, headRows) => {
  const head = t[hi];
  const block = [head];
  for (let j = hi + 1; j < t.length && block.length < MAX_RECORD_ROWS; j++) {
    const a = alignRow(t[j], head.length);
    if (!a) break;
    if (j < headRows || isLabelRow(a)) { block.push(a); continue; }
    break;
  }
  return { block, physical: block.length };
};

// Strict numbers for the stacked path: a blank cell is NO value. The one-row
// path's cellNum turns "" into 0, which is how a blank S.No became lineNo 0
// and a "NOS" in the quantity column became quantity 0.
const strictNum = (s) => {
  const t = String(s ?? "").replace(/[,\s]/g, "").replace(/^(?:inr|rs\.?|₹)/i, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const lineNumberOf = (s) => {
  const t = String(s ?? "").trim().replace(/\.$/, "");
  return /^\d{1,5}$/.test(t) && Number(t) > 0 ? Number(t) : null;
};

// Field -> label patterns, in preference order: the first pattern that matches
// any label decides which cells the field reads (see slotsFor). The one-row
// path's choices are kept where they overlap.
const STACKED_FIELDS = {
  lineNo:           [/^line$/i, /^line\s*(no|num|item)/i, /^s\.?\s*no/i, /^sl\.?\s*no/i, /^sr\.?\s*no/i],
  customerItemCode: [/item\s*(no|code|number)/i],
  partNumber:       [/part\s*(no|number|code)/i, /sku|material|catalog/i],
  description:      [/item\s*desc/i, /^description$/i, /desc/i],
  specification:    [/item\s*spec|specification/i, /^spec\.?$/i, /drawing|^drg\.?(\s*no)?/i],
  requisition_no:   [/^req(uisition)?\.?\s*(no|num|number)?\.?$/i, /requisition/i, /^p\.?\s*r\.?\s*(no|num)/i, /^indent\s*no/i],
  quantity:         [/q(ua)?nt|qty/i],
  uom:              [/uom|u\s*\/\s*m/i, /^units?$/i],
  currency:         [/^cur(rency)?\.?$/i],
  hsn:              [/hsn|sac/i],
  delivery_date:    [/deliver/i, /need\s*by/i, /due\s*date/i],
  // The price the buyer prints INCLUDING per-unit tax on this layout family,
  // and the pre-tax price beside it. Which one is the rate is PROVED per
  // record (rateFor), never assumed from the label.
  unit_price:       [/unit\s*price/i, /^price$/i],
  pre_tax_price:    [/^ex\W*price$/i, /^basic\s*(price|rate)$/i, /^rate$/i, /price\s*before\s*tax/i],
  line_total:       [/^tot\.?\s*amt\.?$/i, /line\s*total/i, /^total(\s*amount)?$/i, /^amount$/i],
  // Per-UNIT tax and auxiliary amounts, the canonical keys the LLM adapters
  // fill on this layout (line-schema.js).
  sgst_amount:      [/^sgst\b/i],
  cgst_amount:      [/^cgst\b/i],
  igst_amount:      [/^igst\b/i],
  utgst_amount:     [/^utgst\b/i],
  cess_amount:      [/^cess$/i],
  ed_cess_amount:   [/^ed\.?\s*cess$/i],
  excise_amount:    [/excise/i],
  tooling_amount:   [/tooling/i],
  p_and_f_amount:   [/^p\s*&\s*f$/i, /packing\s*(&|and)\s*forwarding/i],
  others_amount:    [/^others?'?$/i],
};
const TAX_FIELDS = ["sgst_amount", "cgst_amount", "igst_amount", "utgst_amount", "cess_amount", "ed_cess_amount", "excise_amount"];
const AUX_FIELDS = ["tooling_amount", "p_and_f_amount", "others_amount"];
const TEXT_FIELDS = ["partNumber", "customerItemCode", "description", "specification", "requisition_no", "uom", "currency", "hsn"];

// Two printed money figures agree when they match to the paisa, allowing half
// a paisa of rounding per unit (a per-unit tax printed to the paisa, times qty).
const PAISA = 0.011;
const moneyClose = (a, b, qty = 1) =>
  Math.abs(a - b) <= Math.max(PAISA, Math.abs(qty || 1) * 0.005);
const round2 = (n) => Math.round(n * 100) / 100;

// GLUED LABELS. LlamaParse sometimes drops the separator between two stacked
// labels and prints them as one: "TotAmtInspection Item" is "TotAmt" (this
// row offset) run into "Inspection Item" (a lower one). A label that matches no
// field as a whole is split where a lower-case letter, digit or "." runs
// straight into a capital, and read as the first run of pieces that matches a
// field's own pattern, prefix first. The vocabulary is STACKED_FIELDS itself,
// so nothing here knows any one document. The rest of the glued text has no
// knowable offset, so it is dropped and reported (table_diag.glued_labels).
// A label that matches as a whole is never split: "UnitPrice", "TotAmt" and
// "DeliveryInspection Item" stay as printed.
const isFieldLabel = (l) => Object.values(STACKED_FIELDS).some((res) => res.some((re) => re.test(l)));
const GLUE_POINT = /(?<=[a-z0-9.'])(?=[A-Z])/;
const unglue = (label) => {
  if (!label || isFieldLabel(label)) return null;
  const pieces = label.split(GLUE_POINT);
  if (pieces.length < 2) return null;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = pieces.length; j > i; j--) {
      const run = pieces.slice(i, j).join("").trim();
      if (run && run !== label && isFieldLabel(run)) return run;
    }
  }
  return null;
};

// Every labelled cell, as { o: row offset, c: column, label }, plus
// `glued_from` when the label was read out of a glued one.
const slotsOf = (block) => {
  const slots = [];
  block.forEach((hr, o) => hr.forEach((label, c) => {
    const l = String(label ?? "").trim();
    if (!l) return;
    const run = unglue(l);
    slots.push(run ? { o, c, label: run, glued_from: l } : { o, c, label: l });
  }));
  return slots;
};
// The cells a field reads: every slot matching its FIRST matching pattern. A
// merged header cell repeats its label across the columns it spans ("Maker |
// Maker", "Delivery | Delivery"), so a field can own several slots; the
// record's first non-empty one is its value.
const slotsFor = (slots, res) => {
  for (const re of res) {
    const hit = slots.filter((s) => re.test(s.label));
    if (hit.length) return hit;
  }
  return [];
};

// Decide the rate, and prove it. When a record prints both a pre-tax price and
// a "Unit Price", the unit price may already include the per-unit taxes. Taking
// it as the rate shows the GST-inclusive figure as the taxable value, and a
// Tally push then adds GST a second time. So switch to the pre-tax price ONLY
// when the record's own figures prove unit = pre-tax + per-unit taxes (or + the
// per-unit auxiliary costs too). Anything else keeps the old reading and says so.
const rateFor = ({ pre, unit, tax, aux }) => {
  if (pre != null && unit != null) {
    if (moneyClose(unit, pre + tax)) return { rate: pre, basis: "pre_tax", unit_includes: tax > 0 ? "tax" : "nothing" };
    if (aux > 0 && moneyClose(unit, pre + tax + aux)) return { rate: pre, basis: "pre_tax", unit_includes: "tax_and_aux" };
    return { rate: unit, basis: "unproven" };
  }
  if (pre != null) return { rate: pre, basis: "pre_tax_column" };
  if (unit != null) return { rate: unit, basis: "unit_price" };
  return { rate: null, basis: null };
};

// Check the printed line total against qty and rate: it is the gross (rate +
// per-unit tax, with or without the auxiliary costs, times qty) or the taxable
// value (rate times qty). Anything else is reported, never smoothed over.
const totalCheckOf = ({ qty, rate, tax, aux, total }) => {
  if (total == null || qty == null || rate == null) return null;
  if (moneyClose(total, qty * (rate + tax + aux), qty) || moneyClose(total, qty * (rate + tax), qty)) return "gross";
  if (tax + aux > 0 && moneyClose(total, qty * rate, qty)) return "pre_tax";
  return "mismatch";
};

// How a header block reads: each field's slots, and how body rows group into
// records. Built once per block; also used to TEST a stacked reading before
// committing to it (stackedHeaderOf).
const recordReader = (block) => {
  const K = block.length;
  const slots = slotsOf(block);
  const F = {};
  for (const [field, res] of Object.entries(STACKED_FIELDS)) F[field] = slotsFor(slots, res);
  // Starting a record is read off the FIRST header row only: that is where a
  // line number and a quantity of an item's own are printed.
  const lineNoCols = F.lineNo.filter((s) => s.o === 0).map((s) => s.c);
  const qtyCols = F.quantity.filter((s) => s.o === 0).map((s) => s.c);
  const labelled = new Set(slots.map((s) => s.o + ":" + s.c));
  const startsRecord = (r, nextOffset) => {
    if (nextOffset >= K) return true;
    if (lineNoCols.some((c) => lineNumberOf(r[c]) != null)) return true;
    // A quantity in a cell the stacked layout gives no field at this offset
    // can only be a new item's own quantity.
    if (qtyCols.some((c) => strictNum(r[c]) && !labelled.has(nextOffset + ":" + c))) return true;
    // With no line-number or quantity column there is nothing to group by.
    return !lineNoCols.length && !qtyCols.length;
  };
  const group = (rows) => {
    const records = [];
    let cur = null;
    let merged = 0;
    // A merged row that prints a figure in a quantity column: under a true
    // stacked header that cell holds the lower row's own field (a UOM, a
    // currency), never a number.
    let mergedWithQty = 0;
    for (const r of rows) {
      if (!r.some((c) => String(c ?? "").trim())) continue;     // spacer row
      if (!cur || startsRecord(r, cur.length)) { cur = [r]; records.push(cur); continue; }
      cur.push(r);
      merged++;
      if (qtyCols.some((c) => strictNum(r[c]) != null)) mergedWithQty++;
    }
    return { records, merged, mergedWithQty };
  };
  return { K, slots, F, group };
};

// ONE header row whose cells stack their labels ("Item No<br/>Description<br/>
// Specification<br/>Req.No", "Qty<br/>U/M<br/>CUR", ...) is the K-row header
// above written into a single row. LlamaParse emits either form for the same
// document from one run to the next. Label i of a cell is that column's label
// at record row offset i, K is the deepest stack, and a cell with fewer labels
// has none at the lower offsets.
//
// A header cell can also carry a line break only because its label WRAPPED
// ("Unit<br/>Price", "Line<br/>Total"). Reading that as a stack would split one
// label across two offsets. So the stacked reading is taken only when the
// header and the body prove it: a lower label row reads as labels (so at least
// two cells stack, isLabelRow needs two), at least a third of the body rows
// join a record above them, and none of those rows prints its own quantity.
// Otherwise the cell's labels are joined with a space, exactly as before.
const stackedHeaderOf = (cellPartsRow, body, width) => {
  if (!Array.isArray(cellPartsRow) || cellPartsRow.length !== width) return null;
  const K = Math.min(MAX_RECORD_ROWS, Math.max(...cellPartsRow.map((p) => p.length)));
  if (K < 2) return null;
  const block = Array.from({ length: K }, (_, o) => cellPartsRow.map((p) => p[o] ?? ""));
  if (!block.slice(1).some(isLabelRow)) return null;
  const aligned = body.map((r) => alignRow(r, width)).filter(Boolean);
  const { records, merged, mergedWithQty } = recordReader(block).group(aligned);
  const considered = records.length + merged;
  if (!considered || merged * 3 < considered || mergedWithQty > 0) return null;
  return block;
};

// Group body rows into records and map each to a line. `block` is the header
// rows, top first; every row in `rows` is already aligned to its width.
export const normalizeStackedRecords = (rows, block, diag = {}) => {
  const { K, slots, F, group } = recordReader(block);
  const { records, merged } = group(rows);

  const cell = (rec, s) => {
    const v = String(rec[s.o]?.[s.c] ?? "").trim();
    return !v || EMPTY_CELL.test(v) ? null : v;
  };
  const textOf = (rec, field) => {
    for (const s of F[field]) { const v = cell(rec, s); if (v != null) return v; }
    return null;
  };
  const numOf = (rec, field) => {
    for (const s of F[field]) { const n = strictNum(cell(rec, s)); if (n != null) return n; }
    return null;
  };

  const lines = [];
  let rejected = 0;
  let unproven = 0;
  let preTax = 0;
  let totalMismatch = 0;
  for (const rec of records) {
    const li = { _source: "table_columns" };
    li.lineNo = F.lineNo.length ? lineNumberOf(textOf(rec, "lineNo")) : null;
    for (const f of TEXT_FIELDS) li[f] = textOf(rec, f);
    li.quantity = numOf(rec, "quantity");
    const rawDate = textOf(rec, "delivery_date");
    // Day-first, as Indian and most non-US documents print it. An unparseable
    // date is kept as printed rather than dropped.
    li.delivery_date = rawDate ? (parsePoDate(rawDate, { hint: "DMY" }) || rawDate) : null;

    const taxes = {};
    for (const f of [...TAX_FIELDS, ...AUX_FIELDS]) {
      if (F[f].length) taxes[f] = numOf(rec, f);
    }
    const sum = (fs) => fs.reduce((a, f) => a + (taxes[f] > 0 ? taxes[f] : 0), 0);
    const tax = sum(TAX_FIELDS);
    const aux = sum(AUX_FIELDS);
    const pre = numOf(rec, "pre_tax_price");
    const unit = numOf(rec, "unit_price");
    const total = numOf(rec, "line_total");
    const r = rateFor({ pre, unit, tax, aux });
    li.unitPrice = r.rate;

    // An unproven pair keeps the old reading (the unit price as the rate), so
    // the per-unit taxes stay OFF the canonical slots: adding them to a rate
    // that may already include them is the double count this exists to stop.
    // They are kept on _rate_basis, and anomaly.js reports the line.
    if (r.basis !== "unproven") Object.assign(li, taxes);
    const check = totalCheckOf({ qty: li.quantity, rate: li.unitPrice, tax: r.basis === "unproven" ? 0 : tax, aux: r.basis === "unproven" ? 0 : aux, total });
    // line_total is the GROSS for the line (line-schema.js). A printed total
    // proved to be the taxable value is not one, so it stays on _rate_basis.
    li.line_total = check === "pre_tax" ? null : total;

    if (pre != null || unit != null) {
      li._rate_basis = {
        basis: r.basis,
        ...(r.unit_includes ? { unit_includes: r.unit_includes } : {}),
        ...(pre != null ? { pre_tax_price: pre } : {}),
        ...(unit != null ? { unit_price_printed: unit } : {}),
        ...(tax > 0 ? { per_unit_tax: round2(tax) } : {}),
        ...(aux > 0 ? { per_unit_aux: round2(aux) } : {}),
        ...(r.basis === "unproven" ? { taxes_printed: taxes } : {}),
        ...(total != null ? { total_printed: total } : {}),
        ...(check ? { total_check: check } : {}),
      };
    }
    if (rec.length > 1) li._record_rows = rec.length;

    // Identity AND money, as on the one-row path.
    if ((li.partNumber || li.customerItemCode || li.description) &&
        (li.quantity != null || li.unitPrice != null)) {
      lines.push(li);
      if (r.basis === "pre_tax") preTax++;
      if (r.basis === "unproven") unproven++;
      if (check === "mismatch") totalMismatch++;
    } else rejected++;
  }

  diag.record_rows = K;
  diag.continuation = (diag.continuation || 0) + merged;
  const glued = slots.filter((s) => s.glued_from);
  if (glued.length) diag.glued_labels = glued.map((s) => ({ offset: s.o, column: s.c, printed: s.glued_from, read_as: s.label }));
  diag.rows_considered = records.length;
  diag.rows_rejected = rejected;
  if (preTax) diag.rate_pre_tax = preTax;
  if (unproven) diag.rate_unproven = unproven;
  if (totalMismatch) diag.total_mismatch = totalMismatch;
  const maxLineNo = lines.reduce((m, l) => (Number.isFinite(l.lineNo) && l.lineNo > m ? l.lineNo : m), 0);
  if (maxLineNo > 0) diag.max_line_no = maxLineNo;
  return { lines, diag };
};

// A one-row header that prints BOTH a pre-tax price and a unit price takes the
// record path too, so the rate is proved the same way. Every other one-row
// header keeps the path below exactly as it was.
const needsRecordPath = (block) => {
  if (block.length > 1) return true;
  const slots = slotsOf(block);
  return slotsFor(slots, STACKED_FIELDS.pre_tax_price).length > 0
    && slotsFor(slots, STACKED_FIELDS.unit_price).length > 0;
};

export const normalizeFromHtml = (html) => {
  const tables = parseHtmlTablesDetailed(html);
  let header = null;
  let block = null;              // the header rows of one record, top first
  const rows = [];
  const diag = { tables: tables.length, matched: 0, continuation: 0, skipped: 0, misaligned: 0 };

  for (const { rows: t, parts, headRows } of tables) {
    const hi = pickHeaderRow(t);
    if (hi >= 0 && t.length > hi + 1) {
      // The header rows of one record: several <thead> / label rows
      // ("stacked_rows"), or one row whose cells stack their labels
      // ("stacked_cells"). Either way the body reads the same; `physical` is
      // how many table rows the header itself took.
      const hb = headerBlockOf(t, hi, headRows);
      const physical = hb.physical;
      let blk = hb.block;
      let form = blk.length > 1 ? "stacked_rows" : null;
      if (blk.length === 1) {
        const stacked = stackedHeaderOf(parts?.[hi], t.slice(hi + 1), t[hi].length);
        if (stacked) { blk = stacked; form = "stacked_cells"; }
      }
      if (!header) {
        header = t[hi];
        block = blk;
        // Which form LlamaParse sent. It varies run to run for one document.
        if (form) diag.header_form = form;
      }
      // A header row repeated further down (a page break inside a merged
      // table) is skipped. On a stacked layout that is every header row, not
      // just the first; rows with no letters at all are never treated as one.
      const keys = new Set([shapeKey(header)]);
      if (block.length > 1 || blk.length > 1) {
        for (const h of [...block, ...blk]) { const k = shapeKey(h); if (/[a-z]/.test(k)) keys.add(k); }
      }
      for (const r of t.slice(hi + physical)) {
        if (keys.has(shapeKey(r))) continue;               // repeated header
        const a = alignRow(r, header.length);
        if (a) rows.push(a); else diag.misaligned++;
      }
      diag.matched++;
    } else if (header) {
      // A table with NO column labels anywhere. On these documents that is the
      // continuation shape: pages after the first carry only a spanning page
      // banner, so there is nothing to score. Keep the rows that align to the
      // active header and actually carry numbers; the tax summary and address
      // blocks land here too and fail one of those two tests.
      let kept = 0;
      for (const r of t) {
        const a = alignRow(r, header.length);
        if (a && looksLikeDataRow(a)) { rows.push(a); kept++; }
      }
      if (kept) diag.continuation++; else diag.skipped++;
    } else {
      diag.skipped++;            // address block, tax summary, page furniture
    }
  }
  if (!header) return { lines: [], diag };
  if (needsRecordPath(block)) return normalizeStackedRecords(rows, block, diag);

  // Order matters. A naive /desc|name/ matches "Service Parent Name" — which is
  // "-" on every row of the observed layout — BEFORE "Item Description".
  const itemIdx  = firstIdx(header, [/item\s*(no|code|number)/i]);
  const descIdx  = firstIdx(header, [/item\s*desc/i, /^description$/i, /desc/i]);
  const specIdx  = firstIdx(header, [/item\s*spec|specification/i]);
  const partIdx  = firstIdx(header, [/part\s*(no|number|code)/i, /sku|material|catalog/i]);
  const qtyIdx   = firstIdx(header, [/q(ua)?nt|qty/i]);
  const priceIdx = firstIdx(header, [/unit\s*price/i, /^rate$/i, /^price$/i]);
  const uomIdx   = firstIdx(header, [/uom|u\/m/i]);
  const hsnIdx   = firstIdx(header, [/hsn|sac/i]);
  // Money columns make completeness EXACT: sum(lineTotal) against the printed
  // document total, with no per-unit tax reconstruction needed.
  const taxIdx   = firstIdx(header, [/^taxes?$/i, /tax\s*amount/i]);
  const totalIdx = firstIdx(header, [/line\s*total/i, /^total$/i, /^amount$/i]);
  // The printed line number, when the document numbers its own rows. Purely
  // opportunistic — plenty of layouts do not — but when it IS there it is an
  // independent count of how many lines the document claims, which is the one
  // signal that can catch a row the PARSER never saw. Must be matched after
  // totalIdx so /^line\s*total/ cannot be stolen by /^line$/.
  const lineNoIdx = firstIdx(header, [/^line$/i, /^line\s*(no|num|item)/i, /^s\.?\s*no/i, /^sl\.?\s*no/i]);

  const pick = (r, i) => {
    if (i < 0) return null;
    const v = (r[i] ?? "").trim();
    return !v || EMPTY_CELL.test(v) ? null : v;
  };

  const lines = [];
  // CONSERVATION. Every data row the parser accepted must become a line, or we
  // must be able to say how many did not. `rows` has already had headers and
  // repeats removed, so anything dropped below is dropped by OUR guard, not by
  // the document. Without this count a silent partial read is indistinguishable
  // from a short PO.
  let rowsConsidered = 0;
  let rowsRejected = 0;
  for (const r of rows) {
    if (!r.length) continue;
    rowsConsidered++;
    const li = {
      // PROVENANCE. These values came from LABELLED COLUMNS in a table, not
      // from prose an LLM interpreted. Downstream repair heuristics need to
      // know the difference: in a structured table the columns are
      // authoritative, and that includes their ABSENCE. There is no part-number
      // column in this layout, so partNumber is legitimately null — mining the
      // description for one produced "90-2" out of "...TWS-092-\n90-2", a
      // fragment split across a cell line-wrap that is not a part number at all.
      _source: "table_columns",
      lineNo: lineNoIdx >= 0 ? cellNum(r[lineNoIdx]) : null,
      partNumber: pick(r, partIdx),
      customerItemCode: pick(r, itemIdx),
      description: pick(r, descIdx),
      specification: pick(r, specIdx),
      quantity: qtyIdx >= 0 ? cellNum(r[qtyIdx]) : null,
      unitPrice: priceIdx >= 0 ? cellNum(r[priceIdx]) : null,
      uom: pick(r, uomIdx),
      hsn: pick(r, hsnIdx),
      tax_amount: taxIdx >= 0 ? cellNum(r[taxIdx]) : null,
      line_total: totalIdx >= 0 ? cellNum(r[totalIdx]) : null,
    };
    // Identity AND money, else it is page furniture, not a line item.
    if ((li.partNumber || li.customerItemCode || li.description) &&
        (li.quantity != null || li.unitPrice != null)) lines.push(li);
    else rowsRejected++;
  }
  diag.rows_considered = rowsConsidered;
  diag.rows_rejected = rowsRejected;
  // Highest printed line number seen. On a numbered document this is what the
  // page itself claims the line count to be.
  const maxLineNo = lines.reduce((m, l) => (Number.isFinite(l.lineNo) && l.lineNo > m ? l.lineNo : m), 0);
  if (maxLineNo > 0) diag.max_line_no = maxLineNo;
  return { lines, diag };
};

export const normalizeFromMarkdown = (md) => {
  const rows = parseMarkdownTable(md);
  // No pipe table? Try HTML before giving up — the agentic tier emits <table>.
  if (rows.length < 2) {
    const html = normalizeFromHtml(md);
    if (html.lines.length) return html;
    return { lines: [], diag: html.diag };
  }
  const header = rows[0].map((h) => h.toLowerCase());
  const idx = (re) => header.findIndex((h) => re.test(h));
  const partIdx = idx(/(part|sku|item|catalog|material)/);
  const descIdx = idx(/(desc|name)/);
  const qtyIdx = idx(/(qty|quantity|q'?ty)/);
  const priceIdx = idx(/(price|rate|unit)/);
  const hsnIdx = idx(/(hsn|sac)/);
  const num = (s) => { const n = Number(String(s || "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : null; };
  const lines = [];
  for (const r of rows.slice(1)) {
    if (!r.length) continue;
    const li = {
      partNumber: partIdx >= 0 ? (r[partIdx] || null) : null,
      description: descIdx >= 0 ? (r[descIdx] || null) : null,
      quantity: qtyIdx >= 0 ? num(r[qtyIdx]) : null,
      unitPrice: priceIdx >= 0 ? num(r[priceIdx]) : null,
      hsn: hsnIdx >= 0 ? (r[hsnIdx] || null) : null,
    };
    if (li.partNumber || li.description) lines.push(li);
  }
  return { lines };
};

// LlamaParse returns no confidence score, so derive one from extraction
// completeness: the share of lines that carry BOTH an item identity and a
// quantity. A clean line table clears the dispatcher's fallback threshold
// (docai_fallback_confidence, 0.85 default); a table with no quantities stays
// below it so the chain falls through to another engine rather than trusting a
// half-read table. Hardcoding 0.8 (the old value) sat permanently below the
// threshold, so LlamaParse could never win as the primary.
//
// The identity is our part number OR the buyer's own item code. Counting only
// partNumber kept every table keyed by the buyer's code at 0.82, below the
// threshold, on exactly the layouts this parser reads best: neither the
// one-row layout above nor the stacked one prints a part column of ours. The
// intake's customer match refuses any run below 0.85, so a perfect 25-of-25
// read could never select its customer.
export const scoreConfidence = (lines) => {
  if (!lines || !lines.length) return 0.4;
  const complete = lines.filter((l) => l && (l.partNumber || l.customerItemCode) && l.quantity != null).length / lines.length;
  return Math.min(0.97, 0.82 + 0.15 * complete);
};

// Pull the markdown string out of the SDK parse result across its shape
// variants. `markdown_full` is the plain full-document string; `markdown` is a
// STRUCTURED object ({ pages: [{ markdown }] }), so join its pages when the
// flat string isn't present. (Older/loose shapes may put a string on
// `markdown` or a top-level `pages` array — handle both.)
export const markdownOf = (result) => {
  if (typeof result?.markdown_full === "string" && result.markdown_full) return result.markdown_full;
  const md = result?.markdown;
  if (typeof md === "string" && md) return md;
  const pages = md?.pages || result?.pages;
  if (Array.isArray(pages)) return pages.map((p) => p?.markdown || p?.md || "").join("\n\n").trim();
  return "";
};

// The PO header, read from the same markdown. The tenant's own names and
// GSTINs come from tenant_settings (the e-invoice seller block, migration 062,
// plus the older keys tenant-scrub.js and run.js also read), so the supplier
// block the PO is addressed to is never taken as the buyer.
const ownIdentity = (settings) => ({
  ownNames: [
    settings?.einvoice_seller_legal_name, settings?.einvoice_seller_trade_name,
    settings?.tenant_display_name, settings?.tally_company_name,
  ].filter(Boolean),
  ownGstins: [settings?.einvoice_seller_gstin, settings?.tenant_gstin].filter(Boolean),
});
const isLineItemTable = (tableHtml) => {
  const t = parseHtmlTables(tableHtml)[0];
  return !!t && pickHeaderRow(t) >= 0;
};
export const readHeader = (md, settings) => readPoHeader(md, { ...ownIdentity(settings), isLineItemTable });

// The LlamaCloud SDK's parse() polls to completion internally and exposes no
// timeout or AbortSignal, so it is the ONE call in the whole extraction chain
// with no upper bound. Left unbounded it outlives docai's 45s RUN_BUDGET_MS and
// vercel.json's maxDuration of 60 — the function is killed mid-flight, run.js
// never writes its final UPDATE, and the row sits at status='running' forever.
// Race it against a timer so the adapter always returns something diagnosable.
// The timer is unref'd (so a pending parse can't hold the lambda open) and
// always cleared in finally (so a fast parse doesn't leak a handle).
const withTimeout = (promise, ms, label) => {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
};

// Budget for the SDK call: whatever the run has left minus a small reserve so
// the dispatcher can still record the attempt, capped at the standalone
// ceiling. No deadline (non-docai callers) => the ceiling.
const LLAMAPARSE_TIMEOUT_MS = Number(process.env.LLAMAPARSE_TIMEOUT_MS || 45_000);
const LLAMAPARSE_RESERVE_MS = 2000;
export const parseBudgetMs = (deadlineAt, now = Date.now(), ceilingMs = LLAMAPARSE_TIMEOUT_MS) =>
  (deadlineAt ? Math.min(ceilingMs, Math.max(0, deadlineAt - now - LLAMAPARSE_RESERVE_MS)) : ceilingMs);

export const extract = async ({ url, bytes, filename, mime, settings, hints }) => {
  const key = apiKey(settings);
  if (!key) return { ok: false, reason: "no_api_key", error: "LlamaParse key not set (tenant docai_llamacloud_api_key_enc or LLAMAPARSE_API_KEY env)" };
  try {
    let fileBytes = bytes;
    if (!fileBytes && url) {
      const dl = await safeFetch(url);
      if (!dl.ok) return { ok: false, status: dl.status, reason: "fetch_failed", error: "could not fetch document url" };
      fileBytes = Buffer.from(await dl.arrayBuffer());
    }
    if (!fileBytes) return { ok: false, reason: "no_source_bytes", error: "LlamaParse adapter requires url or bytes" };

    // Dynamic import keeps the SDK out of cold-start until a tenant opts in.
    const { default: LlamaCloud, toFile } = await import("@llamaindex/llama-cloud");
    const client = new LlamaCloud({ apiKey: key });

    // One-shot: upload + parse + wait-for-completion. `expand` valid values are
    // text/markdown (NOT "markdown_full" — that's a RESPONSE field, and passing
    // it as an expand option makes the API reject the request). The full
    // markdown string comes back on result.markdown_full; markdownOf also
    // handles the structured result.markdown.pages[] shape.
    const uploadable = await toFile(fileBytes, filename || "document.pdf", { type: mime || "application/pdf" });
    const deadlineAt = Number(hints?.deadlineAt) || 0;
    const budgetMs = parseBudgetMs(deadlineAt);
    // Only a real deadline can exhaust the budget; with none, the ceiling
    // stands (so a deliberately small LLAMAPARSE_TIMEOUT_MS still runs).
    if (deadlineAt && budgetMs < LLAMAPARSE_RESERVE_MS) {
      return { ok: false, reason: "run_budget_exhausted", error: "no run budget left for a LlamaParse call" };
    }
    const result = await withTimeout(client.parsing.parse({
      upload_file: uploadable,
      tier: tier(),
      version: parseVersion(),
      expand: ["markdown"],
      // We previously sent NO option groups at all and took every default,
      // which is how the adapter ended up parsing an output shape nobody chose.
      output_options: {
        markdown: {
          tables: {
            // Deliberately HTML, not pipe tables. The API reference is
            // explicit that markdown tables "cannot represent complex
            // structures like merged cells" — and merged cells are exactly what
            // these POs are made of (the stacked layout where one logical line
            // spans four physical rows). Pipe tables would be easier to parse
            // and would silently lose structure on the hardest documents, which
            // is the wrong trade. normalizeFromHtml reads this shape.
            //
            // Set EXPLICITLY rather than inherited: the adapter previously sent
            // no output_options at all, so the shape was whatever LlamaParse
            // defaulted to, and normalizeFromMarkdown only spoke pipe. That
            // mismatch returned zero lines on a perfectly parsed 13-page PO.
            output_tables_as_markdown: false,
            // A PO line-item table that spans 13 pages is ONE table. Without
            // this, each page arrives as its own table and every continuation
            // page after the first has no header row — which is precisely the
            // regression that made chunked extraction return lineItems: [] and
            // got CHUNK_PAGE_THRESHOLD raised from 10 to 25 (run.js). Letting
            // LlamaParse stitch it server-side fixes the cause, not the symptom.
            merge_continued_tables: true,
          },
        },
      },
      // Bound the job server-side to the same budget we bound the client to.
      // Without this LlamaParse keeps working — and keeps billing — long after
      // withTimeout has abandoned the call and the run has already failed.
      processing_control: {
        timeouts: { base_in_seconds: Math.max(10, Math.floor(budgetMs / 1000)) },
      },
    }), budgetMs, "LlamaParse parse");
    const md = markdownOf(result);
    const norm = normalizeFromMarkdown(md);
    const { lines } = norm;
    // Zero parsed line items is not a success. Returning ok:true here made this
    // adapter the dispatcher's `last` result, so a run in which every real
    // extractor had already hard-failed was reported as a soft "low confidence
    // · review" with no error — masking the actual outage. An adapter that
    // extracted nothing must fail so the errors above it stay visible.
    if (!lines.length) {
      return {
        ok: false,
        reason: "empty_lines",
        error: "LlamaParse found no parsable line-item table (" + md.length + " chars of markdown"
          + (norm.diag ? "; tables=" + norm.diag.tables + " matched=" + norm.diag.matched
             + " skipped=" + norm.diag.skipped : "; no pipe rows and no <table> markup") + ")",
        raw: {
          job_id: result?.job?.id || null, tier: tier(), version: parseVersion(),
          markdown: md, chars: md.length,
          // Which table shape the parser actually found. A change here between
          // runs is a LlamaParse output-format change, and is the single most
          // useful thing to know when this adapter starts returning nothing.
          parse_format: /<table/i.test(md) ? "html" : (/^\s*\|/m.test(md) ? "pipe" : "none"),
          table_diag: norm.diag || null,
        },
      };
    }
    const header = readHeader(md, settings);
    const overall = scoreConfidence(lines);
    const confidences = { overall };
    lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = overall; });

    return {
      ok: true,
      // LlamaParse parses tables; it does not classify. A line table having
      // been found is the reason this adapter is selected for this flow, so
      // we treat it as a PO. (The empty case returned above.) The header (PO
      // number, date, buyer, vendor code, printed total) is read from the
      // same markdown by po-header-text.js, by label, and never as us.
      normalized: {
        classification: "po",
        customer: header.customer,
        ...(header.totals ? { totals: header.totals } : {}),
        lines,
        // CONSERVATION, carried onto the SUCCESS path.
        //
        // These counters existed already and were emitted only when the parse
        // FAILED — i.e. never at the moment they matter. A run that reports
        // `ok` while having quietly dropped rows is exactly the case you cannot
        // diagnose after the fact, and that is the case we hit: 44 of 45 lines,
        // status ok, validator clean, and no way to tell whether the 45th was
        // lost by LlamaParse or by us.
        //
        // stated_line_count is populated ONLY from a printed line number. It is
        // deliberately not inferred from row counts, because a count derived
        // from the same rows it is meant to police proves nothing.
        parse_conservation: {
          rows_considered: norm.diag?.rows_considered ?? null,
          rows_rejected: norm.diag?.rows_rejected ?? null,
          lines_emitted: lines.length,
          tables_matched: norm.diag?.matched ?? null,
          tables_skipped: norm.diag?.skipped ?? null,
          rows_misaligned: norm.diag?.misaligned ?? null,
          max_line_no: norm.diag?.max_line_no ?? null,
          // A stacked layout: rows_considered counts ITEMS (records of up to
          // record_rows printed rows), and continuation_rows the printed rows
          // merged into them.
          ...(norm.diag?.record_rows ? { record_rows: norm.diag.record_rows, continuation_rows: norm.diag.continuation } : {}),
        },
        ...(norm.diag?.max_line_no ? { stated_line_count: norm.diag.max_line_no } : {}),
      },
      confidences,
      reason: "ok",
      raw: {
        job_id: result?.job?.id || null, tier: tier(), markdown: md, chars: md.length,
        // Same two fields the failure path records. A format change is only
        // visible if we keep them when the parse SUCCEEDS too — by the time it
        // starts failing, the run that first drifted is long gone.
        version: parseVersion(),
        parse_format: /<table/i.test(md) ? "html" : (/^\s*\|/m.test(md) ? "pipe" : "none"),
        table_diag: norm.diag || null,
        header_fields: header.fields,
      },
    };
  } catch (err) {
    return { ok: false, reason: "adapter_threw", error: String(err?.message || err) };
  }
};

// Exported for tests (pure mapping, no network).
export const __test__ = { parseMarkdownTable, normalizeFromMarkdown, normalizeFromHtml, normalizeStackedRecords, parseHtmlTables, pickHeaderRow, alignRow, isLabelRow, unglue, scoreConfidence, markdownOf, readHeader, tier, parseVersion, apiKey };
