// EA-5: verification end to end. Request tests [5] an Outlook reply is
// detected and verified (through the real sync and the Graph adapter), [6] a
// Gmail reply, [7] forwards, [8] ambiguous matches stay awaiting
// verification, [11] a sent acknowledgement does not resolve the issue. Plus
// the manual path: a claim, maker and checker, and a person's decision.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";
import { withEnsure } from "./test-email-ensure";

const H = vi.hoisted(() => {
  process.env.ANVIL_SECRETS_KEY = "e".repeat(64);
  return { db: null, svc: null, ctx: null };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.svc() }));
vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));

let makeEngine, runEmailSync, encryptField, byId, evidenceApi, verifyApi;
beforeAll(async () => {
  ({ makeEngine } = await import("../api/_lib/email-accountability/engine.js"));
  ({ runEmailSync } = await import("../api/email/sync.js"));
  ({ encryptField } = await import("../api/_lib/secrets.js"));
  byId = (await import("../api/email_actions/[id].js")).default;
  evidenceApi = (await import("../api/email_actions/evidence.js")).default;
  verifyApi = (await import("../api/email_actions/verify.js")).default;
});

const NOW = new Date("2026-10-22T06:30:00Z");
const M1 = { id: "m1", tenant_id: "t1", provider: "outlook", owner_user_id: "u1", address: "rep@seller.example", status: "active" };
const G1 = { id: "g1", tenant_id: "t1", provider: "gmail", owner_user_id: "u1", address: "rep@seller.example", status: "active" };

const seed = ({ mode = "create" } = {}) => {
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: "t1", email_actions_mode: mode, email_accountability_enabled: true }],
    mailbox_connections: [M1, G1],
    tenant_members: ["u1", "mgr", "mgr2"].map((u) => ({ tenant_id: "t1", user_id: u, status: "approved" })),
    customers: [{ id: "c1", tenant_id: "t1", contact_email: "buyer@customer.example", owner_user_id: null }],
    customer_contacts: [], orders: [], email_rules: [],
    email_actions: [], work_items: [], email_action_evidence: [], audit_events: [],
  });
  H.svc = withEnsure(H.db);
};

const inbound = (id, extra = {}) => ({
  provider: "outlook", providerId: "g-" + id, internetMessageId: "<" + id + "@mail.example>",
  conversationId: "conv-" + id, conversationIndex: null, inReplyTo: null, references: [],
  direction: "in", from: "buyer@customer.example", fromName: "Buyer", to: ["rep@seller.example"], cc: [],
  subject: "Please confirm the order", preview: "", hasAttachments: false,
  sentAt: "2026-10-22T05:59:00Z", receivedAt: "2026-10-22T06:00:00Z", webLink: null, ...extra,
});
const outbound = (id, extra = {}) => ({
  provider: "outlook", providerId: "s-" + id, internetMessageId: "<" + id + "@seller.example>",
  conversationId: null, conversationIndex: null, inReplyTo: null, references: [],
  direction: "out", from: "rep@seller.example", to: ["buyer@customer.example"], cc: [],
  subject: "Re: please confirm the order", preview: "", hasAttachments: false,
  sentAt: "2026-10-22T07:00:00Z", receivedAt: "2026-10-22T07:00:00Z", webLink: null, ...extra,
});

const engine = () => makeEngine(H.svc(), { now: () => NOW });
const run = (messages, connection = M1) => engine()(messages, { connection });
const item = (n = 0) => H.db.tables.work_items[n];
const act = (n = 0) => H.db.tables.email_actions[n];
const evidence = () => H.db.tables.email_action_evidence;
const audits = () => H.db.tables.audit_events.map((a) => a.action);

beforeEach(() => seed());

