// LlamaParse (LlamaCloud) extraction adapter — plug-and-play alongside
// gemini / claude / the other engines in the DocAI provider chain.
//
// LlamaParse is a DOCUMENT-PARSING engine (PDF/scan -> structured markdown +
// tables), NOT a chat LLM. Its home is the docai extraction chain, where it is
// switchable in place of the Claude-vision extractor / Mistral OCR — NOT the
// reasoning-LLM abstraction (llm.js), which it cannot serve.
//
// Keyed EXACTLY like claude/gemini: a single server env var, no per-tenant
// config entity, no encryption. It's just another selectable engine — add
// "llamaparse" to docai_provider_order (Admin > Document AI) and set the key.
// OFF by default (not in the default order; no key => isConfigured() false =>
// dispatcher skips it).
//
// ENV: LLAMAPARSE_API_KEY (primary; the var the deployment sets). Falls back to
// LLAMA_CLOUD_API_KEY for older configs. Tier via LLAMAPARSE_TIER
// (fast|balanced|agentic|agentic_plus); default "agentic" (best accuracy).
//
// DATA RESIDENCY: LlamaCloud is US/EU only. Enabling it sends document content
// to a US/EU SaaS — a deployment choice made by whoever sets the env key, same
// as choosing Gemini or Claude.

import { safeFetch } from "../safe-fetch.js";

const apiKey = () => process.env.LLAMAPARSE_API_KEY || process.env.LLAMA_CLOUD_API_KEY || null;
const tier = () => process.env.LLAMAPARSE_TIER || "agentic";

// Config is purely the presence of the env key (mirrors claude.js/gemini.js).
export const isConfigured = (_settings) => !!apiKey();

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

export const normalizeFromMarkdown = (md) => {
  const rows = parseMarkdownTable(md);
  if (rows.length < 2) return { lines: [] };
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

export const extract = async ({ url, bytes, filename, mime }) => {
  const key = apiKey();
  if (!key) return { ok: false, reason: "no_api_key", error: "LLAMAPARSE_API_KEY not set" };
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
    const result = await client.parsing.parse({
      upload_file: uploadable,
      tier: tier(),
      expand: ["markdown"],
    });
    const md = markdownOf(result);
    const { lines } = normalizeFromMarkdown(md);
    const overall = scoreConfidence(lines);
    const confidences = { overall };
    lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = overall; });

    return {
      ok: true,
      // LlamaParse parses tables; it does not classify or read the customer
      // header. When a line table is found we treat it as a PO (the reason
      // it's selected for this flow); downstream customer matching can run
      // off raw.markdown. Empty table => leave classification null.
      normalized: {
        classification: lines.length ? "po" : null,
        customer: null,
        lines,
      },
      confidences,
      reason: lines.length === 0 ? "empty_lines" : "ok",
      raw: { job_id: result?.job?.id || null, tier: tier(), markdown: md, chars: md.length },
    };
  } catch (err) {
    return { ok: false, reason: "adapter_threw", error: String(err?.message || err) };
  }
};

// Exported for tests (pure mapping, no network).
export const __test__ = { parseMarkdownTable, normalizeFromMarkdown, scoreConfidence, markdownOf, tier, apiKey };
