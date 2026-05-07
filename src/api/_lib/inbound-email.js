// Inbound email helpers.
//
// Shared logic for both adapters (Postmark webhook + Microsoft Graph
// subscription callback): MIME normalisation, thread-state, dedup,
// priority scoring.
//
// Two-step lifecycle:
//   1. ingest()  : adapter writes a row in `inbound_emails` with
//                  status=received. Dedup hash computed up front so
//                  duplicates are flagged instantly.
//   2. parse()   : a separate cron picks `received` rows, runs the
//                  document AI extraction (Phase 3.3), links to a
//                  customer + draft order, flips to status=linked.

import crypto from "node:crypto";

const TIER_WEIGHTS = {
  strategic: 100,
  preferred: 60,
  standard: 20,
  watchlist: 5,
};

// Hash for dedup. The doc says "subject + first 200 chars of body
// + from-domain". We sha256 those normalised inputs.
export const computeDupHash = ({ from_address, subject, body_text }) => {
  const fromDomain = String(from_address || "").split("@").pop().toLowerCase();
  const subj = String(subject || "").trim().toLowerCase().replace(/^(re:|fwd?:)\s*/i, "");
  const body = String(body_text || "").slice(0, 200).replace(/\s+/g, " ").trim().toLowerCase();
  return crypto.createHash("sha256")
    .update(fromDomain + "\n" + subj + "\n" + body)
    .digest("hex");
};

// Walk the In-Reply-To / References chain to find the canonical
// thread root. If neither is set, the message itself is the root.
export const computeThreadKey = ({ message_id, in_reply_to, references_chain }) => {
  if (Array.isArray(references_chain) && references_chain.length) {
    return references_chain[0];
  }
  if (in_reply_to) return in_reply_to;
  return message_id || crypto.randomUUID();
};

// Normalise a received message into the canonical `inbound_emails`
// row shape, ready for upsert. Adapter-specific bits should already
// be turned into the shared shape by the adapter.
export const buildInboundEmailRow = ({
  tenantId, provider, message_id, in_reply_to, references_chain,
  from_address, from_name, to_addresses, cc_addresses, subject,
  body_text, body_html, raw_mime, attachments,
}) => {
  const threadKey = computeThreadKey({ message_id, in_reply_to, references_chain });
  const dupHash = computeDupHash({ from_address, subject, body_text });
  return {
    tenant_id: tenantId,
    provider,
    message_id: message_id || null,
    in_reply_to: in_reply_to || null,
    references_chain: references_chain || null,
    from_address: from_address || null,
    from_name: from_name || null,
    to_addresses: to_addresses || null,
    cc_addresses: cc_addresses || null,
    subject: subject || null,
    body_text: body_text || null,
    body_html: body_html || null,
    raw_mime: raw_mime || null,
    attachments: attachments || [],
    dup_hash: dupHash,
    status: "received",
    _thread_key: threadKey,
  };
};

// Given a candidate row (with a separate _thread_key), look up or
// create the thread, then write the row. Dedup short-circuit if a
// row from the last 7 days has the same dup_hash.
export const ingestInboundEmail = async (svc, row) => {
  const { _thread_key: threadKey, ...persisted } = row;

  // Idempotency: if we have a message_id and it's already on file,
  // skip silently with the existing row's id.
  if (persisted.message_id) {
    const existing = await svc.from("inbound_emails")
      .select("id, status")
      .eq("tenant_id", persisted.tenant_id)
      .eq("message_id", persisted.message_id)
      .maybeSingle();
    if (existing.data) return { id: existing.data.id, idempotent: true };
  }

  // Dedup: any row with same dup_hash in the last 7 days?
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const dup = await svc.from("inbound_emails")
    .select("id, thread_id")
    .eq("tenant_id", persisted.tenant_id)
    .eq("dup_hash", persisted.dup_hash)
    .gte("received_at", sevenDaysAgo)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dup.data) {
    // Mark this one duplicate, attach to same thread.
    persisted.status = "duplicate";
    persisted.thread_id = dup.data.thread_id;
    const ins = await svc.from("inbound_emails").insert(persisted).select("id").single();
    return { id: ins.data?.id || null, duplicate: true, of: dup.data.id };
  }

  // Resolve or create the thread.
  let threadId = null;
  const t = await svc.from("inbound_email_threads")
    .select("id, message_count")
    .eq("tenant_id", persisted.tenant_id)
    .eq("thread_key", threadKey)
    .maybeSingle();
  if (t.data) {
    threadId = t.data.id;
    await svc.from("inbound_email_threads").update({
      last_received_at: new Date().toISOString(),
      message_count: (t.data.message_count || 0) + 1,
    }).eq("id", threadId);
  } else {
    const ins = await svc.from("inbound_email_threads").insert({
      tenant_id: persisted.tenant_id,
      thread_key: threadKey,
      subject: persisted.subject,
      message_count: 1,
    }).select("id").single();
    threadId = ins.data?.id || null;
  }
  persisted.thread_id = threadId;
  const ins = await svc.from("inbound_emails").insert(persisted).select("id").single();
  return { id: ins.data?.id || null, thread_id: threadId };
};