describe("[5] an Outlook reply through the real sync", () => {
  it("Inbox makes the action; the Sent Items reply with In-Reply-To verifies it", async () => {
    Object.assign(H.db.tables.tenant_settings[0], {
      graph_tenant_id: "directory.example", graph_client_id: "client-1", graph_client_secret_enc: encryptField("s"),
    });
    Object.assign(H.db.tables.mailbox_connections[0], {
      checkpoint: {}, access_token_enc: encryptField("AT"), refresh_token_enc: encryptField("RT"),
      token_expires_at: new Date(Date.now() + 3_600_000).toISOString(), daily_request_budget: 100,
      poll_interval_minutes: 5, initial_lookback_hours: 72, consecutive_failures: 0,
    });
    H.db.tables.mailbox_connections[1].status = "disconnected";
    const delta = (value) => new Response(JSON.stringify({ value, "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders('x')/messages/delta?$deltatoken=1" }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/mailFolders/inbox/")) {
        return delta([{
          id: "in-graph-1", internetMessageId: "<po-1@mail.example>", conversationId: "conv-po-1",
          from: { emailAddress: { address: "Buyer@Customer.example" } }, toRecipients: [{ emailAddress: { address: "rep@seller.example" } }],
          subject: "Please confirm the order", bodyPreview: "", receivedDateTime: "2026-10-22T06:00:00Z",
        }]);
      }
      return delta([{
        id: "sent-graph-1", internetMessageId: "<re-1@seller.example>", conversationId: "conv-po-1",
        from: { emailAddress: { address: "rep@seller.example" } }, toRecipients: [{ emailAddress: { address: "buyer@customer.example" } }],
        subject: "RE: Please confirm the order", bodyPreview: "Confirmed.", sentDateTime: "2026-10-22T07:00:00Z", receivedDateTime: "2026-10-22T07:00:00Z",
        singleValueExtendedProperties: [{ id: "String 0x1042", value: "<po-1@mail.example>" }],
      }]);
    }));
    const svc = H.svc();
    const out = await runEmailSync(svc, { onPage: makeEngine(svc, { now: () => NOW }), sleep: async () => {} });
    expect(out.results[0]).toMatchObject({ ok: true, stats: { created: 1, verified: 1 } });
    expect(item()).toMatchObject({ status: "performed", status_category: "done", completed_by: "u1", resolution: "verified" });
    expect(act().business_status).toBe("awaiting_external");
    expect(evidence()).toHaveLength(1);
    expect(evidence()[0]).toMatchObject({ kind: "outgoing", method: "header_reply", status: "verified", confidence: "high", sender: "rep@seller.example" });
    expect(audits()).toEqual(["email_action_detected", "email_action_verified"]);
  });

  it("without the MAPI properties, a direct conversationIndex child still verifies", async () => {
    const root = Buffer.alloc(22, 3).toString("base64");
    const child = Buffer.concat([Buffer.alloc(22, 3), Buffer.alloc(5, 9)]).toString("base64");
    await run([inbound("a1", { conversationIndex: root })]);
    await run([outbound("r1", { conversationId: "conv-a1", conversationIndex: child })]);
    expect(item().status).toBe("performed");
    expect(evidence()[0]).toMatchObject({ method: "conversation_index", status: "verified" });
  });
});

describe("[6] a Gmail reply", () => {
  it("References names the action's message: verified", async () => {
    await run([inbound("b1", { provider: "gmail", conversationId: "thread-b1" })], G1);
    await run([outbound("r2", { provider: "gmail", conversationId: "thread-b1", references: ["<b1@mail.example>"] })], G1);
    expect(item().status).toBe("performed");
    expect(evidence()[0]).toMatchObject({ method: "header_reply", status: "verified" });
  });
});

describe("[7] forwards", () => {
  it("a forward to the set target verifies; to someone else it waits for a person", async () => {
    await run([inbound("c1"), inbound("c2")]);
    for (const a of H.db.tables.email_actions) Object.assign(a, { action_type: "forward", requirement: "forward_to_target", forward_to: ["finance@seller.example"] });
    await run([
      outbound("f1", { subject: "Fw: order", to: ["finance@seller.example"], references: ["<c1@mail.example>"] }),
      outbound("f2", { subject: "Fw: order", to: ["someone@seller.example"], references: ["<c2@mail.example>"] }),
    ]);
    expect(item(0).status).toBe("performed");
    expect(item(1).status).toBe("awaiting_verification");
    expect(evidence().map((e) => e.status)).toEqual(["verified", "ambiguous"]);
  });
});

