// Marker adapter (https://github.com/datalab-to/marker).
//
// Marker is the open-source PDF -> Markdown converter that ships
// with Surya OCR + a layout transformer. Self-host via the
// FastAPI container or use the Datalab hosted API. Both speak the
// same JSON shape; we toggle by which credentials are configured.
//
// Why we want it: Marker's strength is preserving table structure
// while doing OCR on image-only PDFs. The Phase B OCR fallback
// (planned for the next PR) will use Mistral; Marker is the
// open-source alternative for tenants that want to keep all
// extraction self-hosted. It also gives the Phase C voter a third
// data point that's structurally different from Claude/Reducto.
//
// API contracts we support:
//
//   1) Self-hosted FastAPI server (community variants):
//      POST {endpoint}/marker            multipart  files=<bytes>
//      Returns: { markdown, metadata, images? } per page.
//
//   2) Datalab hosted API:
//      POST {endpoint}/api/v1/marker     JSON       { url } or multipart
//      Auth: X-Api-Key.
//      Returns: 202 with poll URL; we poll until terminal.
//
// `marker_mode` setting picks the contract: "self_hosted" |
// "datalab". Default = "self_hosted" because that's the zero-cost
// path. Datalab usage is opt-in.

import { decryptField } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";

const apiKey = (settings) => {
  if (settings?.docai_marker_api_key_enc && settings?.docai_creds_iv) {
    try { return decryptField(settings.docai_marker_api_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* */ }
  }
  return process.env.MARKER_API_KEY || null;
};

const endpoint = (settings) =>
  settings?.docai_marker_endpoint
    || process.env.MARKER_ENDPOINT
    || null;

const mode = (settings) =>
  settings?.docai_marker_mode || process.env.MARKER_MODE || "self_hosted";

// Self-hosted needs only an endpoint. Datalab needs both endpoint
// (defaults to https://www.datalab.to) and an API key.
export const isConfigured = (settings) => {
  const m = mode(settings);
  if (m === "datalab") {
    // Datalab API: needs key. Endpoint defaults inside extract().
    return !!apiKey(settings);
  }
  return !!endpoint(settings);
};

const callSelfHosted = async ({ ep, bytes, filename }) => {
  const url = ep.replace(/\/+$/, "") + "/marker";
  const form = new FormData();
  form.append("files", new Blob([bytes]), filename || "document.pdf");
  // Marker self-hosted server returns { result: [{ markdown, metadata }, ...] }
  // per page when the multi-file shape is used. Single-file calls
  // return { markdown, metadata } directly.
  const resp = await safeFetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
    timeoutMs: 180_000,        // OCR-heavy path: scanned 20-page POs run ~60-120s on CPU
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

const callDatalab = async ({ ep, key, bytes, filename, fileUrl }) => {
  const base = (ep || "https://www.datalab.to").replace(/\/+$/, "");
  const url = base + "/api/v1/marker";
  let resp;
  if (fileUrl) {
    resp = await safeFetch(url, {
      method: "POST",
      headers: {
        "X-Api-Key": key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url: fileUrl, output_format: "markdown" }),
      timeoutMs: 30_000,
    });
  } else {
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename || "document.pdf");
    form.append("output_format", "markdown");
    resp = await safeFetch(url, {
      method: "POST",
      headers: { "X-Api-Key": key, Accept: "application/json" },
      body: form,
      timeoutMs: 30_000,
    });
  }
  const submitText = await resp.text();
  let submit = null;
  try { submit = JSON.parse(submitText); } catch (_e) { submit = { raw: submitText.slice(0, 400) }; }
  if (!resp.ok || !submit?.request_check_url) {
    return { ok: false, status: resp.status, body: submit };
  }
  // Poll. Datalab cap: 5 minutes. We give up at 3 minutes to keep
  // serverless invocations bounded.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await safeFetch(submit.request_check_url, {
      headers: { "X-Api-Key": key },
      timeoutMs: 15_000,
    });
    const body = await poll.json().catch(() => ({}));
    if (body.status === "complete") return { ok: true, status: 200, body };
    if (body.status === "error" || body.status === "failed") {
      return { ok: false, status: 200, body };
    }
  }
  return { ok: false, status: 0, body: { error: "datalab marker poll timeout" } };
};

