// EA-4: the action and rules API. Request test [15]: a user cannot reach
// another user's restricted actions. Plus the changes a person may make, the
// rules endpoint, and the server/client action tables in step.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null }));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));

let list, byId, rules, SERVER_ACTIONS, hasAction, ACTIONS;
beforeAll(async () => {
  list = (await import("../api/email_actions/index.js")).default;
  byId = (await import("../api/email_actions/[id].js")).default;
  rules = (await import("../api/email_rules/index.js")).default;
  ({ SERVER_ACTIONS, hasAction } = await import("../api/_lib/auth.js"));
  ({ ACTIONS } = await import("./lib/rbac"));
});

const PAST = "2026-10-01T06:00:00.000Z";
const FUTURE = "2099-01-01T06:00:00.000Z";

const pair = (n, wi, ea) => ({
  wi: {
    id: "wi-" + n, tenant_id: "t1", type: "task", subject_type: "email_action", subject_id: "ea-" + n,
    title: "Reply: item " + n, status: "pending", status_category: "todo", priority: 3, version: 1,
    assignee_user_id: null, account_id: null, order_id: null, due_at: FUTURE, due_source: "sla",
    updated_at: "2026-10-20T00:00:00Z", ...wi,
  },
  ea: {
    id: "ea-" + n, tenant_id: "t1", work_item_id: "wi-" + n, provider: "outlook", provider_message_id: "p" + n,
    internet_message_id: "<" + n + "@mail.example>", message_key: "<" + n + "@mail.example>",
    action_type: "reply", requirement: "reply_to_sender", business_status: "awaiting_internal",
    connection_id: null, seen_connection_ids: [], backup_user_id: null, escalation_level: 0, reopen_count: 0,
    from_address: "buyer@customer.example", subject: "Item " + n, reasons: [], ...ea,
  },
});

const seed = () => {
  const P = [
    pair(1, { assignee_user_id: "u1", priority: 1, due_at: PAST, account_id: "c1", order_id: "o1" }, { connection_id: "m1", seen_connection_ids: ["m1"] }),
    pair(2, { assignee_user_id: "u2", priority: 2 }, { connection_id: "m2", seen_connection_ids: ["m2"], backup_user_id: "u1" }),
    pair(3, { assignee_user_id: "u2" }, { connection_id: "m2", seen_connection_ids: ["m2", "m1"] }),
    pair(4, { assignee_user_id: "u2" }, { connection_id: "m2", seen_connection_ids: ["m2"] }),
    pair(5, { assignee_user_id: "u1", status: "performed", status_category: "done", completed_at: PAST }, { connection_id: "m1", seen_connection_ids: ["m1"], escalation_level: 2 }),
    pair(6, { assignee_user_id: null, status: "awaiting_review" }, { connection_id: "m1", seen_connection_ids: ["m1"], business_status: "not_assessed" }),
  ];
  H.db = createMemoryDb({
    work_items: P.map((p) => p.wi),
    email_actions: P.map((p) => p.ea),
    mailbox_connections: [
      { id: "m1", tenant_id: "t1", owner_user_id: "u1", address: "rep@seller.example" },
      { id: "m2", tenant_id: "t1", owner_user_id: "u2", address: "rep2@seller.example" },
    ],
    tenant_members: ["u1", "u2", "mgr", "adm"].map((u) => ({ tenant_id: "t1", user_id: u, status: "approved" })),
    customers: [{ id: "c1", tenant_id: "t1", customer_name: "Customer One" }, { id: "cx", tenant_id: "t2", customer_name: "Other tenant" }],
    orders: [{ id: "o1", tenant_id: "t1", po_number: "4501" }],
    email_rules: [
      { id: "r1", tenant_id: "t1", scope_user_id: null, kind: "keyword", pattern: "rate contract", effect: {}, active: true, created_at: "1" },
      { id: "r2", tenant_id: "t1", scope_user_id: "u2", kind: "exclusion", pattern: "@noise.example", effect: {}, active: true, created_at: "2" },
    ],
    audit_events: [],
  }, { u1: { id: "u1", email: "u1@seller.example", user_metadata: { name: "Owner One" } } });
};
const as = (id, role = "sales_engineer") => { H.ctx = { tenantId: "t1", user: { id }, role }; };
const ids = (r) => r.body.actions.map((a) => a.id).sort();
const wi = (n) => H.db.tables.work_items.find((w) => w.id === "wi-" + n);
const ea = (n) => H.db.tables.email_actions.find((e) => e.id === "ea-" + n);
const patch = (n, body) => callHandler(byId, { method: "PATCH", query: { id: "ea-" + n }, body: { version: wi(n).version, ...body } });
const audits = () => H.db.tables.audit_events.map((a) => a.action);

