// Unstructured.io adapter. Best-of-class chunking for messy
// scanned faxes and PDFs that defeated Reducto/Azure. Returns
// labeled elements (Title, NarrativeText, Table, ListItem). We
// pull tables out; everything else is metadata.
//
// Two modes (Phase C, May 2026):
//   1. Hosted (api.unstructured.io). Needs an API key; the plain
//      free tier is small but sufficient for evaluation.
//   2. Self-hosted Docker (downloads.unstructured.io/.../unstructured-api).
//      No per-page cost. Operator runs the container reachable at
//      DOCAI_UNSTRUCTURED_ENDPOINT and either disables auth or
//      sets a key via UNSTRUCTURED_API_KEY (the OSS server passes
//      it through unchanged).
//
// We pick the endpoint by precedence: explicit settings field >
// env var > default hosted URL. Hosted requires a key; self-hosted
// runs without one.

import { decryptField } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";

const HOSTED_URL = "https://api.unstructured.io/general/v0/general";

const apiKey = (settings) => {
  if (settings?.docai_unstructured_api_key_enc && settings?.docai_creds_iv) {
    try { return decryptField(settings.docai_unstructured_api_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* */ }
  }
  return process.env.UNSTRUCTURED_API_KEY || null;
};

const endpoint = (settings) =>
  settings?.docai_unstructured_endpoint
    || process.env.UNSTRUCTURED_ENDPOINT
    || HOSTED_URL;

const isHosted = (ep) => /api\.unstructured\.io/i.test(ep);

// Configured = either we hit a self-hosted URL (no key required)
// or we hit the hosted URL with a key. The hosted-without-key case
// returns false so the dispatcher skips us cleanly.
export const isConfigured = (settings) => {
  const ep = endpoint(settings);
  if (!isHosted(ep)) return true;
  return !!apiKey(settings);
};

const callUnstructured = async ({ ep, key, fileBytes, filename }) => {
  const form = new FormData();
  form.append("files", new Blob([fileBytes]), filename || "document.pdf");
  form.append("strategy", "hi_res");
  form.append("hi_res_model_name", "yolox");
  const headers = { accept: "application/json" };
  if (key) headers["unstructured-api-key"] = key;
  const resp = await safeFetch(ep, {
    method: "POST",
    headers,
    body: form,
    timeoutMs: 120_000,
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
  const ep = endpoint(settings);
  const key = apiKey(settings);
  if (isHosted(ep) && !key) return { ok: false, error: "Unstructured.io hosted needs an API key" };
  if (!bytes) return { ok: false, error: "Unstructured adapter requires file bytes" };
  const r = await callUnstructured({ ep, key, fileBytes: bytes, filename });
  if (!r.ok) return { ok: false, status: r.status, error: JSON.stringify(r.body).slice(0, 400), raw: r.body };
  const normalized = normalizeFromUnstructured(r.body);
  const confidences = {};
  normalized.lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.7; });
  confidences["overall"] = normalized.lines.length ? 0.7 : 0.3;
  return {
    ok: true,
    raw: r.body,
    normalized,
    confidences,
    mode: isHosted(ep) ? "hosted" : "self_hosted",
  };
};

// Exported for tests.
export const __test__ = { endpoint, isHosted };
