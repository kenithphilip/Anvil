// EA-3: inbound mail becomes actions. Request tests [1] one action for a
// critical email, [2] no task for an irrelevant one, [3] no duplicates,
// [4] reliable customer and sales order links, [9] reading does not complete,
// [18] existing task and sales order data unchanged.
//
// The memory fake has no SQL functions; test-email-ensure.js plays
// email_action_ensure with the semantics checked on a real Postgres engine.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb } from "./test-memory-supabase";
import { withEnsure } from "./test-email-ensure";

const H = vi.hoisted(() => {
  process.env.ANVIL_SECRETS_KEY = "d".repeat(64);
  return { db: null, svc: null };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.svc() }));

let makeEngine, emailHash, runEmailSync, encryptField;
beforeAll(async () => {
  ({ makeEngine } = await import("../api/_lib/email-accountability/engine.js"));
  ({ emailHash } = await import("../api/_lib/email-canonical.js"));
  ({ runEmailSync } = await import("../api/email/sync.js"));
  ({ encryptField } = await import("../api/_lib/secrets.js"));
});

const NOW = new Date("2026-10-22T06:30:00Z");

const mailbox = (id, owner, address) => ({ id, tenant_id: "t1", provider: "outlook", owner_user_id: owner, address, status: "active" });
const M1 = mailbox("m1", "u1", "rep@seller.example");
const M2 = mailbox("m2", "u2", "rep2@seller.example");

const seed = async ({ mode = "create", rules = [], members = ["u1", "u2", "u3"] } = {}) => {
  const contact = async (id, customer_id, email) => ({ id, tenant_id: "t1", customer_id, email, is_active: true, canonical_email_hash: await emailHash(email) });
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: "t1", email_actions_mode: mode, email_accountability_enabled: true }],
    mailbox_connections: [M1, M2],
    tenant_members: members.map((u) => ({ tenant_id: "t1", user_id: u, role: "sales_engineer", status: "approved" })),
    customers: [
      { id: "c1", tenant_id: "t1", owner_user_id: "u3", contact_email: null },
      { id: "c2", tenant_id: "t1", owner_user_id: null, contact_email: null },
      { id: "c3", tenant_id: "t1", owner_user_id: null, contact_email: null },
      { id: "c4", tenant_id: "t1", owner_user_id: null, contact_email: "accounts@solo.example" },
    ],
    customer_contacts: [
      await contact("k1", "c1", "buyer@customer.example"),
      await contact("k2", "c2", "a@shared.example"),
      await contact("k3", "c3", "b@shared.example"),
    ],
    orders: [
      { id: "o1", tenant_id: "t1", customer_id: "c1", po_number: "4501234567", opportunity_id: "op1", status: "APPROVED", created_at: "2026-10-01" },
      { id: "o2", tenant_id: "t1", customer_id: "c1", po_number: "PO-77", opportunity_id: null, status: "DRAFT", created_at: "2026-10-02" },
      { id: "o3", tenant_id: "t1", customer_id: "c1", po_number: "88001", opportunity_id: null, status: "CANCELLED", created_at: "2026-10-03" },
    ],
    email_rules: rules,
    email_actions: [],
    work_items: [],
    audit_events: [],
    inbound_emails: [],
    communications: [],
    quote_approvals: [],
  });
  H.svc = withEnsure(H.db);
};

const msg = (id, extra = {}) => ({
  provider: "outlook", providerId: "graph-" + id, internetMessageId: "<" + id + "@mail.example>",
  conversationId: "conv-" + id, conversationIndex: null, inReplyTo: null, references: [],
  direction: "in", from: "buyer@customer.example", fromName: "Buyer",
  to: ["rep@seller.example"], cc: [], subject: "", preview: "", hasAttachments: false,
  sentAt: "2026-10-22T06:00:00Z", receivedAt: "2026-10-22T06:00:01Z",
  autoSubmitted: null, listUnsubscribe: null, precedence: null, webLink: "https://outlook.example/" + id,
  ...extra,
});

