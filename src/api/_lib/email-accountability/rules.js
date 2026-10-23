// Deterministic classification of one inbound message. No LLM, no network.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.2.
//
// classify(message, ctx) returns what to do and why. Facts (what the message
// or the CRM says) and inferences (what the rules conclude) are separate
// reason kinds, so a person can see which part is a judgement.
//
// The phrase pack is the default; tenant and user rules (email_rules) add
// keywords, trusted senders, exclusions, customer floors and due times.

import { addBusinessMinutes, closeOfBusiness, localYmd, BUSINESS_DAY_MINUTES } from "./business-time.js";
import { parsePoDate } from "../parse-date.js";

export const PRIORITY_RANK = { critical: 1, high: 2, normal: 3, informational: 4 };
const BY_RANK = ["", "critical", "high", "normal", "informational"];

export const REQUIREMENT_BY_TYPE = {
  reply: "reply_to_sender",
  forward: "forward_to_target",
  provide_documents: "reply_with_attachment",
  confirm_payment: "manual",
  obtain_approval: "manual",
  investigate: "manual",
};
export const ACTION_TYPES = Object.keys(REQUIREMENT_BY_TYPE);
export const ACTION_LABEL = {
  reply: "Reply", forward: "Forward", provide_documents: "Send documents",
  confirm_payment: "Confirm payment", obtain_approval: "Get approval", investigate: "Investigate",
};

const CONSEQUENCE = {
  financial: "The payment can be late or disputed.",
  contractual: "The order may not be confirmed in time.",
  operational: "Work on the order can stop.",
  service: "The customer waits past the time they asked for.",
  relationship: "The customer relationship is at risk.",
};

export const DEFAULT_PHRASES = [
  { code: "payment_overdue", action: "confirm_payment", priority: "high", risk: "financial",
    re: /\b(payment (is )?(overdue|outstanding|pending|due)|outstanding (amount|payment|dues|balance)|overdue (invoice|payment|amount)|remittance)\b/i },
  { code: "order_confirmation", action: "reply", priority: "high", risk: "contractual",
    re: /\b(order confirmation|confirm (the |our |your )?(order|po|purchase order)|(po|order) acknowledg(e)?ment|acknowledge (the |our )?(order|po))\b/i },
  { code: "approval_required", action: "obtain_approval", priority: "high", risk: "operational",
    re: /\b(approval (is )?required|please approve|awaiting (your )?approval|need(s)? (your )?approval|for your approval)\b/i },
  { code: "document_pending", action: "provide_documents", priority: "high", risk: "operational",
    re: /\b(documents? (is |are )?pending|pending documents?|send (the |us |me )?(certificates?|invoice copy|documents?|drawings?|test reports?|coc|mtc)|share (the )?(certificates?|documents?|drawings?|test reports?))\b/i },
  { code: "shipment_delay", action: "investigate", priority: "high", risk: "operational",
    re: /\b((shipment|delivery|dispatch) (is |has been )?delay(ed)?|delayed (shipment|delivery|dispatch)|not (yet )?received|short (shipment|supply|delivery))\b/i },
  { code: "deadline", action: "reply", priority: "high", risk: "service", criticalWithKnown: true,
    re: /\b(deadline|by end of (the )?day|by eod|urgent(ly)?|asap|immediately)\b/i },
  { code: "escalation", action: "investigate", priority: "critical", risk: "relationship",
    re: /\b(escalat(e|ed|ion|ing)|legal notice|penalty|liquidated damages|cancel (the |this |our )?(order|po)|blacklist(ed)?)\b/i },
];

const REQUEST_RE = /\b(please|kindly|request(ing)?|can you|could you|need|required|share|send|confirm|update us|let us know|revert)\b|\?/i;
const AUTO_SUBJECT_RE = /^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification|mail delivery (failed|failure)|read:)/i;
const NO_REPLY_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce)[^@]*@/i;
const BULK_PRECEDENCE_RE = /^(bulk|list|junk)$/i;

const fact = (code, text) => ({ kind: "fact", code, text });
const inferred = (code, text) => ({ kind: "inferred", code, text });

const domainOf = (a) => String(a || "").split("@")[1] || "";

// "@seller.example" matches the domain and its subdomains; anything else is
// one exact address.
export const senderMatches = (pattern, address) => {
  const p = String(pattern || "").trim().toLowerCase();
  const a = String(address || "").toLowerCase();
  if (!p || !a) return false;
  if (p.startsWith("@")) {
    const d = domainOf(a);
    return d === p.slice(1) || d.endsWith("." + p.slice(1));
  }
  return a === p;
};

