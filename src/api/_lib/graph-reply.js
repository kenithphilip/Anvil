// The Graph reply-loop join — attribute an inbound reply to the outbound
// communication that prompted it. docs/CUSTOMER_COMMS_DESIGN.md §5 follow-up.
//
// Item 6 stamped every Graph-sent outbound `communications` row with
// thread_id = conversationId and provider_message_id = internetMessageId. When a
// reply arrives, Graph gives us the same conversationId and an In-Reply-To header
// pointing at that internetMessageId — so we can find the exact originating
// message and mark it replied. This is what turns "we stored the ids" into
// "a reply attributes back", and it is what the reply_rate / time_to_first_
// response metrics read (they count status='replied' and metadata.replied_at).
//
// Matching, MOST PRECISE first:
//   1. provider_message_id = In-Reply-To   (points at the EXACT message replied
//      to — the right answer when a conversation has several of our outbounds;
//      both sides kept in `<...>` form so they compare equal)
//   2. thread_id = conversationId   (thread-level fallback: Graph's own grouping
//      when In-Reply-To is absent or doesn't name one of our messages)

const findOutbound = async (svc, tenantId, column, value) => {
  if (!value) return null;
  const r = await svc.from("communications")
    .select("id, customer_id, order_id, status, sent_at, metadata")
    .eq("tenant_id", tenantId).eq("direction", "outbound").eq(column, value)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return r.data || null;
};

// Attribute one reply. Returns { matched, communication_id?, customer_id?, order_id? }.
// Idempotent: re-running on an already-replied row is a no-op flip.
export const attributeReply = async (svc, tenantId, { conversationId, inReplyTo, receivedAt, inboundEmailId } = {}) => {
  if (!svc || !tenantId) return { matched: false };

  // Precise signal first: the reply's In-Reply-To names the exact outbound.
  let match = await findOutbound(svc, tenantId, "provider_message_id", inReplyTo);
  let via = "in_reply_to";
  if (!match) { match = await findOutbound(svc, tenantId, "thread_id", conversationId); via = "conversation_id"; }
  if (!match) return { matched: false };

  // Mark the outbound replied + stamp the reply time (merge, never clobber other
  // metadata). Only flip if not already replied, so the FIRST reply wins the
  // time-to-first-response clock.
  if (match.status !== "replied") {
    await svc.from("communications").update({
      status: "replied",
      updated_at: new Date().toISOString(),
      metadata: {
        ...(match.metadata || {}),
        replied_at: receivedAt || new Date().toISOString(),
        reply_via: via,
        reply_inbound_id: inboundEmailId || null,
      },
    }).eq("tenant_id", tenantId).eq("id", match.id);
  }

  // Back-link the inbound email to the same customer + order, so the reply lands
  // on the right account/thread rather than staying unattributed.
  if (inboundEmailId && (match.customer_id || match.order_id)) {
    await svc.from("inbound_emails").update({
      customer_id: match.customer_id || null,
      linked_order_id: match.order_id || null,
      status: "linked",
    }).eq("tenant_id", tenantId).eq("id", inboundEmailId);
  }

  return { matched: true, via, communication_id: match.id, customer_id: match.customer_id, order_id: match.order_id };
};