const run = async (messages, connection = M1) => makeEngine(H.svc(), { now: () => NOW })(messages, { connection });
const actions = () => H.db.tables.email_actions;
const items = () => H.db.tables.work_items;

beforeEach(async () => { await seed(); });

describe("[1] a critical email creates exactly one action", () => {
  it("one work item and one email action, owned, due, with reasons", async () => {
    const counts = await run([msg("a1", { subject: "Legal notice: penalty for late supply" })]);
    expect(counts).toMatchObject({ created: 1 });
    expect(actions()).toHaveLength(1);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      type: "task", subject_type: "email_action", source: "event", priority: 1,
      status: "pending", status_category: "todo", assignee_user_id: "u1", account_id: "c1",
      due_source: "sla", due_at: "2026-10-22T10:30:00.000Z",
    });
    expect(actions()[0]).toMatchObject({
      action_type: "investigate", requirement: "manual", business_status: "awaiting_internal",
      from_address: "buyer@customer.example", customer_contact_id: "k1", backup_user_id: "u3",
      connection_id: "m1", web_link: "https://outlook.example/a1",
    });
    expect(actions()[0].reasons.some((r) => r.kind === "fact" && r.code === "known_contact")).toBe(true);
    expect(H.db.tables.audit_events.map((a) => a.action)).toEqual(["email_action_detected"]);
  });

  it("an escalation from an unknown sender goes to review, not to the owner's queue", async () => {
    await run([msg("a2", { from: "stranger@new.example", subject: "Escalation: wrong supply" })]);
    expect(items()[0]).toMatchObject({ status: "awaiting_review", status_category: "todo", account_id: null });
    expect(actions()[0].business_status).toBe("not_assessed");
  });

  it("an owner who left the tenant leaves the action detected and unowned", async () => {
    await seed({ members: ["u2", "u3"] });
    await run([msg("a3", { subject: "Legal notice" })]);
    expect(items()[0]).toMatchObject({ status: "detected", assignee_user_id: null });
  });
});

describe("[2] an irrelevant email creates no task", () => {
  it("bulk, internal, unknown with no phrase, and a known contact with no request: nothing is written", async () => {
    const counts = await run([
      msg("b1", { listUnsubscribe: "<mailto:x@list.example>", subject: "Payment overdue offers" }),
      msg("b2", { from: "colleague@seller.example", subject: "Urgent: lunch" }),
      msg("b3", { from: "vendor@sales.example", subject: "Our new catalogue" }),
      msg("b4", { subject: "Thanks for the visit" }),
    ]);
    expect(counts).toMatchObject({ created: 0, excluded: 2, irrelevant: 2 });
    expect(actions()).toHaveLength(0);
    expect(items()).toHaveLength(0);
  });

  it("observe mode writes nothing and counts what create would make", async () => {
    await seed({ mode: "observe" });
    const counts = await run([msg("b5", { subject: "Please confirm the order" })]);
    expect(counts).toMatchObject({ created: 0, would_create: 1 });
    expect(actions()).toHaveLength(0);
    expect(H.db.tables.audit_events).toHaveLength(0);
  });

  it("a connected free-mail mailbox does not make every free-mail sender internal", async () => {
    H.db.tables.mailbox_connections.push(mailbox("m3", "u3", "someone@gmail.com"));
    await run([msg("b7", { from: "buyer.two@gmail.com", subject: "Legal notice" })]);
    expect(actions()).toHaveLength(1);
  });

  it("outbound mail makes no action", async () => {
    // From a free-mail mailbox, so the internal-sender rule does not hide it.
    await run([msg("b6", { direction: "out", from: "rep.personal@gmail.com", subject: "Legal notice: please confirm the order" })]);
    expect(actions()).toHaveLength(0);
  });
});