beforeEach(seed);

describe("[15] who sees which action", () => {
  it("a user sees what they own, back up, or whose message reached their mailbox", async () => {
    as("u1");
    expect(ids(await callHandler(list, { query: {} }))).toEqual(["ea-1", "ea-2", "ea-3", "ea-6"]);
    as("u2");
    expect(ids(await callHandler(list, { query: {} }))).toEqual(["ea-2", "ea-3", "ea-4"]);
  });

  it("a manager with email.view_all sees every open action; scope=mine narrows to their own", async () => {
    as("mgr", "sales_manager");
    expect(ids(await callHandler(list, { query: {} }))).toEqual(["ea-1", "ea-2", "ea-3", "ea-4", "ea-6"]);
    expect(ids(await callHandler(list, { query: { scope: "mine" } }))).toEqual([]);
  });

  it("another user's action is 404 for read and for change, and nothing changes", async () => {
    as("u1");
    expect((await callHandler(byId, { query: { id: "ea-4" } })).status).toBe(404);
    expect((await patch(4, { status: "in_progress" })).status).toBe(404);
    expect(wi(4).status).toBe("pending");
    as("mgr", "sales_manager");
    expect((await callHandler(byId, { query: { id: "ea-4" } })).status).toBe(200);
  });

  it("viewer and customer_support have no access", async () => {
    as("v1", "viewer");
    expect((await callHandler(list, { query: {} })).status).toBe(403);
    as("cs1", "customer_support");
    expect((await callHandler(byId, { query: { id: "ea-1" } })).status).toBe(403);
  });
});

describe("list filters and row shape", () => {
  it("overdue, priority, owner, mailbox, customer, closed", async () => {
    as("mgr", "sales_manager");
    expect(ids(await callHandler(list, { query: { state: "overdue" } }))).toEqual(["ea-1"]);
    expect(ids(await callHandler(list, { query: { priority: "high" } }))).toEqual(["ea-2"]);
    expect(ids(await callHandler(list, { query: { owner: "none" } }))).toEqual(["ea-6"]);
    expect(ids(await callHandler(list, { query: { mailbox: "m1" } }))).toEqual(["ea-1", "ea-3", "ea-6"]);
    expect(ids(await callHandler(list, { query: { customer: "c1" } }))).toEqual(["ea-1"]);
    expect(ids(await callHandler(list, { query: { state: "closed" } }))).toEqual(["ea-5"]);
    expect(ids(await callHandler(list, { query: { state: "escalated" } }))).toEqual([]);
  });

  it("a row carries names, links and the derived flags; critical comes first", async () => {
    as("u1");
    const r = await callHandler(list, { query: {} });
    expect(r.body.actions[0]).toMatchObject({
      id: "ea-1", priority_label: "critical", overdue: true, escalated: false,
      assignee_name: "Owner One", customer_name: "Customer One", po_number: "4501", mailbox: "rep@seller.example",
    });
  });
});

