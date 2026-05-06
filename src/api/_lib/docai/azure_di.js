// Azure Document Intelligence adapter. Two prebuilt models we use:
//   - prebuilt-document: general-purpose KV + tables (clean PDFs)
//   - prebuilt-invoice: invoice-shaped POs (better field detection)
// Layout-aware. Includes handwriting recognition for scanned faxes.

import { decryptField } from "../secrets.js";
import { safeFetch } from "../safe-fetch.js";

const apiKey = (settings) => {
  if (settings?.docai_azure_di_key_enc && settings?.docai_creds_iv) {
    try { return decryptField(settings.docai_azure_di_key_enc, settings.docai_creds_iv); }
    catch (_e) { /* */ }
  }
  return process.env.AZURE_DI_KEY || null;
};

const endpoint = (settings) =>
  settings?.docai_azure_di_endpoint || process.env.AZURE_DI_ENDPOINT || null;

export const isConfigured = (settings) => !!(apiKey(settings) && endpoint(settings));

const analyze = async ({ ep, key, modelId, fileUrl }) => {
  const url = ep.replace(/\/+$/, "")
    + `/formrecognizer/documentModels/${modelId}:analyze?api-version=2023-07-31`;
  const start = await safeFetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ urlSource: fileUrl }),
  });
  if (!start.ok) {
    const text = await start.text();
    return { ok: false, status: start.status, error: text.slice(0, 400) };
  }
  const opLoc = start.headers.get("operation-location");
  if (!opLoc) return { ok: false, status: 0, error: "no operation-location header" };
  // Poll until terminal. Cap at 90s.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await safeFetch(opLoc, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    });
    const body = await poll.json();
    if (body.status === "succeeded") return { ok: true, status: 200, body: body.analyzeResult };
    if (body.status === "failed") return { ok: false, status: 200, error: body?.error?.message || "failed" };
  }
  return { ok: false, status: 0, error: "azure di poll timeout" };
};

const normalizeFromAzure = (analyzeResult) => {
  const tables = analyzeResult?.tables || [];
  const docs = analyzeResult?.documents || [];
  const lines = [];
  const confidences = {};

  // First, try the invoice prebuilt path (Items field).
  const items = docs[0]?.fields?.Items?.valueArray || [];
  if (items.length) {
    for (let i = 0; i < items.length; i += 1) {
      const v = items[i]?.valueObject || {};
      const li = {
        description: v.Description?.valueString || v.Description?.content || null,
        quantity: (v.Quantity?.valueNumber ?? (Number(v.Quantity?.content || 0) || null)),
        unitPrice: (v.UnitPrice?.valueCurrency?.amount ?? (v.UnitPrice?.valueNumber ?? null)),
        partNumber: v.ProductCode?.valueString || null,
      };
      if (li.description || li.partNumber) lines.push(li);
      const baseConf = items[i]?.confidence ?? 0.7;
      confidences["lines[" + i + "]"] = baseConf;
    }
  } else if (tables.length) {
    // Fall back to table-driven extraction for prebuilt-document.
    for (const t of tables) {
      const cells = t.cells || [];
      const rowMap = new Map();
      for (const c of cells) {
        const r = c.rowIndex ?? 0;
        if (!rowMap.has(r)) rowMap.set(r, []);
        rowMap.get(r)[c.columnIndex || 0] = c.content || "";
      }
      const sortedRows = Array.from(rowMap.entries()).sort((a, b) => a[0] - b[0]).map(([_r, row]) => row);
      const header = sortedRows[0] || [];
      const colIdx = (re) => header.findIndex((h) => re.test(String(h || "").toLowerCase()));
      const partIdx = colIdx(/(part|sku|item|catalog)/);
      const qtyIdx  = colIdx(/(qty|quantity)/);
      const priceIdx = colIdx(/(price|rate)/);
      const descIdx  = colIdx(/(desc|name)/);
      sortedRows.slice(1).forEach((r, i) => {
        const li = {
          partNumber: partIdx >= 0 ? r[partIdx] : null,
          description: descIdx >= 0 ? r[descIdx] : null,
          quantity: qtyIdx >= 0 ? Number(String(r[qtyIdx] || "0").replace(/[^\d.]/g, "")) : null,
          unitPrice: priceIdx >= 0 ? Number(String(r[priceIdx] || "0").replace(/[^\d.]/g, "")) : null,
        };
        if (li.partNumber || li.description) {
          lines.push(li);
          confidences["lines[" + (lines.length - 1) + "]"] = 0.8;
        }
      });
    }
  }
  confidences["overall"] = lines.length ? 0.8 : 0.3;
  return { customer: null, lines, raw_table_count: tables.length };
};

export const extract = async ({ url, settings, hints }) => {
  const key = apiKey(settings);
  const ep = endpoint(settings);
  if (!key || !ep) return { ok: false, error: "Azure DI not configured" };
  if (!url) return { ok: false, error: "Azure DI adapter requires a document URL" };

  // Pick the model: explicit hint wins, then guess from filename.
  const model = hints?.azureModel
    || (/(po|purchase[-_]?order|invoice)/i.test(String(hints?.filename || "")) ? "prebuilt-invoice" : "prebuilt-document");

  const r = await analyze({ ep, key, modelId: model, fileUrl: url });
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const normalized = normalizeFromAzure(r.body);
  return {
    ok: true,
    raw: r.body,
    normalized,
    confidences: { ...{} },
    model_used: model,
  };
};
