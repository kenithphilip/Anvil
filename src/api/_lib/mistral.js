import { safeFetch } from "./safe-fetch.js";
// Mistral OCR client.
// Wraps https://docs.mistral.ai/capabilities/document/ for Vercel functions.
// Returns normalized pages with bounding boxes per text block.

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arrayBufferToBase64 = (buffer) => Buffer.from(buffer).toString("base64");

const normalizeBlock = (block) => {
  if (!block) return null;
  const bbox = block.bbox || block.bounding_box || block.box || null;
  const coords = Array.isArray(bbox)
    ? bbox.map((n) => Number(n) || 0)
    : (bbox && typeof bbox === "object")
      ? [Number(bbox.x0 || bbox.left || 0), Number(bbox.y0 || bbox.top || 0), Number(bbox.x1 || bbox.right || 0), Number(bbox.y1 || bbox.bottom || 0)]
      : null;
  return {
    text: block.text || block.markdown || block.content || "",
    bbox: coords,
    confidence: Number(block.confidence != null ? block.confidence : (block.score != null ? block.score : 1)),
    type: block.type || "text",
  };
};

const normalizePage = (page, index) => {
  const pageBlocks = page.blocks || page.elements || page.text_blocks || [];
  return {
    index: Number(page.index != null ? page.index : page.page_number || index),
    width: Number(page.width || (page.dimensions && page.dimensions.width) || 0),
    height: Number(page.height || (page.dimensions && page.dimensions.height) || 0),
    blocks: pageBlocks.map(normalizeBlock).filter(Boolean),
  };
};

// Bet 1: default model bumped to mistral-ocr-3 (released Dec 2025).
// Per https://mistral.ai/news/mistral-ocr-3 :
//   - $2 / 1k pages standard, $1 / 1k pages batch (50% off)
//   - 79.75 OmniDocBench, 88.9% handwriting, 96.6% tables
//   - 35+ languages incl. Hindi/Chinese/Arabic/Cyrillic
//
// `opts.batch === true` switches the call to the /v1/ocr/batch
// endpoint for the 50% discount on non-realtime traffic.
const DEFAULT_OCR_MODEL = "mistral-ocr-3";
const REALTIME_OCR_URL = "https://api.mistral.ai/v1/ocr";
const BATCH_OCR_URL    = "https://api.mistral.ai/v1/ocr/batch";

export const ocrDocument = async ({ buffer, filename, mimeType, opts }) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY env var is not set");
  const model = (opts && opts.model)
    || process.env.MISTRAL_OCR_MODEL
    || DEFAULT_OCR_MODEL;
  const useBatch = opts?.batch === true;
  const ocrUrl = useBatch ? BATCH_OCR_URL : REALTIME_OCR_URL;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  const document = {
    type: "document_base64",
    document_name: filename || "document",
    document_base64: arrayBufferToBase64(buffer),
  };
  const body = JSON.stringify({
    model,
    document,
    include_image_base64: false,
    bbox_format: "xyxy",
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resp;
    try {
      resp = await safeFetch(ocrUrl, { method: "POST", headers, body });
    } catch (networkErr) {
      lastErr = new Error("Mistral network error: " + networkErr.message);
      if (attempt < 3) { await sleep(Math.min(8000, 600 * Math.pow(2, attempt - 1))); continue; }
      throw lastErr;
    }
    if (RETRYABLE.has(resp.status) && attempt < 3) {
      const retry = Number(resp.headers.get("retry-after")) * 1000;
      await sleep(Number.isFinite(retry) && retry > 0 ? retry : Math.min(8000, 600 * Math.pow(2, attempt - 1)));
      continue;
    }
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { throw new Error("Mistral returned non-JSON (status " + resp.status + "): " + text.slice(0, 300)); }
    if (parsed && parsed.error) throw new Error("Mistral OCR error: " + (parsed.error.message || parsed.error));
    const pages = (parsed.pages || []).map((page, idx) => normalizePage(page, idx));
    return {
      pages,
      raw: parsed,
      model: parsed.model || model,
      mimeType: mimeType || null,
      batch: useBatch,
    };
  }
  throw lastErr || new Error("Mistral OCR failed after retries");
};
