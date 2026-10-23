// Link a sent message to an open action, and decide what it proves.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.6. Pure: no network, no database.
//
// A link is structural, never subject text or similar wording:
//   header_reply        the sent In-Reply-To or References names the action's
//                       Internet Message-ID.
//   conversation_index  Outlook: the sent conversationIndex starts with the
//                       action's and is longer by whole 5-byte steps (a reply
//                       in that branch). 5 bytes is a direct reply.
//   conversation_only   the same conversation and nothing more: always
//                       ambiguous, never verified.
//
// Then the action's requirement decides:
//   reply_to_sender        the original sender is in To or Cc.
//   reply_with_attachment  the same, and the sent message has an attachment.
//   forward_to_target      every forward_to address is a recipient. With no
//                          target set, a forward is always ambiguous.
//   manual                 mail never completes it. The mail is kept as
//                          evidence and the state does not change.
//
// Result: { status: verified | ambiguous | rejected, confidence, reasons,
//           state: "performed" | "awaiting_verification" | null }.

const fact = (code, text) => ({ kind: "fact", code, text });
const inferred = (code, text) => ({ kind: "inferred", code, text });

const bytes = (s) => {
  if (!s) return null;
  const b = Buffer.from(String(s), "base64");
  return b.length ? b : null;
};

// The number of 5-byte reply steps from parent to child, or 0.
export const replySteps = (childIdx, parentIdx) => {
  const c = bytes(childIdx);
  const p = bytes(parentIdx);
  if (!c || !p || p.length < 22 || c.length <= p.length || (c.length - p.length) % 5) return 0;
  return c.subarray(0, p.length).equals(p) ? (c.length - p.length) / 5 : 0;
};

export const linkOf = (sent, a) => {
  const id = a.internet_message_id;
  if (id && (sent.inReplyTo === id || (sent.references || []).includes(id))) return { method: "header_reply", steps: 1 };
  if (sent.provider === "outlook" && a.conversation_index) {
    const steps = replySteps(sent.conversationIndex, a.conversation_index);
    if (steps) return { method: "conversation_index", steps };
  }
  if (sent.conversationId && a.conversation_id && sent.conversationId === a.conversation_id) return { method: "conversation_only", steps: 0 };
  return null;
};

export const judge = (sent, a, { sendingConnectionId }) => {
  const link = linkOf(sent, a);
  if (!link) return null;
  const out = (status, confidence, state, ...reasons) => ({ method: link.method, status, confidence, state, reasons });

  if (link.method === "conversation_only") {
    return out("ambiguous", "low", a.requirement === "manual" ? null : "awaiting_verification",
      fact("same_conversation", "The sent message is in the same conversation."),
      inferred("no_structural_link", "Its headers do not name the action's message, so it may answer another message."));
  }
  const how = link.method === "header_reply"
    ? fact("header_reply", "The sent message's In-Reply-To or References names the action's message.")
    : fact("conversation_index", link.steps === 1
      ? "Outlook marks the sent message as a direct reply to the action's message."
      : "Outlook marks the sent message as a later reply in the action's thread.");
  const confidence = link.steps === 1 ? "high" : "medium";

  if (a.received_at && sent.sentAt && Date.parse(sent.sentAt) < Date.parse(a.received_at) - 60_000) {
    return out("rejected", confidence, null, how, fact("sent_before", "It was sent before the action's message arrived."));
  }
  if (!(a.seen_connection_ids || []).includes(sendingConnectionId)) {
    return out("ambiguous", confidence, a.requirement === "manual" ? null : "awaiting_verification", how,
      fact("other_mailbox", "It was sent from a mailbox that did not receive the action's message."));
  }
  const recipients = new Set([...(sent.to || []), ...(sent.cc || [])].map((x) => String(x).toLowerCase()));
  const toSender = !!a.from_address && recipients.has(String(a.from_address).toLowerCase());

  if (a.requirement === "manual") {
    return out("ambiguous", confidence, null, how,
      inferred("needs_person", "This action type needs a person to confirm it; the mail is kept as evidence."));
  }
  if (a.requirement === "forward_to_target") {
    const targets = (a.forward_to || []).map((x) => String(x).toLowerCase());
    if (!targets.length) {
      return out("ambiguous", confidence, "awaiting_verification", how, inferred("no_target", "No forward target is set, so a person confirms the forward."));
    }
    const missing = targets.filter((x) => !recipients.has(x));
    return missing.length
      ? out("ambiguous", confidence, "awaiting_verification", how, fact("target_missing", "The forward did not go to " + missing.join(", ") + "."))
      : out("verified", confidence, "performed", how, fact("target_reached", "The forward went to every target."));
  }
  if (!toSender) {
    return out("ambiguous", confidence, "awaiting_verification", how, fact("not_to_sender", "The message did not go to the original sender."));
  }
  if (a.requirement === "reply_with_attachment" && !sent.hasAttachments) {
    return out("ambiguous", confidence, "awaiting_verification", how, fact("no_attachment", "The reply has no attachment, and documents were asked for."));
  }
  return out("verified", confidence, "performed", how, fact("to_sender", "The reply went to the original sender."));
};
