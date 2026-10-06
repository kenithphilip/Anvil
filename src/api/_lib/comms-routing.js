// Resolve document_type + customer -> { to, cc, bcc }.
//
// A customer is a company with FUNCTIONS. A dispatch register goes TO the
// stores team with purchase and accounts in CC; a payment reminder goes TO
// accounts. Same customer, different recipients, per document type.
//
// REDUNDANCY, NOT A GATE — the load-bearing design property. A customer with
// no routing configured still receives mail. Resolution degrades in order:
//
//   1. explicit rule    comms_routing_rules for (customer, document_type)
//   2. function only    contacts in a matching function, no rule -> all To
//   3. primary contact  customer_contacts.is_primary
//   4. operator         the caller's fallback address
//
// and records WHICH fallback fired, so coverage is measurable and improves
// over time instead of failing silently. Nothing blocks.
//
// resolveRecipients() is PURE — it takes already-fetched contacts and rules,
// so the To/CC behaviour is fully testable with no network and no database.
// loadRoutingInputs() does the I/O separately.

const norm = (e) => String(e || "").trim().toLowerCase();

// Dedupe while preserving order, and never let an address appear in more than
// one field: a contact who is both TO and CC should be TO only, or the
// customer sees themselves twice on the same mail.
const dedupeAcross = (to, cc, bcc) => {
  const seen = new Set();
  const take = (list) => {
    const out = [];
    for (const e of list) {
      const k = norm(e);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  };
  return { to: take(to), cc: take(cc), bcc: take(bcc) };
};

// Public: pure resolution.
//
//   documentType  'dispatch_register' | 'payment_reminder' | ...
//   contacts      [{ id, email, function_id, is_primary, is_active, marketing_consent }]
//   rules         [{ document_type, function_id, disposition, is_active }]
//   opts.fallbackEmail   operator address, used only as a last resort
//   opts.requireConsent  true for marketing — see §6 of the design doc
export const resolveRecipients = (documentType, contacts = [], rules = [], opts = {}) => {
  const active = (Array.isArray(contacts) ? contacts : []).filter((c) => c && c.is_active !== false && c.email);

  // Marketing is legally distinct: no recorded consent, no send. This must
  // NEVER apply to transactional mail, so it is opt-in per call.
  const eligible = opts.requireConsent
    ? active.filter((c) => c.marketing_consent === true)
    : active;

  const applicable = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.is_active !== false && r.document_type === documentType);

  const buckets = { to: [], cc: [], bcc: [] };
  let fallbackUsed = null;

  if (applicable.length) {
    // 1. Explicit rules.
    const byFunction = new Map();
    for (const c of eligible) {
      if (!c.function_id) continue;
      if (!byFunction.has(c.function_id)) byFunction.set(c.function_id, []);
      byFunction.get(c.function_id).push(c);
    }
    for (const rule of applicable) {
      const bucket = buckets[rule.disposition] || buckets.to;
      for (const c of byFunction.get(rule.function_id) || []) bucket.push(c.email);
    }
  }

  if (!buckets.to.length && !buckets.cc.length) {
    // 2. Any contact carrying a function — better than the primary, because it
    //    at least reaches someone whose job matches the document.
    const functioned = eligible.filter((c) => c.function_id);
    if (functioned.length) {
      buckets.to = functioned.map((c) => c.email);
      fallbackUsed = "function";
    }
  }

  if (!buckets.to.length) {
    // 3. The primary contact.
    const primary = eligible.find((c) => c.is_primary) || eligible[0];
    if (primary) {
      buckets.to = [primary.email];
      fallbackUsed = "primary";
    }
  }

  if (!buckets.to.length && opts.fallbackEmail) {
    // 4. The operator. Deliberately last: mail that reaches us rather than the
    //    customer is a failure we can see, which beats one we cannot.
    buckets.to = [opts.fallbackEmail];
    fallbackUsed = "operator";
  }

  const deduped = dedupeAcross(buckets.to, buckets.cc, buckets.bcc);
  return {
    ...deduped,
    fallback_used: fallbackUsed,
    // True when nobody at all could be resolved — the caller should surface
    // this rather than send into the void.
    unresolved: deduped.to.length === 0,
  };
};

// Public: fetch the inputs. Separated so resolveRecipients stays pure.
export const loadRoutingInputs = async (svc, tenantId, customerId) => {
  const out = { contacts: [], rules: [] };
  if (!svc || !tenantId || !customerId) return out;
  try {
    const c = await svc.from("customer_contacts")
      .select("id, email, function_id, is_primary, is_active, marketing_consent")
      .eq("tenant_id", tenantId).eq("customer_id", customerId);
    out.contacts = c.data || [];
  } catch (_e) { /* best-effort: an empty list falls through to the operator */ }
  try {
    const r = await svc.from("comms_routing_rules")
      .select("document_type, function_id, disposition, is_active")
      .eq("tenant_id", tenantId).eq("customer_id", customerId);
    out.rules = r.data || [];
  } catch (_e) { /* no rules is the normal starting state, not an error */ }
  return out;
};

// Public: the convenience path — load + resolve in one call.
export const resolveForCustomer = async (svc, tenantId, customerId, documentType, opts = {}) => {
  const { contacts, rules } = await loadRoutingInputs(svc, tenantId, customerId);
  return resolveRecipients(documentType, contacts, rules, opts);
};