// Match an inbound email to a (customer, contact) pair.
//
// Audit P4.2 (May 2026). The previous matcher returned the first
// customers row whose contact_email matched, or whose domain
// matched. A 12-person account at one customer always resolved
// to whichever row sat first, losing the actual sender's
// identity. Threads landed under the wrong person and AR
// escalations emailed the wrong human.
//
// New shape (migration 065 added customer_contacts):
//
//   1. Exact email match on customer_contacts. Lowercase compare
//      (the unique index is on lower(email)).
//   2. If no contact row matches, exact email match on the legacy
//      customers.contact_email field. Backfill in 065 should make
//      step 1 hit for all preexisting accounts; step 2 is a
//      grace period until any unbackfilled tenant runs the
//      migration.
//   3. If still nothing, domain match on customer_contacts.email.
//      We pick the is_primary contact when the domain has multiple
//      hits, otherwise the most recently updated.
//   4. Last resort: domain match on customers.contact_email.
//
// Returns { matched, customer, contact } where contact may be
// null even when matched (a domain-match hit with no specific
// contact row).
export const matchInboundToCustomer = async (svc, email) => {
  if (!email.from_address) return { matched: false };
  const fromAddr = String(email.from_address).toLowerCase();
  const fromDomain = fromAddr.split("@").pop();

  const fetchCustomerById = async (id) => {
    const r = await svc.from("customers")
      .select("id, customer_name, tier, contact_email, gstin")
      .eq("tenant_id", email.tenant_id)
      .eq("id", id)
      .maybeSingle();
    return r.data || null;
  };

  // Step 1: contacts table by exact email.
  const c1 = await svc.from("customer_contacts")
    .select("id, customer_id, name, email, role, is_primary")
    .eq("tenant_id", email.tenant_id)
    .ilike("email", fromAddr)
    .limit(1)
    .maybeSingle();
  if (c1.data) {
    const customer = await fetchCustomerById(c1.data.customer_id);
    if (customer) {
      return { matched: true, customer, contact: c1.data };
    }
  }

  // Step 2: legacy customers.contact_email exact match.
  const r2 = await svc.from("customers")
    .select("id, customer_name, tier, contact_email, gstin")
    .eq("tenant_id", email.tenant_id)
    .ilike("contact_email", fromAddr)
    .limit(1)
    .maybeSingle();
  if (r2.data) {
    return { matched: true, customer: r2.data, contact: null };
  }

  if (fromDomain) {
    // Step 3: contacts table by domain. Prefer is_primary, then
    // most-recently-updated, so the dunning agent threads to the
    // operator's chosen lead contact when a domain has many.
    const c3 = await svc.from("customer_contacts")
      .select("id, customer_id, name, email, role, is_primary, updated_at")
      .eq("tenant_id", email.tenant_id)
      .ilike("email", "%@" + fromDomain)
      .order("is_primary", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (c3.data) {
      const customer = await fetchCustomerById(c3.data.customer_id);
      if (customer) {
        return { matched: true, customer, contact: c3.data };
      }
    }

    // Step 4: legacy domain match on customers.contact_email.
    const r4 = await svc.from("customers")
      .select("id, customer_name, tier, contact_email, gstin")
      .eq("tenant_id", email.tenant_id)
      .ilike("contact_email", "%@" + fromDomain)
      .limit(1)
      .maybeSingle();
    if (r4.data) {
      return { matched: true, customer: r4.data, contact: null };
    }
  }

  return { matched: false };
};

export const computePriorityScore = ({ tier, has_attachments, subject, body_text }) => {
  let score = TIER_WEIGHTS[tier || "standard"] ?? 20;
  // RFP / RFQ / urgent in subject bumps score.
  const s = String(subject || "").toLowerCase();
  if (/\b(rfq|rfp|urgent|asap|tender|quote)\b/.test(s)) score += 25;
  if (has_attachments) score += 15;
  // Long bodies tend to be real RFQs vs. one-liners.
  if (String(body_text || "").length > 500) score += 5;
  return score;
};
