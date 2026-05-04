// Unstructured.io adapter. Best-of-class chunking for messy
// scanned faxes and PDFs that defeated Reducto/Azure. Returns
// labeled elements (Title, NarrativeText, Table, ListItem). We
// pull tables out; everything else is metadata.

import { decryptField } from "../secrets.js";

const BASE_URL = "https://api.unstructured.io/general/v0/general";

const apiKey = (settings) => {
  if (settings?.docai_unstructured_api_key_enc && settings?.docai_creds_iv) {
    try { return decryptField(settings.docai_unstructured_api_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* */ }
  }
  return process.env.UNSTRUCTURED_API_KEY || null;
};

export const isConfigured = (settings) => !!apiKey(settings);

const callUnstructured = async (key, fileBytes, filename) => {
  const form = new FormData();
  form.append("files", new Blob([fileBytes]), filename || "document.pdf");
  form.append("strategy", "hi_res");
  form.append("hi_res_model_name", "yolox");
  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "unstructured-api-key": key, accept: "application/json" },
    body: form,
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

const normalizeFromUnstructured = (elements) => {
  const tables = (elements || []).filter((e) => e.type === "Table");
  const lines = [];
  for (const t of tables) {
    const html = t.metadata?.text_as_html || "";
    if (!html) continue;
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const rows = [];
    let m;
    while ((m = rowRe.exec(html))) {
      const cells = [];
      let c;
      while ((c = cellRe.exec(m[1]))) {
        cells.push(String(c[1]).replace(/<[^>]+>/g, "").trim());
      }
      rows.push(cells);
    }
    if (!rows.length) continue;
    const header = rows[0];
    const colIdx = (re) => header.findIndex((h) => re.test(String(h || "").toLowerCase()));
    const partIdx = colIdx(/(part|sku|item|catalog)/);
    const qtyIdx  = colIdx(/(qty|quantity)/);
    const priceIdx = colIdx(/(price|rate)/);
    const descIdx  = colIdx(/(desc|name)/);
    for (const r of rows.slice(1)) {
      const li = {
        partNumber: partIdx >= 0 ? r[partIdx] : null,
        description: descIdx >= 0 ? r[descIdx] : null,
        quantity: qtyIdx >= 0 ? Number(String(r[qtyIdx] || "0").replace(/[^\d.]/g, "")) : null,
        unitPrice: priceIdx >= 0 ? Number(String(r[priceIdx] || "0").replace(/[^\d.]/g, "")) : null,
      };
      if (li.partNumber || li.description) lines.push(li);
    }
  }
  return { customer: null, lines, raw_element_count: (elements || []).length };
};

export const extract = async ({ bytes, filename, settings }) => {
  const key = apiKey(settings);
  if (!key) return { ok: false, error: "Unstructured.io not configured" };
  if (!bytes) return { ok: false, error: "Unstructured adapter requires file bytes" };
  const r = await callUnstructured(key, bytes, filename);
  if (!r.ok) return { ok: false, status: r.status, error: JSON.stringify(r.body).slice(0, 400) };
  const normalized = normalizeFromUnstructured(r.body);
  const confidences = {};
  normalized.lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.7; });
  confidences["overall"] = normalized.lines.length ? 0.7 : 0.3;
  return { ok: true, raw: r.body, normalized, confidences };
};