const parseMarkdownTable = (block) => {
  const lines = String(block || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (lines.length < 2) return [];
  const data = lines.filter((l) => !/^\|\s*-+\s*(\|\s*-+\s*)+\|$/.test(l));
  return data.map((row) =>
    row.replace(/^\||\|$/g, "").split(/\s*\|\s*/).map((c) => c.replace(/\\\|/g, "|").trim())
  );
};

const extractTables = (md) => {
  if (!md) return [];
  const tables = [];
  const lines = md.split(/\r?\n/);
  let block = [];
  for (const line of lines) {
    if (line.trim().startsWith("|")) block.push(line);
    else if (block.length) { tables.push(block.join("\n")); block = []; }
  }
  if (block.length) tables.push(block.join("\n"));
  return tables.map(parseMarkdownTable).filter((rows) => rows.length >= 2);
};

const colIdx = (header, re) => header.findIndex((h) => re.test(String(h || "").toLowerCase()));

const collectMarkdown = (body) => {
  // Self-hosted: { markdown, ...} or { result: [{ markdown }, ...] }
  // Datalab: { markdown } once status === "complete"
  if (typeof body?.markdown === "string") return body.markdown;
  if (Array.isArray(body?.result)) {
    return body.result.map((p) => p?.markdown || "").filter(Boolean).join("\n\n");
  }
  if (Array.isArray(body?.pages)) {
    return body.pages.map((p) => p?.markdown || p?.text || "").filter(Boolean).join("\n\n");
  }
  return "";
};

const normalizeFromMarker = (body) => {
  const md = collectMarkdown(body);
  const tables = extractTables(md);
  const lines = [];
  for (const rows of tables) {
    if (rows.length < 2) continue;
    const header = rows[0];
    const partI = colIdx(header, /(part|sku|item|catalog|p\/n)/);
    const qtyI = colIdx(header, /(qty|quantity|count|pcs)/);
    const priceI = colIdx(header, /(unit ?price|rate|price)/);
    const descI = colIdx(header, /(desc|name|product)/);
    const matches = [partI, qtyI, priceI, descI].filter((i) => i >= 0).length;
    if (matches < 2) continue;
    for (const r of rows.slice(1)) {
      const li = {
        partNumber: partI >= 0 ? (r[partI] || null) : null,
        description: descI >= 0 ? (r[descI] || null) : null,
        quantity: qtyI >= 0 ? Number(String(r[qtyI] || "0").replace(/[^\d.\-]/g, "")) || null : null,
        unitPrice: priceI >= 0 ? Number(String(r[priceI] || "0").replace(/[^\d.\-]/g, "")) || null : null,
      };
      if (li.partNumber || li.description) lines.push(li);
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
  if (!isConfigured(settings)) return { ok: false, error: "Marker not configured" };
  const m = mode(settings);
  let r;
  if (m === "datalab") {
    const key = apiKey(settings);
    if (!key) return { ok: false, error: "Datalab Marker mode needs MARKER_API_KEY" };
    r = await callDatalab({ ep: endpoint(settings), key, bytes, filename, fileUrl: url });
  } else {
    const ep = endpoint(settings);
    if (!ep) return { ok: false, error: "Self-hosted Marker needs DOCAI_MARKER_ENDPOINT" };
    if (!bytes) return { ok: false, error: "Self-hosted Marker needs file bytes (no URL fetch in OSS server)" };
    r = await callSelfHosted({ ep, bytes, filename });
  }
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: r.body?.error || r.body?.detail || JSON.stringify(r.body || {}).slice(0, 400),
      raw: r.body,
    };
  }
  const normalized = normalizeFromMarker(r.body);
  const confidences = {};
  normalized.lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.8; });
  confidences["overall"] = normalized.lines.length > 0 ? 0.8 : 0.4;
  return {
    ok: true,
    raw: r.body,
    normalized,
    confidences,
    mode: m,
  };
};

export const __test__ = { extractTables, parseMarkdownTable, collectMarkdown, normalizeFromMarker };
