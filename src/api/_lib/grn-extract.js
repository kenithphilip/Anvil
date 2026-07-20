// GRN / SRN extraction — pull a customer's goods-receipt (GRN) or service-receipt
// (SRN/SES) number + date + quantities from an emailed/uploaded receipt document,
// so we know when the customer posted it (the payment clock) and can match it to
// our invoice. Reuses the DocAI substrate: callAnthropic (firewall + PII
// redaction) + parseSchemaAligned. See docs/DELIVERY_TO_CASH_DESIGN.md.
//
// This is I/O-lean: normalizeGrnOutput is pure (tool output -> receipt shape) and
// unit-tested; extractGrn does the one model call.

import { callAnthropic } from "./anthropic.js";
import { parseSchemaAligned } from "./docai/parse.js";

export const GRN_SYSTEM_PROMPT =
  "You extract a customer Goods Receipt Note (GRN, for goods) or Service Receipt / " +
  "Service Entry Sheet (SRN/SES, for services) that a buyer's stores team issued to " +
  "acknowledge receipt of a supplier's delivery. Return ONLY what the document " +
  "prints; never invent a number or a date. The receipt_date is the date the buyer " +
  "recorded receipt (it drives payment timing). po_number is the buyer's purchase " +
  "order; invoice_number is the supplier invoice the receipt acknowledges, if shown. " +
  "Set receipt_type=SRN when it acknowledges a service, else GRN. For each line give " +
  "received/short/rejected quantities when the document distinguishes them.";

export const GRN_TOOL = {
  name: "extract_goods_receipt",
  description: "Return the structured GRN/SRN extracted from the document.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      receipt_type: { type: "string", enum: ["GRN", "SRN"], description: "GRN for goods, SRN/SES for services" },
      receipt_number: { type: "string", description: "the GRN/SRN number printed on the document, or null" },
      receipt_date: { type: "string", description: "the receipt/posting date as printed (prefer ISO YYYY-MM-DD), or null" },
      po_number: { type: "string", description: "the buyer's purchase order number, or null" },
      invoice_number: { type: "string", description: "the supplier invoice number this acknowledges, or null" },
      supplier_name: { type: "string", description: "the supplier (us) as printed, or null" },
      confidence: { type: "number", description: "0..1 self-assessed confidence" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            part_no: { type: "string" },
            description: { type: "string" },
            ordered_qty: { type: "number" },
            received_qty: { type: "number" },
            short_qty: { type: "number" },
            rejected_qty: { type: "number" },
          },
        },
      },
    },
    required: ["receipt_type"],
  },
};

const clampConf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6;
};

const sumField = (items, k) => {
  if (!Array.isArray(items)) return null;
  let seen = false;
  let total = 0;
  for (const it of items) {
    const n = Number(it && it[k]);
    if (Number.isFinite(n)) { seen = true; total += n; }
  }
  return seen ? total : null;
};

// Normalise a printed date to YYYY-MM-DD (what the `date` column wants), else null.
export const toIsoDate = (s) => {
  if (s == null) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/yyyy or dd-mm-yyyy (Indian POs) — assume day-first.
  const d = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (d) {
    const dd = d[1].padStart(2, "0");
    const mm = d[2].padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) return `${d[3]}-${mm}-${dd}`;
  }
  return null;
};

// Pure: the extraction tool's output -> the customer_receipts row shape.
export const normalizeGrnOutput = (out) => {
  const o = out || {};
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    receipt_type: o.receipt_type === "SRN" ? "SRN" : "GRN",
    receipt_number: o.receipt_number || null,
    receipt_date: toIsoDate(o.receipt_date),
    po_number: o.po_number || null,
    invoice_number: o.invoice_number || null,
    supplier_name: o.supplier_name || null,
    posted_qty: sumField(items, "received_qty"),
    short_qty: sumField(items, "short_qty"),
    rejected_qty: sumField(items, "rejected_qty"),
    items,
    confidence: clampConf(o.confidence),
  };
};

const isPdf = (b) => !!b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

// Build the document content block: text-first (email body / OCR), PDF/image
// fallback. Mirrors the claude adapter's routing.
const contentBlock = ({ text, bytes, mime }) => {
  if (typeof text === "string" && text.trim()) {
    return { type: "text", text: "DOCUMENT:\n" + text.slice(0, 50_000) };
  }
  if (bytes && isPdf(bytes)) {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") } };
  }
  if (bytes && /^image\//i.test(String(mime || ""))) {
    return { type: "image", source: { type: "base64", media_type: String(mime), data: Buffer.from(bytes).toString("base64") } };
  }
  return null;
};

// extractGrn({ text?, bytes?, mime?, settings }) -> { ok, receipt, confidence, raw }
// | { ok:false, reason, error }. settings must carry tenant_id.
export const extractGrn = async ({ text, bytes, mime, settings } = {}) => {
  const tenantId = settings?.tenant_id;
  if (!tenantId) return { ok: false, reason: "no_tenant", error: "tenant_id missing on settings" };
  const block = contentBlock({ text, bytes, mime });
  if (!block) return { ok: false, reason: "no_source", error: "extractGrn needs text or PDF/image bytes" };

  const result = await callAnthropic({
    tenantId,
    purpose: "extraction",
    system: GRN_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [block, { type: "text", text: "Call extract_goods_receipt with the result." }] }],
    tools: [GRN_TOOL],
    tool_choice: { type: "tool", name: GRN_TOOL.name },
    max_tokens: 1500,
    temperature: 0,
  });
  if (!result.ok) {
    return { ok: false, reason: "upstream_error", error: result.error || "grn extraction failed", status: result.status };
  }

  const blocks = (result.data && result.data.content) || [];
  const tool = blocks.find((b) => b && b.type === "tool_use" && b.name === GRN_TOOL.name);
  let out = tool && tool.input ? tool.input : null;
  if (!out) {
    const t = blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n").trim();
    if (t) { const sap = await parseSchemaAligned(t); if (sap.ok && sap.value && typeof sap.value === "object") out = sap.value; }
  }
  if (!out) return { ok: false, reason: "parse_failed", error: "model did not return a GRN tool call", raw: result.data };

  const receipt = normalizeGrnOutput(out);
  return { ok: true, receipt, confidence: receipt.confidence, raw: result.data };
};
