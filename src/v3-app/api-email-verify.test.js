// EA-5: the verifier rules, pure. Request tests [5] Outlook reply, [6] Gmail
// reply, [7] forwards, [8] ambiguous matches stay for a person.
import { describe, it, expect } from "vitest";
import { judge, linkOf, replySteps } from "../api/_lib/email-accountability/verify.js";

const ROOT = Buffer.alloc(22, 7);
const idx = (...steps) => Buffer.concat([ROOT, ...steps.map((n) => Buffer.alloc(5, n))]).toString("base64");

const action = (extra = {}) => ({
  id: "ea-1", internet_message_id: "<in-1@mail.example>", conversation_id: "conv-1",
  conversation_index: idx(), from_address: "buyer@customer.example",
  received_at: "2026-10-22T06:00:00Z", requirement: "reply_to_sender", forward_to: [],
  seen_connection_ids: ["m1"], ...extra,
});
const sent = (extra = {}) => ({
  provider: "outlook", providerId: "s1", internetMessageId: "<out-1@seller.example>", direction: "out",
  conversationId: "conv-1", conversationIndex: null, inReplyTo: null, references: [],
  from: "rep@seller.example", to: ["buyer@customer.example"], cc: [], subject: "Re: order",
  hasAttachments: false, sentAt: "2026-10-22T07:00:00Z", ...extra,
});
const at = { sendingConnectionId: "m1" };

describe("[5] Outlook reply", () => {
  it("In-Reply-To from the MAPI property: verified, high", () => {
    expect(judge(sent({ inReplyTo: "<in-1@mail.example>" }), action(), at))
      .toMatchObject({ method: "header_reply", status: "verified", confidence: "high", state: "performed" });
  });

  it("no headers, but conversationIndex marks a direct reply: verified, high", () => {
    expect(judge(sent({ conversationIndex: idx(1) }), action(), at))
      .toMatchObject({ method: "conversation_index", status: "verified", confidence: "high" });
  });

  it("a later reply in the branch is structural but medium", () => {
    expect(judge(sent({ conversationIndex: idx(1, 2) }), action(), at))
      .toMatchObject({ method: "conversation_index", status: "verified", confidence: "medium" });
  });

  it("an index from another branch, or a broken one, is no structural link", () => {
    expect(replySteps(Buffer.concat([Buffer.alloc(22, 8), Buffer.alloc(5, 1)]).toString("base64"), idx())).toBe(0);
    expect(replySteps(idx(1).slice(0, 10), idx())).toBe(0);
    expect(replySteps(idx(), idx())).toBe(0);
  });
});

describe("[6] Gmail reply", () => {
  it("In-Reply-To or References in the header: verified", () => {
    const a = action({ conversation_index: null, conversation_id: "thread-1" });
    expect(judge(sent({ provider: "gmail", conversationId: "thread-1", inReplyTo: "<in-1@mail.example>" }), a, at).status).toBe("verified");
    expect(judge(sent({ provider: "gmail", conversationId: "thread-1", references: ["<root@x>", "<in-1@mail.example>"] }), a, at).status).toBe("verified");
  });

  it("Gmail never uses conversationIndex", () => {
    expect(linkOf(sent({ provider: "gmail", conversationIndex: idx(1), conversationId: "other" }), action())).toBeNull();
  });
});

describe("[7] forwards", () => {
  const fw = (to) => sent({ subject: "Fw: order", to, references: ["<in-1@mail.example>"] });
  it("verified only when every target is a recipient", () => {
    const a = action({ requirement: "forward_to_target", forward_to: ["finance@seller.example"] });
    expect(judge(fw(["finance@seller.example"]), a, at)).toMatchObject({ status: "verified", state: "performed" });
    expect(judge(fw(["someone@seller.example"]), a, at)).toMatchObject({ status: "ambiguous", state: "awaiting_verification" });
  });

  it("a forward with no target set is always ambiguous", () => {
    const a = action({ requirement: "forward_to_target", forward_to: [] });
    expect(judge(fw(["finance@seller.example"]), a, at)).toMatchObject({ status: "ambiguous" });
  });

  it("a forward does not satisfy a reply", () => {
    expect(judge(fw(["finance@seller.example"]), action(), at)).toMatchObject({ status: "ambiguous" });
  });
});

describe("[8] ambiguous matches stay for a person", () => {
  it("the same conversation alone is ambiguous and low, never verified", () => {
    expect(judge(sent(), action(), at)).toMatchObject({ method: "conversation_only", status: "ambiguous", confidence: "low", state: "awaiting_verification" });
  });

  it("the subject alone never links", () => {
    expect(judge(sent({ conversationId: "conv-other", subject: "Re: order" }), action(), at)).toBeNull();
  });

  it("not to the original sender, no attachment for documents, another mailbox: ambiguous", () => {
    const linked = { inReplyTo: "<in-1@mail.example>" };
    expect(judge(sent({ ...linked, to: ["colleague@customer.example"] }), action(), at).reasons.map((r) => r.code)).toContain("not_to_sender");
    expect(judge(sent(linked), action({ requirement: "reply_with_attachment" }), at)).toMatchObject({ status: "ambiguous" });
    expect(judge(sent({ ...linked, hasAttachments: true }), action({ requirement: "reply_with_attachment" }), at)).toMatchObject({ status: "verified" });
    expect(judge(sent(linked), action(), { sendingConnectionId: "m9" })).toMatchObject({ status: "ambiguous" });
  });

  it("a message sent before the action's message is rejected", () => {
    expect(judge(sent({ inReplyTo: "<in-1@mail.example>", sentAt: "2026-10-21T00:00:00Z" }), action(), at))
      .toMatchObject({ status: "rejected", state: null });
  });

  it("mail never completes an action that needs a person, and does not move its state", () => {
    const j = judge(sent({ inReplyTo: "<in-1@mail.example>" }), action({ requirement: "manual" }), at);
    expect(j).toMatchObject({ status: "ambiguous", state: null });
    expect(judge(sent(), action({ requirement: "manual" }), at).state).toBeNull();
  });

  it("the original sender in Cc counts, in any letter case", () => {
    expect(judge(sent({ inReplyTo: "<in-1@mail.example>", to: ["x@customer.example"], cc: ["Buyer@Customer.example"] }), action(), at).status).toBe("verified");
  });
});
