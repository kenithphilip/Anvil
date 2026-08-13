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
const stripTags = (s) => String(s)
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ").trim();

// Rows for every <table> in the document. Header recovery matters: emitters
// differ on whether header cells sit inside a <tr>. Observed in production:
// <thead> holds bare <th> while <tbody> rows are wrapped. A naive <tr> scan
// therefore captures data rows but NO header, the first data row becomes row 0,
// the column-label test fails, and the whole table is discarded.
export const parseHtmlTables = (html) => {
  const tables = [];
  for (const tbl of String(html || "").match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = [];
    for (const tr of tbl.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(stripTags);
      if (cells.length) rows.push(cells);
    }
    const ths = (tbl.match(/<th[\s\S]*?<\/th>/gi) || []).map(stripTags);
    const alreadyHasHeader = rows.length && rows[0].join("|") === ths.join("|");
    if (ths.length && !alreadyHasHeader) rows.unshift(ths);
    // No <tr> anywhere: chunk the <td> stream by header width. Exact for a
    // rectangular table, which a rendered PO table is.
    if (rows.length <= 1 && ths.length) {
      const tds = (tbl.match(/<td[\s\S]*?<\/td>/gi) || []).map(stripTags);
      for (let i = 0; i + ths.length <= tds.length; i += ths.length) rows.push(tds.slice(i, i + ths.length));
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
};

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

export const normalizeFromHtml = (html) => {
  const tables = parseHtmlTables(html);
  let header = null;
  const rows = [];
  const diag = { tables: tables.length, matched: 0, continuation: 0, skipped: 0 };

  for (const t of tables) {
    if (headerScore(t[0]) >= MIN_HEADER_HITS && t.length > 1) {
      if (!header) header = t[0];
      const key = shapeKey(header);
      // Continuation pages repeat the header; drop the repeats, keep the data.
      for (const r of t.slice(1)) { if (shapeKey(r) !== key) rows.push(r); }
      diag.matched++;
    } else if (header && t[0] && t[0].length === header.length && looksLikeDataRow(t[0])) {
      rows.push(...t);           // continuation page that dropped its header
      diag.continuation++;
    } else {
      diag.skipped++;            // address block, tax summary, page furniture
    }
  }
  if (!header) return { lines: [], diag };

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

  const pick = (r, i) => {
    if (i < 0) return null;
    const v = (r[i] ?? "").trim();
    return !v || EMPTY_CELL.test(v) ? null : v;
  };

  const lines = [];
  for (const r of rows) {
    if (!r.length) continue;
    const li = {
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
  }
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
// completeness: the share of lines that carry BOTH a part number and a
// quantity. A clean line table clears the dispatcher's fallback threshold
// (docai_fallback_confidence, 0.85 default); a table with no quantities stays
// below it so the chain falls through to another engine rather than trusting a
// half-read table. Hardcoding 0.8 (the old value) sat permanently below the
// threshold, so LlamaParse could never win as the primary.
export const scoreConfidence = (lines) => {
  if (!lines || !lines.length) return 0.4;
  const complete = lines.filter((l) => l && l.partNumber && l.quantity != null).length / lines.length;
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
    const overall = scoreConfidence(lines);
    const confidences = { overall };
    lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = overall; });

    return {
      ok: true,
      // LlamaParse parses tables; it does not classify or read the customer
      // header. A line table having been found is the reason this adapter is
      // selected for this flow, so we treat it as a PO; downstream customer
      // matching can run off raw.markdown. (The empty case returned above.)
      normalized: {
        classification: "po",
        customer: null,
        lines,
      },
      confidences,
      reason: "ok",
      raw: { job_id: result?.job?.id || null, tier: tier(), markdown: md, chars: md.length },
    };
  } catch (err) {
    return { ok: false, reason: "adapter_threw", error: String(err?.message || err) };
  }
};

// Exported for tests (pure mapping, no network).
export const __test__ = { parseMarkdownTable, normalizeFromMarkdown, normalizeFromHtml, parseHtmlTables, scoreConfidence, markdownOf, tier, parseVersion, apiKey };
