// Docling adapter (https://github.com/docling-project/docling).
//
// IBM Research's open-source document parser. MIT licensed, runs as
// a self-hosted FastAPI service via `docling-serve`. We talk to it
// over HTTP so Anvil's Vercel-serverless runtime stays Node-only;
// the Docling Python service runs wherever the operator deploys it
// (Cloud Run, Fly.io, Kubernetes, on-prem).
//
// Why we want it: independent benchmarks place Docling at ~98%
// accuracy on complex-table extraction, which is exactly the
// failure mode our customer POs hit when SAP / Tally output
// merged-cell line-item grids. It's a strong "second opinion" for
// the Phase C cross-adapter voter, all without per-page fees.
//
// API contract (docling-serve v1):
//   POST /v1/convert/source   JSON  { sources: [{ kind: "http", url }] }
//   POST /v1/convert/file     multipart  files=<bytes>
//
// Both return { document: { md_content, json_content, ... } }. We
// parse `md_content` for the canonical line-item shape and keep
// the full json_content in `raw` for diagnostics.

import { decryptField } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";
import { classifyColumns, columnMatchCount } from "./table-columns.js";

const apiKey = (settings) => {
  if (settings?.docai_docling_api_key_enc && settings?.docai_creds_iv) {
    try { return decryptField(settings.docai_docling_api_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* fall through */ }
  }
  return process.env.DOCLING_API_KEY || null;
};

const endpoint = (settings) =>
  settings?.docai_docling_endpoint
    || process.env.DOCLING_ENDPOINT
    || null;

// Configured = endpoint is set. Docling-serve only requires the
// X-Api-Key header when DOCLING_SERVE_API_KEY is configured on the
// server side; for free / open instances no key is needed.
export const isConfigured = (settings) => !!endpoint(settings);

const baseHeaders = (key) => {
  const h = { Accept: "application/json" };
  if (key) h["X-Api-Key"] = key;
  return h;
};

const callDoclingByUrl = async ({ ep, key, fileUrl }) => {
  const url = ep.replace(/\/+$/, "") + "/v1/convert/source";
  const body = JSON.stringify({
    sources: [{ kind: "http", url: fileUrl }],
    options: {
      to_formats: ["md", "json"],
      do_ocr: true,
      do_table_structure: true,
    },
  });
  const resp = await safeFetch(url, {
    method: "POST",
    headers: { ...baseHeaders(key), "Content-Type": "application/json" },
    body,
    timeoutMs: 120_000,         // OCR + table structure on a 10-page PDF can run ~30s
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

const callDoclingByFile = async ({ ep, key, bytes, filename }) => {
  const url = ep.replace(/\/+$/, "") + "/v1/convert/file";
  const form = new FormData();
  form.append("files", new Blob([bytes]), filename || "document.pdf");
  // Match the JSON-body call's options. Sent as form fields (the
  // server accepts both shapes per the openapi spec).
  form.append("to_formats", "md");
  form.append("to_formats", "json");
  form.append("do_ocr", "true");
  form.append("do_table_structure", "true");
  const resp = await safeFetch(url, {
    method: "POST",
    headers: baseHeaders(key),
    body: form,
    timeoutMs: 120_000,
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

// Markdown table -> array of cell rows. Docling emits standard
// pipe-table markdown. We split on newline, strip the separator
// line, then split each row on `|` while respecting escaped pipes.
const parseMarkdownTable = (block) => {
  const lines = String(block || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (lines.length < 2) return [];
  // Drop the alignment row (e.g. |---|---|).
  const dataLines = lines.filter((l) => !/^\|\s*-+\s*(\|\s*-+\s*)+\|$/.test(l));
  return dataLines.map((row) =>
    row.replace(/^\||\|$/g, "").split(/\s*\|\s*/).map((c) => c.replace(/\\\|/g, "|").trim())
  );
};

// Walk the markdown for tables. We consider a "table" any
// consecutive run of pipe-prefixed lines.
const extractTables = (md) => {
  if (!md) return [];
  const tables = [];
  const lines = md.split(/\r?\n/);
  let block = [];
  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      block.push(line);
    } else if (block.length) {
      tables.push(block.join("\n"));
      block = [];
    }
  }
  if (block.length) tables.push(block.join("\n"));
  return tables.map(parseMarkdownTable).filter((rows) => rows.length >= 2);
};

const colIdx = (header, re) => header.findIndex((h) => re.test(String(h || "").toLowerCase()));

const normalizeFromDocling = (body) => {
  const doc = body?.document || {};
  const md = doc.md_content || doc.markdown || "";
  const tables = extractTables(md);
  const lines = [];
  for (const rows of tables) {
    if (rows.length < 2) continue;
    const header = rows[0];
    // Shared classifier: keeps the buyer's "Item Number" out of partNumber and
    // prefers "Item Description" over "Service Parent Name". See
    // table-columns.js for why this used to invert on Mahindra POs.
    const cols = classifyColumns(header);
    const { part: partI, buyerCode: buyerI, desc: descI, qty: qtyI, price: priceI } = cols;
    // Only treat the table as a line-items table if at least two signal
    // columns match. Avoids picking up summary tables with rows like
    // "Subtotal | 12,500".
    if (columnMatchCount(cols) < 2) continue;
    for (const r of rows.slice(1)) {
      const rawDesc = descI >= 0 ? (r[descI] || null) : null;
      const li = {
        partNumber: partI >= 0 ? (r[partI] || null) : null,
        customerItemCode: buyerI >= 0 ? (r[buyerI] || null) : null,
        description: rawDesc,
        raw_description: rawDesc,
        quantity: qtyI >= 0 ? Number(String(r[qtyI] || "0").replace(/[^\d.\-]/g, "")) || null : null,
        unitPrice: priceI >= 0 ? Number(String(r[priceI] || "0").replace(/[^\d.\-]/g, "")) || null : null,
      };
      if (li.partNumber || li.description || li.customerItemCode) lines.push(li);
    }
  }
  return {
    customer: null,
    lines,
    raw_table_count: tables.length,
    raw_md_chars: md.length,
  };
};

export const extract = async ({ url, bytes, filename, settings }) => {
  const ep = endpoint(settings);
  if (!ep) return { ok: false, error: "Docling endpoint not configured" };
  const key = apiKey(settings);

  let r;
  if (url) {
    r = await callDoclingByUrl({ ep, key, fileUrl: url });
  } else if (bytes) {
    r = await callDoclingByFile({ ep, key, bytes, filename });
  } else {
    return { ok: false, error: "Docling adapter requires url or bytes" };
  }
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: r.body?.detail || r.body?.error || JSON.stringify(r.body || {}).slice(0, 400),
      raw: r.body,
    };
  }
  const normalized = normalizeFromDocling(r.body);
  // Docling's table structure recognition is a deterministic CV
  // model, not an LLM. Confidence is high when tables match the
  // line-item shape; fall to 0.4 when nothing extracted.
  const confidences = {};
  normalized.lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.85; });
  confidences["overall"] = normalized.lines.length > 0 ? 0.85 : 0.4;
  return {
    ok: true,
    raw: r.body,
    normalized,
    confidences,
  };
};

// Exported for tests.
export const __test__ = { extractTables, parseMarkdownTable, normalizeFromDocling };
