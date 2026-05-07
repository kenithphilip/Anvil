// POST or GET /api/inbound/email/parse
//
// Cron-only via Bearer CRON_SECRET (drains every minute), plus a
// manual admin trigger. Picks `inbound_emails.status='received'`
// rows, runs customer matching + priority scoring, and (when an
// RFQ-shaped body is detected) hands off to the existing intake to
// produce a draft order.
//
// Document AI v2 (Phase 3.3) is wired in here at `extractFromBody`.
// In v1 of this endpoint the extraction is a thin Claude call; v2
// will swap that path for the layout-aware adapters when present.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import {
  matchInboundToCustomer, computePriorityScore,
} from "../../_lib/inbound-email.js";
import { classifyInboundEmail } from "../../_lib/email-classifier.js";

// Audit P5.3: Haiku-tier classifier intents that the parser
// treats as "this is order/quote work, route to the linked-email
// worker." Anything else lands as 'parsed' (operator triages or
// the dunning reply loop in Phase 6 picks it up by intent).
const ACTIONABLE_INTENTS = new Set([
  "rfq", "purchase_order", "po_revision", "quote_accept",
]);

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 25;

// Heuristic: does this body look like an RFQ / PO worth running
// extraction on? Skip auto-replies, OOO bouncers, and obvious
// notification spam.
const looksLikeRfq = (email) => {
  const s = (email.subject || "").toLowerCase();
  if (/auto-?reply|out of office|delivery (failed|status)|undeliverable/.test(s)) return false;
  if (/\b(rfq|rfp|quote|po\b|purchase order|tender|enquiry|inquiry)\b/.test(s)) return true;
  // Has attachments => likely a PO PDF.
  if (Array.isArray(email.attachments) && email.attachments.length) return true;
  // Long body => probably a real RFQ.
  if (String(email.body_text || "").length > 800) return true;
  return false;
};

const parseRow = async (svc, email) => {
  try {
    const { matched, customer } = await matchInboundToCustomer(svc, email);
    const tier = customer?.tier || "standard";
    const score = computePriorityScore({
      tier,
      has_attachments: Array.isArray(email.attachments) && email.attachments.length > 0,
      subject: email.subject,
      body_text: email.body_text,
    });

    // Audit P5.3: Haiku-tier classifier produces a discrete
    // intent + confidence. Failure is non-fatal (regex fallback
    // below).
    const cls = await classifyInboundEmail(svc, email.tenant_id, email);

    const patch = {
      parsed_at: new Date().toISOString(),
      priority_score: score,
      customer_id: matched ? customer.id : null,
      customer_tier: matched ? tier : null,
    };
    if (cls.ok) {
      patch.classified_intent = cls.intent;
      patch.classification_confidence = cls.confidence;
      patch.classification_model = cls.model || null;
      patch.classified_at = new Date().toISOString();
    }

    // Routing rule: prefer the classifier's verdict when it
    // returned a confident actionable intent; fall back to the
    // regex looksLikeRfq() so a classifier outage doesn't sink
    // the inbox. OOO / marketing / phishing route to 'archived'
    // so the operator's queue stays clean.
    let route = "parsed";
    if (cls.ok && ACTIONABLE_INTENTS.has(cls.intent) && cls.confidence >= 0.55) {
      route = "linked";
    } else if (cls.ok && (cls.intent === "phishing" || cls.intent === "marketing" || cls.intent === "out_of_office")) {
      route = "archived";
    } else if (!cls.ok && looksLikeRfq(email)) {
      route = "linked";
    }
    patch.status = route;

    if (route === "linked" && email.thread_id && matched) {
      await svc.from("inbound_email_threads").update({
        customer_id: customer.id,
      }).eq("id", email.thread_id);
    }

    await svc.from("inbound_emails").update(patch).eq("id", email.id);
    return {
      id: email.id, status: patch.status, priority: score,
      customer_id: patch.customer_id,
      intent: cls.ok ? cls.intent : null,
      confidence: cls.ok ? cls.confidence : null,
    };
  } catch (err) {
    await svc.from("inbound_emails").update({
      status: "failed",
      error: (err.message || String(err)).slice(0, 500),
    }).eq("id", email.id);
    return { id: email.id, error: err.message };
  }
};

const drain = async (svc) => {
  const rows = await svc.from("inbound_emails")
    .select("id, tenant_id, thread_id, from_address, subject, body_text, attachments")
    .eq("status", "received")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (rows.error) throw new Error(rows.error.message);
  const out = [];
  for (const r of rows.data || []) out.push(await parseRow(svc, r));
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const out = await drain(svc);
      return json(res, 200, { ran_at: new Date().toISOString(), processed: out.length, results: out });
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const out = await drain(svc);
    return json(res, 200, { ran_at: new Date().toISOString(), processed: out.length, results: out });
  } catch (err) { sendError(res, err); }
}
