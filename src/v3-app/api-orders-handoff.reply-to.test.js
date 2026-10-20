// Reply-to for the handoff (decision C-D12): the tenant's Anvil inbound
// address when one exists, else the engineer. The engineer stays in CC and
// the PO number is in the subject. The Graph branch of sendCommunication
// passes reply_to too (SO_TERMS_AND_HANDOFF_SCOPE.md 8.1): the real
// sendViaGraph runs here, and only the HTTP call is a stand-in.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ORDER, freshState, asEngineer, settingsOf, handoffComms, callRoute } from "./test-support/handoff-harness.js";

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
  it("with no Anvil inbound address, replies go to the engineer, who is also in CC", async () => {
    expect((await get()).body.recipients.reply_to).toBe("eng@example.com");
    await post();
    const m = H.s.mail[0];
    expect(m.replyTo).toBe("eng@example.com");
    expect(m.cc).toContain("eng@example.com");
    expect(m.subject).toContain("PO PO-T-100");
    expect(m.body).toContain("Reply to this email to reach them.");
    expect(handoffComms(H.s)[0].reply_to).toBe("eng@example.com");
  });

  it("with an inbound address, replies go to Anvil and the engineer stays in CC", async () => {
    settingsOf(H.s).postmark_inbound_address = "Orders-In@Example.com";
    expect((await get()).body.recipients.reply_to).toBe("orders-in@example.com");
    await post();
    const m = H.s.mail[0];
    expect(m.replyTo).toBe("orders-in@example.com");
    expect(m.cc).toContain("eng@example.com");
    expect(m.body).toContain("Reply to all");
  });

  it("the shared Outlook mailbox Anvil watches counts as the inbound address", async () => {
    Object.assign(settingsOf(H.s), { graph_mailbox: "shared-box@example.com", graph_subscription_id: "sub-1" });
    expect((await get()).body.recipients.reply_to).toBe("shared-box@example.com");
  });

  it("a malformed inbound address is not used", async () => {
    settingsOf(H.s).postmark_inbound_address = "not an address";
    expect((await get()).body.recipients.reply_to).toBe("eng@example.com");
  });

  it("on Graph, the message sent carries the reply-to, the CC and the PO number", async () => {
    H.s.graphOn = true;
    settingsOf(H.s).postmark_inbound_address = "orders-in@example.com";
    const r = await post();
    expect(r.body.status).toBe("sent");
    expect(H.s.mail).toHaveLength(0);
    const draft = H.s.fetches.find((f) => /\/messages$/.test(f.url));
    expect(draft.body.replyTo).toEqual([{ emailAddress: { address: "orders-in@example.com" } }]);
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
