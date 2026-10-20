// The handoff sends in the request and never leaves a queued row
// (docs/SO_EXECUTION_COHESION.md R-F3 change 1, SO_TERMS_AND_HANDOFF_SCOPE.md
// 12.3). The agents/run reaper drains every queued communications row later,
// so a queued handoff would reach the clerk hours after the screen said "not
// sent". The real send core runs; only the mail provider is a stand-in.

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
const post = (body = { order_id: ORDER }) => callRoute(dispatch, "POST", { body });

// Every status a communications row was given, by insert or update.
const statusesWritten = () => H.s.writes
  .filter((w) => w.table === "communications")
  .flatMap((w) => (w.mode === "insert" ? w.rows.map((r) => r.status) : [w.patch.status]))
  .filter(Boolean);

beforeEach(() => {
  H.s = freshState();
  asEngineer(H.s);
});

describe("orders-handoff: the send is direct", () => {
  it("the row is inserted as a draft, never queued, and is sent in the same request", async () => {
    const r = await post();
    expect(r.body).toMatchObject({ ok: true, status: "sent" });
    const insert = H.s.writes.find((w) => w.table === "communications" && w.mode === "insert");
    expect(insert.rows[0].status).toBe("draft");
    expect(handoffComms(H.s).map((c) => c.status)).toEqual(["sent"]);
    expect(statusesWritten()).not.toContain("queued");
    expect(H.s.mail).toHaveLength(1);
  });

  it("with no mail provider it says not_configured, marks the row failed, and leaves nothing queued", async () => {
    H.s.mailer = "off";
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, status: "not_configured" });
    expect(r.body.message).toMatch(/no mail provider/i);
    expect(orderOf(H.s).handoff_status).toBe("not_configured");
    const rows = handoffComms(H.s);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].metadata.error).toBe("no_provider_at_send");
    // Nothing a reaper could pick up later.
    expect(H.s.store.communications.filter((c) => c.status === "queued")).toHaveLength(0);
    expect(r.body.handoff).toMatchObject({ status: "not_configured" });
  });

  it("a provider refusal is failed, with the reason, and is not reported as sent", async () => {
    H.s.mailer = "fail";
    const r = await post();
    expect(r.body).toMatchObject({ ok: false, status: "failed" });
    expect(r.body.message).toMatch(/^Failed: /);
    expect(orderOf(H.s).handoff_status).toBe("failed");
    expect(handoffComms(H.s)[0].status).toBe("failed");
    expect(statusesWritten()).not.toContain("queued");
  });

  it("a failed send is retried by a plain second click, without resend", async () => {
    H.s.mailer = "fail";
    await post();
    H.s.mailer = "ok";
    const r = await post();
    expect(r.body.status).toBe("sent");
    expect(orderOf(H.s).handoff_status).toBe("sent");
    expect(handoffComms(H.s).map((c) => c.status)).toEqual(["failed", "sent"]);
  });
});
