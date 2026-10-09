// The sales-order register: one row per received PO, with what Anvil did
// with it. Pure helpers for /api/orders/register. No I/O.
//
// In Mode B Anvil is the repository of every sales order received and
// analysed, while the ERP holds the voucher. The orders list shows an order's
// stage; the register shows its record: how it arrived, what extraction read,
// what reconciliation found, and whether the ERP's own sales order is on file.

// How an order arrived. Derived, because no order column records it: each
// intake path stamps preflight_payload.source (email/inbound.js,
// inbound/email/draft_orders.js, inbound/process_messages.js,
// whatsapp/inbound.js, voice/process_actions.js, quotes/convert.js). An order
// created from the intake screen carries no source, and a portal reorder
// carries result.source_reorder_of.
export const CHANNELS = Object.freeze(["upload", "email", "whatsapp", "chat", "voice", "quote", "portal"]);

const SOURCE = "preflight_payload->>source";
const CHAT_CHANNEL = "preflight_payload->>channel";
const REORDER_OF = "result->>source_reorder_of";

const EMAIL_SOURCES = ["email_inbound", "inbound_email"];

export const channelOf = ({ source, chat_channel: chatChannel, reorder_of: reorderOf } = {}) => {
  if (reorderOf) return "portal";
  if (!source) return "upload";
  if (EMAIL_SOURCES.includes(source)) return "email";
  if (source === "whatsapp_inbound") return "whatsapp";
  if (source === "inbound_chat") return chatChannel === "whatsapp" ? "whatsapp" : "chat";
  if (source === "voice_call_action") return "voice";
  if (source === "quote_convert") return "quote";
  return "other";
};

// The same rule as channelOf, as a PostgREST filter, so the channel filter
// runs in the database and pagination counts stay true. Unknown channel:
// the caller rejects it before this is reached.
export const applyChannelFilter = (q, channel) => {
  switch (channel) {
    case "email":    return q.in(SOURCE, EMAIL_SOURCES);
    case "whatsapp": return q.or(`${SOURCE}.eq.whatsapp_inbound,and(${SOURCE}.eq.inbound_chat,${CHAT_CHANNEL}.eq.whatsapp)`);
    case "chat":     return q.eq(SOURCE, "inbound_chat").or(`${CHAT_CHANNEL}.is.null,${CHAT_CHANNEL}.neq.whatsapp`);
    case "voice":    return q.eq(SOURCE, "voice_call_action");
    case "quote":    return q.eq(SOURCE, "quote_convert");
    case "portal":   return q.not(REORDER_OF, "is", null);
    case "upload":   return q.is(SOURCE, null).is(REORDER_OF, null);
    default:         return q;
  }
};

// Every column the register needs, and no more. JSON paths keep the raw PO
// text in preflight_payload out of the response. The sales order itself is
// read whole for the line count and value, as the slim orders list does.
export const REGISTER_SELECT = [
  "id", "status", "po_number", "po_date", "created_at", "customer_id",
  "customer:customer_id(customer_name)",
  "source:preflight_payload->>source",
  "chat_channel:preflight_payload->>channel",
  "extraction_run_id:preflight_payload->>extraction_run_id",
  "preflight_confidence:preflight_payload->>confidence_overall",
  "reorder_of:result->>source_reorder_of",
  "sales_order:result->salesOrder",
  "reconciliation:result->quoteReconciliation",
].join(", ");

// The "has flags" filter: a reconciliation that recorded at least one flag.
// ->> renders the flags array as text, so an empty array is "[]" and an order
// never reconciled is NULL; neq excludes both.
export const FLAGS_TEXT = "result->quoteReconciliation->>flags";

// Header-level flags the reconciler raises on the terms (payment terms and
// incoterm, orders/reconcile_quotes.js). Every other flag is about a line.
export const isTermsFlag = (f) => {
  const v = String((f && f.verdict) || "");
  return v.startsWith("payment_terms") || v.startsWith("incoterms");
};

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const reconciliationOf = (rec) => {
  if (!rec || typeof rec !== "object") return { analysed: false };
  const flags = Array.isArray(rec.flags) ? rec.flags : [];
  const termsFlags = flags.filter(isTermsFlag).length;
  return {
    analysed: true,
    as_of: rec.as_of || null,
    matched: num(rec.summary?.matched),
    total: num(rec.summary?.total),
    line_flags: flags.length - termsFlags,
    terms_flags: termsFlags,
  };
};

// What extraction did. The intake screen stamps the run id on the order; the
// run carries the status and the confidence. An order with no run either had
// lines from somewhere else (a converted quote, a portal reorder) or none.
export const extractionOf = (row, run, lineCount) => {
  if (run) {
    return {
      status: run.status || null,
      confidence: num(run.confidence_overall) ?? num(row.preflight_confidence),
      run_id: run.id,
    };
  }
  return {
    status: lineCount > 0 ? "no_run" : "not_extracted",
    confidence: num(row.preflight_confidence),
    run_id: row.extraction_run_id || null,
  };
};

// One register row. erp: { attached, voucher_no } or null.
export const registerRow = (row, { run = null, erp = null } = {}) => {
  const so = (row.sales_order && typeof row.sales_order === "object") ? row.sales_order : {};
  const lines = Array.isArray(so.lineItems) ? so.lineItems.length : 0;
  return {
    id: row.id,
    received_at: row.created_at,
    channel: channelOf(row),
    customer_id: row.customer_id || null,
    customer_name: row.customer?.customer_name || so.customer?.name || null,
    po_number: row.po_number || null,
    po_date: row.po_date || null,
    value: num(so.grandTotal),
    currency: so.currency || so.customer?.currency || null,
    line_count: lines,
    extraction: extractionOf(row, run, lines),
    reconciliation: reconciliationOf(row.reconciliation),
    status: row.status,
    erp_so: erp ? { attached: true, voucher_no: erp.voucher_no || null } : { attached: false, voucher_no: null },
    // Placeholder until the order-processing handoff ships. Nothing sends a
    // handoff today, so every order truthfully reads "not sent".
    handoff: { status: "not_sent" },
  };
};

// The register as a worksheet: a header row, then one row per order.
export const REGISTER_COLUMNS = [
  "Received", "Channel", "Customer", "PO number", "PO date", "Currency", "Value", "Lines",
  "Extraction", "Confidence", "Matched", "Line flags", "Terms flags", "Status", "ERP SO", "Handoff",
];

export const registerAoa = (rows) => [
  REGISTER_COLUMNS,
  ...rows.map((r) => [
    r.received_at || "",
    r.channel,
    r.customer_name || "",
    r.po_number || "",
    r.po_date || "",
    r.currency || "",
    r.value,
    r.line_count,
    r.extraction.status || "",
    r.extraction.confidence,
    r.reconciliation.analysed ? (r.reconciliation.matched ?? "") + "/" + (r.reconciliation.total ?? "") : "not analysed",
    r.reconciliation.analysed ? r.reconciliation.line_flags : "",
    r.reconciliation.analysed ? r.reconciliation.terms_flags : "",
    r.status,
    r.erp_so.attached ? (r.erp_so.voucher_no || "attached") : "",
    r.handoff.status === "not_sent" ? "not sent" : r.handoff.status,
  ]),
];