export const exclusionOf = (m, { tenantDomains = new Set(), rules = [] } = {}) => {
  const text = (m.subject || "") + " " + (m.preview || "");
  const trusted = rules.some((r) => r.kind === "trusted_sender" && senderMatches(r.pattern, m.from));
  for (const r of rules) {
    if (r.kind !== "exclusion") continue;
    const hit = String(r.pattern).includes("@")
      ? senderMatches(r.pattern, m.from)
      : text.toLowerCase().includes(String(r.pattern).toLowerCase());
    if (hit) return fact("excluded_by_rule", "An exclusion rule matches.");
  }
  if (m.listUnsubscribe || BULK_PRECEDENCE_RE.test(String(m.precedence || "").trim())) return fact("bulk", "The message is a list or bulk mail.");
  if ((m.autoSubmitted && !/^no$/i.test(String(m.autoSubmitted).trim())) || AUTO_SUBJECT_RE.test(m.subject || "")) {
    return fact("auto_reply", "The message is an automatic reply or a delivery report.");
  }
  if (!trusted && NO_REPLY_RE.test(m.from || "")) return fact("no_reply", "The sender is a no-reply address.");
  if (!trusted && tenantDomains.has(domainOf(m.from))) return fact("internal", "The sender is inside the company.");
  return null;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const LEAD = "(?:by|before|on or before|latest by|no later than|due (?:on|by)?)\\s+";
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\\.?";

// The first deadline the text states, as { at, text }, or null.
export const statedDeadline = (text, now, tz) => {
  const s = String(text || "");
  let m = s.match(new RegExp("\\b" + LEAD + "(today|tonight|eod|end of (?:the )?day|tomorrow)\\b", "i"));
  if (m) {
    const ymd = localYmd(m[1].toLowerCase() === "tomorrow" ? new Date(now.getTime() + 86_400_000) : now, tz);
    return { at: closeOfBusiness(ymd, tz), text: m[0] };
  }
  m = s.match(/\bwithin\s+(\d{1,2})\s+(?:business |working )?days?\b/i);
  if (m) return { at: addBusinessMinutes(now, Number(m[1]) * BUSINESS_DAY_MINUTES, tz), text: m[0] };
  m = s.match(/\bwithin\s+(\d{1,2})\s+hours?\b/i);
  if (m) return { at: new Date(now.getTime() + Number(m[1]) * 3_600_000), text: m[0] };

  const year = Number(localYmd(now, tz).slice(0, 4));
  const ymdFor = (d, mo, y) => {
    let yy = y ? Number(y) : year;
    if (yy < 100) yy += 2000;
    let ymd = yy + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    // No year given, and the date is well past: it means next year.
    if (!y && ymd < localYmd(new Date(now.getTime() - 30 * 86_400_000), tz)) ymd = (yy + 1) + ymd.slice(4);
    const dt = new Date(ymd + "T00:00:00Z");
    return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === ymd ? ymd : null;
  };
  m = s.match(new RegExp("\\b" + LEAD + "(\\d{1,2})(?:st|nd|rd|th)?\\s+" + MON + "(?:,?\\s+(\\d{4}))?", "i"));
  if (m) {
    const ymd = ymdFor(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3]);
    if (ymd) return { at: closeOfBusiness(ymd, tz), text: m[0] };
  }
  m = s.match(new RegExp("\\b" + LEAD + MON + "\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?", "i"));
  if (m) {
    const ymd = ymdFor(Number(m[2]), MONTHS[m[1].toLowerCase()], m[3]);
    if (ymd) return { at: closeOfBusiness(ymd, tz), text: m[0] };
  }
  m = s.match(new RegExp("\\b" + LEAD + "(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2,4})\\b", "i"));
  if (m) {
    const ymd = parsePoDate(m[1] + "/" + m[2] + "/" + m[3], { hint: "DMY" });
    if (ymd) return { at: closeOfBusiness(ymd, tz), text: m[0] };
  }
  return null;
};

// Policy minutes for a priority when no deadline is stated. EA-6 makes these
// a tenant setting; a deadline rule overrides them per action type today.
export const DEFAULT_DUE_MINUTES = { critical: 240, high: BUSINESS_DAY_MINUTES, normal: 2 * BUSINESS_DAY_MINUTES };

const dueFor = (type, priority, stated, ctx) => {
  if (stated) return { at: stated.at, source: "customer_commit", basis: { stated: stated.text } };
  const rule = (ctx.rules || []).find((r) => r.kind === "deadline" && (r.pattern === type || r.pattern === "*")
    && Number(r.effect?.due_hours) > 0);
  const minutes = rule ? Number(rule.effect.due_hours) * 60 : (ctx.dueMinutes || DEFAULT_DUE_MINUTES)[priority];
  return {
    at: addBusinessMinutes(ctx.now, minutes, ctx.timezone),
    source: "sla",
    basis: { priority, business_minutes: minutes, rule: rule ? rule.id || "deadline_rule" : null },
  };
};

