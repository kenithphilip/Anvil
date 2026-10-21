// Reply-to for the handoff: the engineer who sent it. The owner changed
// C-D12 until C-33 exists: a clerk's reply to the tenant's inbound address
// would enter the Postmark pipeline as a new PO. The engineer stays in CC and
// the PO number is in the subject. The Graph branch of sendCommunication
// passes reply_to too (SO_TERMS_AND_HANDOFF_SCOPE.md 8.1): the real
// sendViaGraph runs here, and only the HTTP call is a stand-in.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ORDER, OPERATOR, freshState, asEngineer, settingsOf, handoffComms, callRoute } from "./test-support/handoff-harness.js";

const H = vi.hoisted(() => ({ s: null }));

vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.s.ctx) }));
vi.mock("../api/_lib/supabase.js", async () => {
  const { makeSvc } = await import("./test-support/handoff-harness.js");
  return { serviceClient: () => makeSvc(H.s), userClient: () => ({}) };
});
vi.mock("../api/_lib/mailer.js", async (orig) => {
  const { fakeSendEmail } = await import("./test-support/handoff-harness.js");
  return { ...(await orig()), sendEmail: (msg) => fakeSendEmail(H.s)(msg) };
});
vi.mock("../api/_lib/pdf-renderer.js", async (orig) => ({ ...(await orig()), renderSalesOrder: vi.fn(async () => Buffer.from("%PDF handoff")) }));
vi.mock("../api/_lib/graph-client.js", async (orig) => ({
  ...(await orig()),
  graphIsConnected: () => H.s.graphOn,
  graphAccessToken: async () => ({ accessToken: "tok", sender: "shared-box@example.com" }),
}));
vi.mock("../api/_lib/safe-fetch.js", async () => {
  const { fakeFetch } = await import("./test-support/handoff-harness.js");
  return { safeFetch: (url, init) => fakeFetch(H.s)(url, init) };
});

const { dispatch } = await import("../api/router.js");
const { buildGraphMessage } = await import("../api/_lib/graph-client.js");
const post = (body = { order_id: ORDER }) => callRoute(dispatch, "POST", { body });
const get = () => callRoute(dispatch, "GET", { query: { order_id: ORDER } });

beforeEach(() => {
  H.s = freshState();
  asEngineer(H.s);
});

describe("orders-handoff: reply-to", () => {
  it("replies go to the engineer who sent it, who is also in CC", async () => {
    expect((await get()).body.recipients.reply_to).toBe("eng@example.com");
    await post();
    const m = H.s.mail[0];
    expect(m.replyTo).toBe("eng@example.com");
    expect(m.cc).toContain("eng@example.com");
    expect(m.subject).toContain("PO PO-T-100");
    expect(m.body).toContain("Reply to this email to reach them.");
    expect(handoffComms(H.s)[0].reply_to).toBe("eng@example.com");
  });

  it("the reply-to is whoever sends it: an operator's send replies to the operator", async () => {
    H.s.ctx = { ...H.s.ctx, user: H.s.users[OPERATOR], role: "operator" };
    await post();
    expect(H.s.mail[0].replyTo).toBe("ops@example.com");
    expect(H.s.mail[0].cc).toContain("ops@example.com");
    expect(H.s.mail[0].body).toContain("Sent from Anvil by Test Operator.");
  });

  it("with a Postmark inbound address set, replies still go to the engineer, and the inbound address gets nothing", async () => {
    settingsOf(H.s).postmark_inbound_address = "orders-in@example.com";
    expect((await get()).body.recipients.reply_to).toBe("eng@example.com");
    await post();
    const m = H.s.mail[0];
    expect(m.replyTo).toBe("eng@example.com");
    expect(m.cc).toEqual(["eng@example.com"]);
    expect(m.to).toBe("orders-desk@example.com");
  });

  it("with a watched Outlook mailbox, replies still go to the engineer", async () => {
    Object.assign(settingsOf(H.s), { graph_mailbox: "shared-box@example.com", graph_subscription_id: "sub-1" });
    expect((await get()).body.recipients.reply_to).toBe("eng@example.com");
  });

  it("on Graph, the message sent carries the engineer as reply-to, the CC and the PO number", async () => {
    H.s.graphOn = true;
    settingsOf(H.s).postmark_inbound_address = "orders-in@example.com";
    const r = await post();
    expect(r.body.status).toBe("sent");
    expect(H.s.mail).toHaveLength(0);
    const draft = H.s.fetches.find((f) => /\/messages$/.test(f.url));
    expect(draft.body.replyTo).toEqual([{ emailAddress: { address: "eng@example.com" } }]);
    expect(draft.body.ccRecipients).toEqual([{ emailAddress: { address: "eng@example.com" } }]);
    expect(draft.body.subject).toContain("PO PO-T-100");
    expect(draft.body.attachments.map((a) => a.name)).toEqual(["SO-PO-T-100.pdf", "po.pdf"]);
  });

  it("buildGraphMessage sets replyTo only when one is given", () => {
    expect(buildGraphMessage({ to: "a@example.com", replyTo: "b@example.com", subject: "s", body: "b" }).replyTo)
      .toEqual([{ emailAddress: { address: "b@example.com" } }]);
    expect("replyTo" in buildGraphMessage({ to: "a@example.com", subject: "s", body: "b" })).toBe(false);
  });
});