describe("[3] duplicate sync events create no duplicates", () => {
  it("the same page twice, and the same message after a checkpoint reset, stay one action", async () => {
    const m = msg("c1", { subject: "Please confirm the order" });
    await run([m]);
    await run([m]);
    await run([{ ...m, providerId: "graph-new-id-after-reset" }]);
    expect(actions()).toHaveLength(1);
    expect(items()).toHaveLength(1);
  });

  it("the same message in a second mailbox is one action; both mailboxes are recorded", async () => {
    const m = msg("c2", { subject: "Please confirm the order", to: ["rep@seller.example"], cc: ["rep2@seller.example"] });
    await run([m], M1);
    const counts = await run([{ ...m, providerId: "graph-in-m2" }], M2);
    expect(counts).toMatchObject({ created: 0, seen_again: 1, reassigned: 0 });
    expect(actions()).toHaveLength(1);
    expect(actions()[0].seen_connection_ids).toEqual(["m1", "m2"]);
    expect(items()[0].assignee_user_id).toBe("u1");
  });

  it("the person in To takes an untouched action from the person in Cc", async () => {
    const m = msg("c3", { subject: "Please confirm the order", to: ["rep2@seller.example"], cc: ["rep@seller.example"] });
    await run([m], M1);
    expect(items()[0].assignee_user_id).toBe("u1");
    const counts = await run([m], M2);
    expect(counts.reassigned).toBe(1);
    expect(items()[0].assignee_user_id).toBe("u2");
    expect(actions()[0].connection_id).toBe("m2");
    expect(H.db.tables.audit_events.map((a) => a.action)).toContain("email_action_reassigned");
  });

  it("work in progress is never taken away", async () => {
    const m = msg("c4", { subject: "Please confirm the order", to: ["rep2@seller.example"], cc: ["rep@seller.example"] });
    await run([m], M1);
    items()[0].status = "in_progress";
    const counts = await run([m], M2);
    expect(counts.reassigned).toBe(0);
    expect(items()[0].assignee_user_id).toBe("u1");
    expect(actions()[0].connection_id).toBe("m1");
    expect(H.db.tables.audit_events.map((a) => a.action)).not.toContain("email_action_reassigned");
  });

  it("a follow-up in the thread updates the open action and makes no new one", async () => {
    await run([msg("c5", { subject: "Please confirm the order" })]);
    const counts = await run([msg("c6", {
      subject: "Re: please confirm the order, urgent", inReplyTo: "<c5@mail.example>",
      references: ["<c5@mail.example>"], conversationId: "conv-c5",
    })]);
    expect(counts).toMatchObject({ created: 0, follow_ups: 1 });
    expect(actions()).toHaveLength(1);
    // "urgent" from a known contact is critical: the open action is raised.
    expect(items()[0].priority).toBe(1);
    expect(actions()[0].last_activity_at).toBe(NOW.toISOString());
  });

  it("a closed action in the thread does not hide a new request", async () => {
    await run([msg("c7", { subject: "Please confirm the order" })]);
    items()[0].status_category = "done";
    await run([msg("c8", { subject: "Please confirm the revised order", conversationId: "conv-c7" })]);
    expect(actions()).toHaveLength(2);
  });
});

describe("[4] links only when the match is reliable", () => {
  it("an exact contact and a PO number in the subject link the customer, the order and its opportunity", async () => {
    await run([msg("d1", { subject: "Please confirm the order 4501234567" })]);
    expect(items()[0]).toMatchObject({ account_id: "c1", order_id: "o1", opportunity_id: "op1" });
    expect(actions()[0].reasons.some((r) => r.code === "po_reference" && r.kind === "fact")).toBe(true);
  });

  it("a PO number inside a longer number, or on a cancelled order, links no order", async () => {
    await run([msg("d2", { subject: "Please confirm the order 45012345678" })]);
    await run([msg("d3", { subject: "Please confirm the order 88001" })]);
    expect(items().map((i) => i.order_id)).toEqual([null, null]);
  });

  it("a free-mail sender links no customer, even when a contact shares the domain", async () => {
    H.db.tables.customer_contacts.push({ id: "k9", tenant_id: "t1", customer_id: "c2", email: "someone@gmail.com", is_active: true, canonical_email_hash: "x" });
    await run([msg("d4", { from: "other.person@gmail.com", subject: "Payment overdue" })]);
    expect(items()[0]).toMatchObject({ account_id: null, status: "awaiting_review" });
    expect(actions()[0].reasons.some((r) => r.code === "free_mail" && r.kind === "inferred")).toBe(true);
  });

  it("a domain that two customers share links neither", async () => {
    await run([msg("d5", { from: "new@shared.example", subject: "Payment overdue" })]);
    expect(items()[0].account_id).toBeNull();
    expect(actions()[0].reasons.some((r) => r.code === "shared_domain")).toBe(true);
  });

  it("a domain only one customer uses links it; an underscore in a domain is not a wildcard", async () => {
    await run([msg("d6", { from: "new.person@solo.example", subject: "Payment overdue" })]);
    expect(items()[0]).toMatchObject({ account_id: "c4", status: "pending" });
    await run([msg("d7", { from: "x@sol_.example", subject: "Payment overdue" })]);
    expect(items()[1].account_id).toBeNull();
  });
});