describe("[8] ambiguous matches stay awaiting verification", () => {
  it("same conversation but no header link: evidence ambiguous, action awaiting verification", async () => {
    await run([inbound("d1")]);
    const counts = await run([outbound("r3", { conversationId: "conv-d1" })]);
    expect(counts).toMatchObject({ verified: 0, to_verification: 1, evidence_ambiguous: 1 });
    expect(item()).toMatchObject({ status: "awaiting_verification", status_category: "in_progress" });
    expect(act().business_status).toBe("awaiting_internal");
    expect(evidence()[0]).toMatchObject({ method: "conversation_only", confidence: "low" });
  });

  it("a reply that went to other people is ambiguous", async () => {
    await run([inbound("d2")]);
    await run([outbound("r4", { inReplyTo: "<d2@mail.example>", to: ["colleague@customer.example"] })]);
    expect(item().status).toBe("awaiting_verification");
  });
});

describe("[11] a sent acknowledgement does not resolve the issue", () => {
  it("a shipment delay makes investigate and reply; the reply performs only the reply", async () => {
    await run([inbound("e1", { subject: "Shipment delayed again, please update us" })]);
    const byType = Object.fromEntries(H.db.tables.email_actions.map((a, i) => [a.action_type, i]));
    expect(Object.keys(byType).sort()).toEqual(["investigate", "reply"]);
    await run([outbound("r5", { inReplyTo: "<e1@mail.example>", subject: "Re: shipment delayed" })]);

    expect(item(byType.reply).status).toBe("performed");
    expect(act(byType.reply).business_status).toBe("awaiting_external");
    expect(item(byType.investigate).status).toBe("pending");
    expect(act(byType.investigate).business_status).toBe("awaiting_internal");
    expect(evidence().find((e) => e.email_action_id === act(byType.investigate).id)).toMatchObject({ status: "ambiguous" });
    expect(H.db.tables.email_actions.some((a) => a.business_status === "resolved" || a.business_status === "closed")).toBe(false);
  });
});

describe("safety", () => {
  it("a replayed sent page adds no evidence and no second audit", async () => {
    await run([inbound("g1")]);
    const reply = outbound("r6", { inReplyTo: "<g1@mail.example>" });
    await run([reply]);
    await run([reply]);
    expect(evidence()).toHaveLength(1);
    expect(audits().filter((a) => a === "email_action_verified")).toHaveLength(1);
  });

  it("a reopened action is not closed again by a replay of the old reply", async () => {
    await run([inbound("g2")]);
    const reply = outbound("r7", { inReplyTo: "<g2@mail.example>" });
    await run([reply]);
    Object.assign(item(), { status: "pending", status_category: "todo", version: item().version + 1 });
    await run([reply]);
    expect(item().status).toBe("pending");
  });

  it("a cancelled action is never revived by a reply", async () => {
    await run([inbound("g3")]);
    Object.assign(item(), { status: "cancelled", status_category: "cancelled" });
    await run([outbound("r8", { inReplyTo: "<g3@mail.example>" })]);
    expect(item().status).toBe("cancelled");
    expect(evidence()).toHaveLength(0);
  });

  it("a person's edit between the read and the write: the verifier reads again and still applies", async () => {
    await run([inbound("g4")]);
    const base = H.svc;
    let bumped = false;
    H.svc = () => {
      const svc = base();
      const from = svc.from;
      svc.from = (t) => {
        const q = from(t);
        if (t === "email_action_evidence" && !bumped) {
          const insert = q.insert;
          q.insert = (row) => { bumped = true; item().version += 1; return insert(row); };
        }
        return q;
      };
      return svc;
    };
    await run([outbound("r9", { inReplyTo: "<g4@mail.example>" })]);
    expect(item().status).toBe("performed");
  });

  it("observe mode counts what it would verify and writes nothing", async () => {
    await run([inbound("g5")]);
    H.db.tables.tenant_settings[0].email_actions_mode = "observe";
    const counts = await run([outbound("r10", { inReplyTo: "<g5@mail.example>" })]);
    expect(counts.would_verify).toBe(1);
    expect(evidence()).toHaveLength(0);
    expect(item().status).toBe("pending");
  });
});

