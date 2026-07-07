// LlamaParse (LlamaCloud) extraction adapter — plug-and-play alongside
// gemini / claude / the other engines in the provider chain.
//
// Keyed EXACTLY like claude/gemini: a single server env var
// (LLAMA_CLOUD_API_KEY), no per-tenant config entity, no encryption. It's
// just another selectable engine — add "llamaparse" to docai_provider_order
// and set the key. OFF by default (not in the default order + no key = skip).
//
// Uses the official @llamaindex/llama-cloud SDK: upload the file, then
// parse() with the chosen tier and pull markdown_full, mapped onto the
// canonical line-item shape. Tier defaults to "agentic" (best accuracy);
// override with LLAMAPARSE_TIER=fast|balanced|agentic|agentic_plus.
//
// DATA RESIDENCY: LlamaCloud is US/EU only. Enabling it sends document
// content to a US/EU SaaS — a deployment choice made by whoever sets the
// env key, same as choosing Gemini or Claude.

import { safeFetch } from "../safe-fetch.js";

const tier = () => process.env.LLAMAPARSE_TIER || "agentic";

// Mirror claude.js: config is purely the presence of the env key.
export const isConfigured = (_settings) => !!process.env.LLAMA_CLOUD_API_KEY;

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

export const extract = async ({ url, bytes, filename }) => {
  const key = process.env.LLAMA_CLOUD_API_KEY;
  if (!key) return { ok: false, error: "LLAMA_CLOUD_API_KEY not set" };
  try {
    let fileBytes = bytes;
    if (!fileBytes && url) {
      const dl = await safeFetch(url);
      if (!dl.ok) return { ok: false, status: dl.status, error: "could not fetch document url" };
      fileBytes = Buffer.from(await dl.arrayBuffer());
    }
    if (!fileBytes) return { ok: false, error: "LlamaParse adapter requires url or bytes" };

    // Dynamic import keeps the SDK out of cold-start until a tenant opts in.
    const { default: LlamaCloud } = await import("@llamaindex/llama-cloud");
    const client = new LlamaCloud({ apiKey: key });

    const file = new File([fileBytes], filename || "document.pdf", { type: "application/pdf" });
    const fileObj = await client.files.create({ file, purpose: "parse" });
    const result = await client.parsing.parse({
      file_id: fileObj.id,
      tier: tier(),
      expand: ["markdown_full"],
    });
    const md = result?.markdown_full || result?.markdown || "";
    const normalized = normalizeFromMarkdown(md);
    const confidences = {};
    normalized.lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.8; });
    confidences["overall"] = normalized.lines.length > 0 ? 0.8 : 0.4;
    return { ok: true, raw: { file_id: fileObj.id, tier: tier(), chars: md.length }, normalized, confidences };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
};

// Exported for tests (pure mapping, no network).
export const __test__ = { parseMarkdownTable, normalizeFromMarkdown, tier };