describe("[9] reading an email does not complete an action", () => {
  it("the same message seen again, read or not, leaves the state as it was", async () => {
    const m = msg("e1", { subject: "Please confirm the order" });
    await run([m]);
    await run([{ ...m, isRead: true }]);
    expect(items()[0]).toMatchObject({ status: "pending", status_category: "todo" });
    expect(items()[0].completed_at).toBeUndefined();
  });
});

describe("[18] existing task and sales order data are unchanged", () => {
  it("the engine writes only email_actions, work_items and audit rows", async () => {
    const before = JSON.stringify({ o: H.db.tables.orders, c: H.db.tables.customers, k: H.db.tables.customer_contacts });
    await run([
      msg("f1", { subject: "Please confirm the order 4501234567" }),
      msg("f2", { subject: "Payment overdue" }),
    ]);
    expect(JSON.stringify({ o: H.db.tables.orders, c: H.db.tables.customers, k: H.db.tables.customer_contacts })).toBe(before);
    expect(H.db.tables.inbound_emails).toHaveLength(0);
    expect(H.db.tables.communications).toHaveLength(0);
    expect(H.db.tables.quote_approvals).toHaveLength(0);
    expect(items().every((i) => i.subject_type === "email_action" && i.source === "event")).toBe(true);
  });
});

describe("the sync runs the engine", () => {
  it("a Graph page with one request becomes one action, and the mailbox stats count it", async () => {
    H.db.tables.tenant_settings[0] = {
      ...H.db.tables.tenant_settings[0],
      graph_tenant_id: "directory.example", graph_client_id: "client-1", graph_client_secret_enc: encryptField("s"),
    };
    Object.assign(H.db.tables.mailbox_connections[0], {
      checkpoint: {}, access_token_enc: encryptField("AT"), refresh_token_enc: encryptField("RT"),
      token_expires_at: new Date(Date.now() + 3_600_000).toISOString(), daily_request_budget: 100,
      poll_interval_minutes: 5, initial_lookback_hours: 72, consecutive_failures: 0,
    });
    H.db.tables.mailbox_connections[1].status = "disconnected";
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      const value = u.includes("/inbox/") ? [{
        id: "g-1", internetMessageId: "<sync-1@mail.example>", conversationId: "conv-s1",
        from: { emailAddress: { address: "buyer@customer.example" } }, toRecipients: [{ emailAddress: { address: "rep@seller.example" } }],
        subject: "Please confirm the order", bodyPreview: "", receivedDateTime: "2026-10-22T06:00:00Z",
      }] : [];
      return new Response(JSON.stringify({ value, "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders('x')/messages/delta?$deltatoken=1" }), { status: 200 });
    }));
    const svc = H.svc();
    const out = await runEmailSync(svc, { onPage: makeEngine(svc, { now: () => NOW }), sleep: async () => {} });
    expect(out.results[0]).toMatchObject({ ok: true, stats: { created: 1, inbound: 1 } });
    expect(actions()).toHaveLength(1);
    expect(H.db.tables.mailbox_connections[0].last_sync_stats.created).toBe(1);
  });
});
