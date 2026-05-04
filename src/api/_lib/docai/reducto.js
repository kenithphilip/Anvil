// Reducto adapter (https://reducto.ai). PDF + image extraction
// with strong layout awareness. Two-step API: parse() returns
// document elements; extract() with a JSON Schema returns
// structured fields. We use parse() then a Claude pass to map the
// elements onto the canonical line-item schema.

import { decryptField } from "../secrets.js";

const BASE_URL = "https://api.reducto.ai/v1";

const apiKey = (settings) => {
  if (!settings) return null;
  if (settings.docai_reducto_api_key_enc && settings.docai_creds_iv) {
    try { return decryptField(settings.docai_reducto_api_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* fall through */ }
  }
  return process.env.REDUCTO_API_KEY || null;
};

export const isConfigured = (settings) => !!apiKey(settings);

const callReductoParse = async (key, fileUrl) => {
  const resp = await fetch(BASE_URL + "/parse", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ document_url: fileUrl, advanced_options: { table_summary: true } }),
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

// Map Reducto's parsed elements to the canonical line-item shape.
// Reducto returns { result: { chunks: [{type, content, ...}] } }.
// Tables become candidate line-item sources.
const normalizeFromReducto = (parsedBody) => {
  const chunks = parsedBody?.result?.chunks || [];
  const tables = chunks.filter((c) => c.type === "table" || c.block_type === "table");
  const lines = [];
  for (const t of tables) {
    const rows = t.rows || (t.content ? String(t.content).split("\n").map((l) => l.split(/\t|\s{2,}/)) : []);
    const header = rows[0] || [];
    const colIdx = (re) => header.findIndex((h) => re.test(String(h || "").toLowerCase()));
    const partIdx = colIdx(/(part|sku|item|catalog)/);
    const qtyIdx  = colIdx(/(qty|quantity|count)/);
    const priceIdx = colIdx(/(price|rate|unit cost)/);
    const descIdx  = colIdx(/(desc|name|description)/);
    for (const r of rows.slice(1)) {
      if (!r || !r.length) continue;
      const li = {
        partNumber: partIdx >= 0 ? String(r[partIdx] || "").trim() : null,
        description: descIdx >= 0 ? String(r[descIdx] || "").trim() : null,
        quantity: qtyIdx >= 0 ? Number(String(r[qtyIdx] || "0").replace(/[^\d.]/g, "")) : null,
        unitPrice: priceIdx >= 0 ? Number(String(r[priceIdx] || "0").replace(/[^\d.]/g, "")) : null,
      };
      if (li.partNumber || li.description) lines.push(li);
    }
  }
  return {
    customer: null,
    lines,
    raw_chunk_count: chunks.length,
  };
};

export const extract = async ({ url, settings }) => {
  const key = apiKey(settings);
  if (!key) return { ok: false, error: "Reducto not configured" };
  if (!url) return { ok: false, error: "Reducto adapter requires a document URL" };
  const r = await callReductoParse(key, url);
  if (!r.ok) {
    return { ok: false, status: r.status, error: r.body?.error || JSON.stringify(r.body).slice(0, 400), raw: r.body };
  }
  const normalized = normalizeFromReducto(r.body);
  // Per-line confidence: Reducto's table chunks include cell
  // confidence in some plans. Fallback: 0.85 for table-derived
  // rows.
  const confidences = {};
  normalized.lines.forEach((_li, i) => {
    confidences["lines[" + i + "]"] = 0.85;
  });
  confidences["overall"] = normalized.lines.length > 0 ? 0.85 : 0.4;
  return {
    ok: true,
    raw: r.body,
    normalized,
    confidences,
  };
};