const lower = (a, b) => (PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b);
const raise = (p) => BY_RANK[Math.max(1, PRIORITY_RANK[p] - 1)];

// ctx: { now, timezone, tenantDomains, rules, link: { reliable, customer_id,
//        contact_id, reasons }, order: { order_id, reasons } | null,
//        openTypesInThread: Set, dueMinutes }
export const classify = (m, ctx) => {
  const excluded = exclusionOf(m, ctx);
  if (excluded) return { relevant: false, excluded, reasons: [excluded], actions: [] };

  const text = (m.subject || "") + "\n" + (m.preview || "");
  const rules = ctx.rules || [];
  const link = ctx.link || { reliable: false, reasons: [] };
  const trusted = rules.some((r) => r.kind === "trusted_sender" && senderMatches(r.pattern, m.from));
  const known = !!link.reliable || trusted;
  const reasons = [...(link.reasons || []), ...(ctx.order?.reasons || [])];
  if (trusted) reasons.push(fact("trusted_sender", "A trusted-sender rule matches the sender."));

  const hits = DEFAULT_PHRASES.filter((p) => p.re.test(text))
    .map((p) => ({ ...p, matched: (text.match(p.re) || [""])[0] }));
  for (const r of rules) {
    if (r.kind !== "keyword" || !text.toLowerCase().includes(String(r.pattern).toLowerCase())) continue;
    const action = ACTION_TYPES.includes(r.effect?.action_type) ? r.effect.action_type : "reply";
    const priority = PRIORITY_RANK[r.effect?.priority] ? r.effect.priority : "high";
    hits.push({ code: "rule_keyword", action, priority, risk: "service", matched: r.pattern });
  }
  for (const h of hits) reasons.push(fact("phrase:" + h.code, 'The text says "' + h.matched + '".'));

  const request = REQUEST_RE.test(text);
  if (!hits.length) {
    if (!(known && request)) return { relevant: false, excluded: null, reasons, actions: [] };
    hits.push({ code: "request", action: "reply", priority: "normal", risk: "service" });
    reasons.push(inferred("request", "A known contact asks for something."));
  }

  let priority = hits.reduce((p, h) => lower(p, h.criticalWithKnown && known ? "critical" : h.priority), "informational");
  const floor = rules.find((r) => r.kind === "customer" && link.customer_id && r.pattern === link.customer_id
    && PRIORITY_RANK[r.effect?.priority]);
  if (floor && PRIORITY_RANK[floor.effect.priority] < PRIORITY_RANK[priority]) {
    priority = floor.effect.priority;
    reasons.push(inferred("customer_rule", "A customer rule sets this customer to at least " + priority + "."));
  }
  const stated = statedDeadline(text, ctx.now, ctx.timezone);
  if (stated) {
    reasons.push(fact("stated_deadline", 'Stated deadline: "' + stated.text + '".'));
    // Soon: by the close of the next business day.
    const soon = closeOfBusiness(localYmd(addBusinessMinutes(ctx.now, BUSINESS_DAY_MINUTES, ctx.timezone), ctx.timezone), ctx.timezone);
    if (priority === "normal" && stated.at <= soon) {
      priority = raise(priority);
      reasons.push(inferred("deadline_soon", "The stated deadline is by the end of the next business day."));
    }
  }

  // A critical or high message from a sender the CRM cannot place goes to a
  // person for review, not to an owner's queue.
  const review = !known && (priority === "critical" || priority === "high");
  const relevant = priority === "critical" || priority === "high" || (priority === "normal" && known && request);
  if (!relevant) return { relevant: false, excluded: null, reasons, actions: [] };
  reasons.push(inferred("priority", "Priority " + priority + (review ? "; the sender is not a known contact, so a person reviews it first" : "") + "."));

  const types = [...new Set(hits.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]).map((h) => h.action))];
  const open = ctx.openTypesInThread || new Set();
  const followUpTypes = types.filter((t) => open.has(t));
  const actions = types.filter((t) => !open.has(t)).slice(0, 3).map((type) => {
    const risk = hits.find((h) => h.action === type)?.risk || "service";
    return {
      type,
      requirement: REQUIREMENT_BY_TYPE[type],
      title: (ACTION_LABEL[type] + ": " + (m.subject || "(no subject)")).slice(0, 200),
      consequence: CONSEQUENCE[risk],
      due: dueFor(type, priority, stated, ctx),
    };
  });
  return { relevant: true, excluded: null, review, priority, reasons, actions, followUpTypes };
};
