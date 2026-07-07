// LlamaParse / LlamaExtract adapter (LlamaCloud, https://cloud.llamaindex.ai).
//
// OPT-IN, OFF BY DEFAULT (issue #210). Like every adapter in the chain it
// is skipped unless isConfigured() is true (a per-tenant LlamaCloud key,
// encrypted with the shared docai_creds_iv, or the LLAMA_CLOUD_API_KEY env)
// AND an admin has added "llamaparse" to docai_provider_order. So a tenant
// that hasn't explicitly enabled + keyed it never routes a document here.
//
// DATA RESIDENCY: LlamaCloud regions are US / EU only — no India region.
// Enabling it sends customer PO/quote content (GSTINs, prices, part IP) to
// a US/EU SaaS; the Admin UI gates the toggle behind an acknowledgement.
//
// Flow (LlamaParse async API): upload the file -> poll the job -> fetch the
// markdown result -> map tables onto the canonical line-item shape. The
// request/response shapes below follow LlamaParse's documented API; because
// this ships gated (no live key in CI), VERIFY against the live API when a
// tenant first activates it. A wrong detail fails soft (returns
// { ok:false }) and the chain falls through to the next adapter.

import { decryptField } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";

const BASE_URL = "https://api.cloud.llamaindex.ai/api/v1";

// tier -> LlamaParse parse_mode. Costs (per page, $1.25/1k credits):
// fast 1cr, cost_effective 3cr, agentic 10cr, agentic_plus 45cr.
const TIER_MODE = {
  fast: "parse_page_without_llm",
  cost_effective: "parse_page_with_llm",
  agentic: "parse_page_with_agent",
  agentic_plus: "parse_page_with_lvm",
};

export const apiKey = (settings) => {
  if (settings?.docai_llamacloud_api_key_enc && settings?.docai_creds_iv) {
    try { return decryptField(settings.docai_llamacloud_api_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* fall through to env */ }
  }
  return process.env.LLAMA_CLOUD_API_KEY || null;
};

export const isConfigured = (settings) => !!apiKey(settings);

const tierMode = (settings) => TIER_MODE[settings?.docai_llamaparse_tier] || TIER_MODE.cost_effective;

// ── canonical mapping: markdown table -> line items ─────────────────
// LlamaParse returns layout-aware markdown; PO/quote tables come back as
// GitHub-style pipe tables. Pull the first table that looks like line items.
export const parseMarkdownTable = (md) => {
  const lines = String(md || "").split(/\r?\n/);
  const rows = [];
  for (const l of lines) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const extract = async ({ url, bytes, filename, settings }) => {
  const key = apiKey(settings);
  if (!key) return { ok: false, error: "LlamaCloud API key not configured" };
  try {
    // 1. Upload (bytes preferred; fetch the url to bytes if only a url given).
    let fileBytes = bytes;
    if (!fileBytes && url) {
      const dl = await safeFetch(url);
      if (!dl.ok) return { ok: false, status: dl.status, error: "could not fetch document url" };
      fileBytes = Buffer.from(await dl.arrayBuffer());
    }
    if (!fileBytes) return { ok: false, error: "LlamaParse adapter requires url or bytes" };

    const form = new FormData();
    form.append("file", new Blob([fileBytes]), filename || "document.pdf");
    form.append("parse_mode", tierMode(settings));
    const up = await safeFetch(BASE_URL + "/parsing/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      body: form,
    });
    if (!up.ok) return { ok: false, status: up.status, error: "upload failed: " + (await up.text()).slice(0, 300) };
    const job = await up.json();
    const jobId = job?.id;
    if (!jobId) return { ok: false, error: "upload returned no job id" };

    // 2. Poll (bounded — the caller already runs adapters with a timeout).
    let status = "PENDING";
    for (let i = 0; i < 30 && status !== "SUCCESS"; i++) {
      await sleep(2000);
      const jr = await safeFetch(BASE_URL + "/parsing/job/" + encodeURIComponent(jobId), {
        headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      });
      if (!jr.ok) return { ok: false, status: jr.status, error: "job poll failed" };
      status = (await jr.json())?.status || status;
      if (status === "ERROR" || status === "CANCELLED") return { ok: false, error: "job " + status };
    }
    if (status !== "SUCCESS") return { ok: false, error: "job timed out" };

    // 3. Fetch the markdown result + map to line items.
    const rr = await safeFetch(BASE_URL + "/parsing/job/" + encodeURIComponent(jobId) + "/result/markdown", {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    });
    if (!rr.ok) return { ok: false, status: rr.status, error: "result fetch failed" };
    const body = await rr.json();
    const md = body?.markdown || body?.text || "";
    const normalized = normalizeFromMarkdown(md);

    const confidences = {};
    normalized.lines.forEach((_li, i) => { confidences["lines[" + i + "]"] = 0.8; });
    confidences["overall"] = normalized.lines.length > 0 ? 0.8 : 0.4;
    return { ok: true, raw: { job_id: jobId, chars: md.length }, normalized, confidences };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
};

// Exported for tests (pure mapping, no network).
export const __test__ = { parseMarkdownTable, normalizeFromMarkdown, tierMode, TIER_MODE };