describe("changes", () => {
  it("the owner starts the work; the version moves and the change is audited", async () => {
    as("u1");
    const r = await patch(1, { status: "in_progress" });
    expect(r.status).toBe(200);
    expect(wi(1)).toMatchObject({ status: "in_progress", status_category: "in_progress", version: 2 });
    expect(audits()).toEqual(["email_action_status"]);
  });

  it("a stale version is 409 and changes nothing", async () => {
    as("u1");
    const r = await callHandler(byId, { method: "PATCH", query: { id: "ea-1" }, body: { version: 7, status: "in_progress", business_status: "resolved" } });
    expect(r.status).toBe(409);
    expect(wi(1).status).toBe("pending");
    expect(ea(1).business_status).toBe("awaiting_internal");
    expect(audits()).toEqual([]);
  });

  it("a write that lands between the read and the update is not overwritten", async () => {
    as("u1");
    const base = H.db.svc;
    H.db.svc = () => {
      const svc = base();
      const from = svc.from;
      svc.from = (t) => {
        const q = from(t);
        if (t === "email_actions") {
          const update = q.update;
          q.update = (p) => { wi(1).version = 9; return update(p); };
        }
        return q;
      };
      return svc;
    };
    const r = await patch(1, { status: "in_progress", business_status: "in_progress" });
    expect(r.status).toBe(409);
    expect(wi(1).status).toBe("pending");
  });

  it("no one marks an action performed or awaiting verification by hand", async () => {
    as("mgr", "sales_manager");
    const r = await patch(1, { status: "performed" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/evidence/);
    expect((await patch(1, { status: "awaiting_verification" })).status).toBe(409);
    expect(wi(1).status).toBe("pending");
  });

  it("cancel needs a reason, and closes the item", async () => {
    as("u1");
    expect((await patch(1, { status: "cancelled" })).status).toBe(400);
    expect((await patch(1, { status: "cancelled", reason: "Handled by phone; no mail needed" })).status).toBe(200);
    expect(wi(1)).toMatchObject({ status: "cancelled", status_category: "cancelled", completed_by: "u1" });
    expect(H.db.tables.audit_events[0].reason).toBe("Handled by phone; no mail needed");
  });

  it("a reopen needs a reason, starts a new cycle and clears the escalation", async () => {
    as("u1");
    expect((await patch(5, { status: "pending" })).status).toBe(400);
    expect((await patch(5, { status: "pending", reason: "The customer wrote again" })).status).toBe(200);
    expect(wi(5)).toMatchObject({ status: "pending", status_category: "todo", completed_at: null });
    expect(ea(5)).toMatchObject({ reopen_count: 1, escalation_level: 0 });
    expect(audits()).toEqual(["email_action_reopened"]);
  });

  it("confirming a reviewed action assigns it to the confirmer and starts the business clock", async () => {
    as("u1");
    expect((await patch(6, { status: "pending" })).status).toBe(200);
    expect(wi(6)).toMatchObject({ status: "pending", assignee_user_id: "u1" });
    expect(ea(6).business_status).toBe("awaiting_internal");
  });

  it("the owner hands off; a backup cannot reassign; a manager can; a non-member cannot own", async () => {
    as("u1");
    expect((await patch(2, { assignee_user_id: "u1" })).status).toBe(403);
    expect((await patch(1, { assignee_user_id: "outsider" })).status).toBe(400);
    expect((await patch(1, { assignee_user_id: "u2" })).status).toBe(200);
    expect(wi(1).assignee_user_id).toBe("u2");
    as("mgr", "sales_manager");
    expect((await patch(4, { assignee_user_id: "u1" })).status).toBe(200);
    expect(wi(4).assignee_user_id).toBe("u1");
    expect(audits()).toEqual(["email_action_reassigned", "email_action_reassigned"]);
  });

  it("a correction needs a reason; the requirement follows the type", async () => {
    as("u1");
    expect((await patch(1, { priority: "normal" })).status).toBe(400);
    expect((await patch(1, { priority: "normal", reason: "Not urgent after a call" })).status).toBe(200);
    expect(wi(1).priority).toBe(3);
    expect((await patch(1, { action_type: "provide_documents", reason: "They need the test report" })).status).toBe(200);
    expect(ea(1)).toMatchObject({ action_type: "provide_documents", requirement: "reply_with_attachment" });
  });

  it("a person sets the business outcome and a manual due time", async () => {
    as("u1");
    expect((await patch(1, { business_status: "resolved" })).status).toBe(200);
    expect(ea(1).business_status).toBe("resolved");
    expect((await patch(1, { due_at: "2026-11-02T10:00:00Z" })).status).toBe(400);
    expect((await patch(1, { due_at: "2026-11-02T10:00:00Z", reason: "The customer moved the date" })).status).toBe(200);
    expect(wi(1)).toMatchObject({ due_at: "2026-11-02T10:00:00.000Z", due_source: "manual" });
  });

  it("GET returns the history of the action", async () => {
    as("u1");
    await patch(1, { status: "in_progress" });
    const r = await callHandler(byId, { query: { id: "ea-1" } });
    expect(r.body.history.map((h) => h.action)).toEqual(["email_action_status"]);
  });
});

describe("/api/email_rules", () => {
  it("a user keeps their own rules; only an admin adds a tenant rule", async () => {
    as("u1");
    expect((await callHandler(rules, { method: "POST", body: { kind: "keyword", pattern: "x" } })).status).toBe(403);
    const mine = await callHandler(rules, { method: "POST", body: { kind: "exclusion", pattern: "@Newsletter.example", scope: "me" } });
    expect(mine.status).toBe(200);
    expect(mine.body.rule).toMatchObject({ scope_user_id: "u1", pattern: "@newsletter.example" });
    as("adm", "admin");
    const t = await callHandler(rules, { method: "POST", body: { kind: "keyword", pattern: "Rate revision", effect: { priority: "critical", action_type: "obtain_approval" } } });
    expect(t.status).toBe(200);
    expect(t.body.rule.scope_user_id).toBeNull();
    expect(audits()).toEqual(["email_rule_added", "email_rule_added"]);
  });

  it("checks the pattern and the effect", async () => {
    as("adm", "admin");
    expect((await callHandler(rules, { method: "POST", body: { kind: "keyword", pattern: "x", effect: { priority: "urgent" } } })).status).toBe(400);
    expect((await callHandler(rules, { method: "POST", body: { kind: "deadline", pattern: "lunch", effect: { due_hours: 4 } } })).status).toBe(400);
    expect((await callHandler(rules, { method: "POST", body: { kind: "customer", pattern: "cx", effect: { priority: "high" } } })).status).toBe(400);
    expect((await callHandler(rules, { method: "POST", body: { kind: "trusted_sender", pattern: "nobody" } })).status).toBe(400);
  });

  it("GET shows tenant rules and the caller's own; another user's rule is 404", async () => {
    as("u1");
    const r = await callHandler(rules, { method: "GET" });
    expect(r.body.rules.map((x) => x.id)).toEqual(["r1"]);
    expect((await callHandler(rules, { method: "PATCH", body: { id: "r2", active: false } })).status).toBe(404);
    expect((await callHandler(rules, { method: "PATCH", body: { id: "r1", active: false } })).status).toBe(403);
    as("u2");
    expect((await callHandler(rules, { method: "DELETE", query: { id: "r2" } })).status).toBe(200);
    expect(H.db.tables.email_rules.map((x) => x.id)).toEqual(["r1"]);
  });
});

describe("the email actions are registered on both sides", () => {
  it("SERVER_ACTIONS and rbac.ts ACTIONS agree, and a sales engineer holds none of them", () => {
    for (const k of ["email.view_all", "email.reassign", "email.verify", "email.rules"]) {
      expect(SERVER_ACTIONS[k]).toBeInstanceOf(Set);
      expect([...SERVER_ACTIONS[k]].sort()).toEqual([...ACTIONS[k]].sort());
      expect(hasAction({ role: "sales_engineer" }, k)).toBe(false);
    }
    expect([...SERVER_ACTIONS["email.rules"]]).toEqual(["admin"]);
  });
});
