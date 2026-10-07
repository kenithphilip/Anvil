// Keyword intent classifier for inbound chat (WhatsApp, Slack, Teams).
//
// ONE classifier for both chat entry points:
//   - inbound/process_messages.js drains inbound_messages, which the
//     Slack, Teams and newer WhatsApp webhooks write.
//   - whatsapp/inbound.js is the legacy token-gated WhatsApp webhook.
// Each used to carry its own copy of the same keyword list, with no
// complaint bucket. A complaint was filed as `other` and marked resolved
// with no record, and a complaint that mentioned "price" or "PO" became a
// DRAFT order. Email gets an LLM classifier (_lib/email-classifier.js);
// chat still runs on keywords.
//
// Buckets, checked in this order (first match wins):
//
//   complaint       -> operator event, never an order
//   po_revision     -> DRAFT order
//   quote_request   -> DRAFT order
//   status_request  -> operator event
//   purchase_order  -> DRAFT order
//   other
//
// The complaint bucket runs FIRST because a complaint often names a price
// or a PO ("the gun you supplied is defective, send price for
// replacement"), and every order bucket below would claim it.
//
// The complaint keyword list is deliberately conservative. A false
// positive takes a real order out of the order path, so a keyword only
// goes in when it almost never appears in an order or a quote request.
// Every keyword is matched on word boundaries, so "PO issued" never
// matches "issue with". Current list:
//
//   complaint, complaints, complain, complained
//   defect, defects, defective
//   not working
//   broken
//   leak, leaks, leaking, leakage
//   failure, failures
//   damaged
//   wrong part, wrong parts
//   under warranty, warranty claim, warranty claims
//   issue with, issues with
//
// Narrowed or left out on purpose, because each one is ordinary order
// language:
//   - bare "warranty": "12 months warranty" sits in PO and quote terms.
//     Only "under warranty" and "warranty claim" count.
//   - "replace", "replacement", "replaced": "please replace PO 4501 with
//     the attached" is a PO revision, and "replacement tips" is a spares
//     order. A real replacement complaint nearly always carries another
//     keyword (defective, broken, damaged), and that keyword catches it.
//   - bare "damage": "transit damage cover" can sit in quote terms. Only
//     "damaged" counts.
//
// The order buckets keep their original patterns unchanged.

const COMPLAINT_RE = new RegExp(
  "\\b(?:" + [
    "complaints?", "complain(?:ed)?",
    "defects?", "defective",
    "not\\s+working",
    "broken",
    "leak(?:s|ing|age)?",
    "failures?",
    "damaged",
    "wrong\\s+parts?",
    "under\\s+warranty", "warranty\\s+claims?",
    "issues?\\s+with",
  ].join("|") + ")\\b",
);

export const ORDER_INTENTS = ["purchase_order", "quote_request", "po_revision"];

export const classifyChatIntent = (text) => {
  const t = String(text || "").toLowerCase();
  if (COMPLAINT_RE.test(t)) return "complaint";
  if (/(revis|amend|update.*po\b|po.*update)/.test(t)) return "po_revision";
  if (/(quote|quotation|rfq|pricing|price|cost)/.test(t)) return "quote_request";
  if (/(status|delivery|eta|tracking|where\s+is)/.test(t)) return "status_request";
  if (/(po|purchase\s*order|p\.o\.|buy)/.test(t)) return "purchase_order";
  return "other";
};

// A chat message has no subject line, so the opening of the text stands in
// for one on the complaint event (the email event carries the subject).
export const chatSubject = (text) => {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, 200) : null;
};