describe("the manual path: a claim, maker and checker", () => {
  const as = (id, role) => { H.ctx = { tenantId: "t1", user: { id }, role }; };
  const claim = (body) => callHandler(evidenceApi, { method: "POST", query: { id: act().id }, body });
  const decide = (body) => callHandler(verifyApi, { method: "POST", query: { id: act().id }, body });

  beforeEach(async () => { await run([inbound("h1")]); });

  it("a claim needs a note and moves the action to awaiting verification, not to performed", async () => {
    as("u1", "sales_engineer");
    expect((await claim({ note: "done" })).status).toBe(400);
    const r = await claim({ note: "Confirmed by phone with the buyer", reference: "call 10:05" });
    expect(r.status).toBe(200);
    expect(item().status).toBe("awaiting_verification");
    expect(evidence()[0]).toMatchObject({ kind: "manual", status: "claimed", recorded_by: "u1" });
    expect(audits()).toContain("email_action_evidence_claimed");
  });

  it("a sales engineer cannot decide; the claimant cannot confirm their own claim", async () => {
    as("mgr2", "sales_manager");
    await claim({ note: "Confirmed by phone with the buyer" });
    as("u1", "sales_engineer");
    const se = await decide({ evidence_id: evidence()[0].id, decision: "confirm", reason: "looks fine" });
    expect(se.status).toBe(403);
    expect(se.body.error.message).toMatch(/email\.verify/);
    as("mgr2", "sales_manager");
    const own = await decide({ evidence_id: evidence()[0].id, decision: "confirm", reason: "looks fine" });
    expect(own.status).toBe(403);
    expect(own.body.error.message).toMatch(/claim/);
    expect(item().status).toBe("awaiting_verification");
  });

  it("another manager confirms with a reason: performed as a manual override, audited", async () => {
    as("u1", "sales_engineer");
    await claim({ note: "Confirmed by phone with the buyer" });
    as("mgr", "sales_manager");
    expect((await decide({ evidence_id: evidence()[0].id, decision: "confirm" })).status).toBe(400);
    const r = await decide({ evidence_id: evidence()[0].id, decision: "confirm", reason: "Call log checked" });
    expect(r.status).toBe(200);
    expect(item()).toMatchObject({ status: "performed", resolution: "manual_override", completed_by: "mgr" });
    expect(act().business_status).toBe("awaiting_external");
    expect(evidence()[0]).toMatchObject({ status: "confirmed", decided_by: "mgr", decision_reason: "Call log checked" });
    const a = H.db.tables.audit_events.find((x) => x.action === "email_action_manual_verified");
    expect(a).toMatchObject({ actor: "mgr", reason: "Call log checked" });
    const again = await decide({ evidence_id: evidence()[0].id, decision: "reject", reason: "late" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already confirmed/);
  });

  it("a rejected claim sends the action back to in progress", async () => {
    as("u1", "sales_engineer");
    await claim({ note: "Confirmed by phone with the buyer" });
    as("mgr", "sales_manager");
    await decide({ evidence_id: evidence()[0].id, decision: "reject", reason: "No record of the call" });
    expect(item().status).toBe("in_progress");
    expect(evidence()[0].status).toBe("rejected");
  });

  it("a manager decides ambiguous mail the same way", async () => {
    await run([outbound("r11", { conversationId: "conv-h1" })]);
    expect(item().status).toBe("awaiting_verification");
    as("mgr", "sales_manager");
    await decide({ evidence_id: evidence()[0].id, decision: "confirm", reason: "Read the reply; it answers the PO" });
    expect(item()).toMatchObject({ status: "performed", resolution: "verified_by_person" });
  });

  it("no claim on a performed action, and the detail shows the evidence", async () => {
    await run([outbound("r12", { inReplyTo: "<h1@mail.example>" })]);
    as("u1", "sales_engineer");
    expect((await claim({ note: "Confirmed by phone with the buyer" })).status).toBe(409);
    const d = await callHandler(byId, { query: { id: act().id } });
    expect(d.body.evidence).toHaveLength(1);
    expect(d.body.evidence[0]).toMatchObject({ kind: "outgoing", status: "verified" });
  });

  it("the forward target is set by a person, and checked", async () => {
    as("u1", "sales_engineer");
    expect((await callHandler(byId, { method: "PATCH", query: { id: act().id }, body: { version: item().version, forward_to: ["not an address"] } })).status).toBe(400);
    const r = await callHandler(byId, { method: "PATCH", query: { id: act().id }, body: { version: item().version, forward_to: ["Finance@Seller.example"] } });
    expect(r.status).toBe(200);
    expect(act().forward_to).toEqual(["finance@seller.example"]);
  });
});
