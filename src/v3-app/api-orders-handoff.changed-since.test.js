// "Changed since handoff" (docs/SO_EXECUTION_COHESION.md R-F3 change 4): the
// handoff stores the order's payload_hash at send (handoff_payload.payload_hash,
// the contract with the stage in C-9). When the order's hash moves after the
// send, the handoff says so and re-send is the next step. A re-send stores the
// new hash.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ORDER, freshState, asEngineer, orderOf, handoffComms, callRoute } from "./test-support/handoff-harness.js";

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
vi.mock("../api/_lib/graph-client.js", async (orig) => ({ ...(await orig()), graphIsConnected: () => false }));

const { dispatch } = await import("../api/router.js");
const { handoffChanged, handoffState } = await import("../api/_lib/order-handoff.js");
const post = (body = { order_id: ORDER }) => callRoute(dispatch, "POST", { body });
const get = () => callRoute(dispatch, "GET", { query: { order_id: ORDER } });

beforeEach(() => {
  H.s = freshState();
  asEngineer(H.s);
});

describe("orders-handoff: changed since handoff", () => {
  it("right after the send, the handoff matches the order", async () => {
    await post();
    const h = (await get()).body.handoff;
    expect(h).toMatchObject({ status: "sent", changed_since: false, sent_by: orderOf(H.s).handoff_sent_by, sent_by_name: "Test Engineer" });
  });

  it("a line edit after the send moves the hash: changed since handoff, and a re-send stores the new hash", async () => {
    await post();
    // What PATCH /api/orders/:id does on a line edit (payloadHashAfterWrite).
    orderOf(H.s).payload_hash = "hash-2";
    expect((await get()).body.handoff.changed_since).toBe(true);
    const r = await post({ order_id: ORDER, resend: true });
    expect(r.body.status).toBe("sent");
    expect(orderOf(H.s).handoff_payload.payload_hash).toBe("hash-2");
    expect(r.body.handoff.changed_since).toBe(false);
    expect(handoffComms(H.s)).toHaveLength(2);
  });

  it("the rule, case by case", () => {
    expect(handoffChanged({ handoff_status: "sent", payload_hash: "h1", handoff_payload: { payload_hash: "h1" } })).toBe(false);
    expect(handoffChanged({ handoff_status: "sent", payload_hash: "h2", handoff_payload: { payload_hash: "h1" } })).toBe(true);
    // A sent handoff with no stored hash cannot show it matches: re-send.
    expect(handoffChanged({ handoff_status: "sent", payload_hash: "h1", handoff_payload: null })).toBe(true);
    // Only a sent handoff can be out of date.
    expect(handoffChanged({ handoff_status: "failed", payload_hash: "h2", handoff_payload: { payload_hash: "h1" } })).toBe(false);
    expect(handoffState({ handoff_status: null })).toEqual({ status: "not_sent" });
  });
});
