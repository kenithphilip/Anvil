// The sales-order register: one row per received PO, with what Anvil did
// with it. Pure helpers for /api/orders/register. No I/O.

import { SEVERITY_LEVELS } from "./terms/taxonomy.js";
import { needsDecision } from "./terms/compare.js";
import { OPEN_DECISIONS } from "./terms/decisions.js";
import { withStageColumns } from "./order-stage.js";
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
// read whole for the line count and value, as the slim orders list does. The
// stage columns (order-stage.js) are added for the row's stage.
export const REGISTER_SELECT = withStageColumns([
  "id", "status", "po_number", "po_date", "created_at", "customer_id",
  "customer:customer_id(customer_name)",
  "source:preflight_payload->>source",
  "chat_channel:preflight_payload->>channel",
  "extraction_run_id:preflight_payload->>extraction_run_id",
  "preflight_confidence:preflight_payload->>confidence_overall",
  "reorder_of:result->>source_reorder_of",
  "sales_order:result->salesOrder",
  "reconciliation:result->quoteReconciliation",
]);

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

// The terms check of one order, for the register's "Terms" column
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md 7.2, plan PR 13). Counts only, no
// wording.
//   status               not_checked, or the check's po_terms_status
//                        (read, partial, not_read)
//   open                 flags that need a decision and have none, by
//                        severity
//   undecided            the sum of open
//   amendment_requested  flags whose current decision asks for an amendment
//                        (still open)
//   decided              flags accepted, rejected or called not a deviation
// check: the current order_term_checks row or null. flags: its flags.
// history: flag id -> decisions, newest first.
export const termsSummaryOf = ({ check = null, flags = [], history = new Map(), policy, shadow = false }) => {
  const open = Object.fromEntries(SEVERITY_LEVELS.map((s) => [s, 0]));
  const out = { status: check ? check.po_terms_status || "read" : "not_checked", shadow, open, undecided: 0, amendment_requested: 0, decided: 0 };
  for (const f of flags) {
    const current = (history.get(f.id) || [])[0] || null;
    if (current) {
      if (OPEN_DECISIONS.has(current.decision)) out.amendment_requested += 1;
      else out.decided += 1;
    } else if (needsDecision(policy, f.severity)) {
      open[f.severity] += 1;
      out.undecided += 1;
    }
  }
  return out;
};

// The Terms column as words, for the export.
export const termsText = (t) => {
  if (!t) return "";
  if (t.status === "not_checked") return "not checked";
  const parts = [];
  if (t.status === "not_read") parts.push("PO terms not read");
  const open = [...SEVERITY_LEVELS].reverse().filter((s) => t.open[s]).map((s) => t.open[s] + " " + s);
  if (open.length) parts.push(open.join(", ") + " undecided");
  if (t.amendment_requested) parts.push(t.amendment_requested + " amendment requested");
  if (t.decided) parts.push(t.decided + " decided");
  if (!parts.length) parts.push("nothing to decide");
  return parts.join("; ") + (t.shadow ? " (shadow)" : "");
};

// One register row. erp: { attached, voucher_no } or null. terms: the
// summary above, or null when the terms check is off or hidden from this
// caller (the column then says nothing, never "no flags"). stage: the
// order's orderStage() (order-stage.js).
export const registerRow = (row, { run = null, erp = null, terms = null, stage = null } = {}) => {
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
    stage,
    erp_so: erp ? { attached: true, voucher_no: erp.voucher_no || null } : { attached: false, voucher_no: null },
    terms,
    // Placeholder until the order-processing handoff ships. Nothing sends a
    // handoff today, so every order truthfully reads "not sent".
    handoff: { status: "not_sent" },
  };
};

// The register as a worksheet: a header row, then one row per order.
export const REGISTER_COLUMNS = [
  "Received", "Channel", "Customer", "PO number", "PO date", "Currency", "Value", "Lines",
  "Extraction", "Confidence", "Matched", "Line flags", "Terms flags", "Status", "ERP SO", "Handoff", "Terms check",
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
    termsText(r.terms),
  ]),
];
