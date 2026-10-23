// EA-6: reminders and escalation. Request tests [10] an overdue item
// escalates per policy, [12] repeated scheduler runs do not duplicate
// reminders. Plus timezones and business hours, reassignment, reopen, an owner
// who left, retries, the per-run cap, policy overrides, and the policy API.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null }));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));

let runSweep, noticesFor, tenantPolicy, policyFor, policyErrors, policyApi, notify, addBusinessMinutes;
beforeAll(async () => {
  ({ runSweep, noticesFor } = await import("../api/_lib/email-accountability/escalation.js"));
  ({ tenantPolicy, policyFor, policyErrors } = await import("../api/_lib/email-accountability/policy.js"));
  ({ notify } = await import("../api/_lib/notifications.js"));
  ({ addBusinessMinutes } = await import("../api/_lib/email-accountability/business-time.js"));
  policyApi = (await import("../api/email/policy.js")).default;
});

// Thursday 2026-10-22 12:00 in India.
const NOW = new Date("2026-10-22T06:30:00Z");
const T = NOW.getTime();
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

const pair = (extra = {}, ea = {}) => ({
  wi: {
    id: "wi-1", tenant_id: "t1", subject_type: "email_action", title: "Investigate: Legal notice on PO 4501",
    status: "in_progress", status_category: "in_progress", priority: 1, assignee_user_id: "u1", version: 1,
    created_at: iso(T - 3 * HOUR), due_at: iso(T - 2 * HOUR), ...extra,
  },
  ea: {
    id: "ea-1", tenant_id: "t1", work_item_id: "wi-1", action_type: "investigate", connection_id: "m1",
    backup_user_id: "u3", reopen_count: 0, escalation_level: 0, from_address: "buyer@customer.example", ...ea,
  },
});

const seed = ({ mode = "create", policy = {}, pairs = [pair()], members = ["u1", "u2", "u3", "mgr", "adm", "fin"] } = {}) => {
  const roles = { mgr: "sales_manager", adm: "admin", fin: "finance" };
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: "t1", email_accountability_enabled: true, email_actions_mode: mode, email_policy: policy }],
    work_items: pairs.map((p) => p.wi),
    email_actions: pairs.map((p) => p.ea),
    tenant_members: members.map((u) => ({ tenant_id: "t1", user_id: u, role: roles[u] || "sales_engineer", status: "approved" })),
    email_action_notices: [],
    admin_notifications: [],
    audit_events: [],
  });
};

const sends = [];
const fakeSend = async (svc, tenantId, payload, opts) => { sends.push({ payload, opts }); return { notified: (opts.users?.length || 0) + (opts.roles?.length || 0) }; };
const sweep = (now = NOW, send = fakeSend) => runSweep(H.db.svc(), { now, send });
const keys = () => H.db.tables.email_action_notices.map((n) => n.notice_key).sort();

beforeEach(() => { sends.length = 0; seed(); });

describe("[10] an overdue item escalates per policy", () => {
  it("critical, 2 h overdue: the owner, the backup and sales_manager are told; level 1", async () => {
    const out = await sweep();
    expect(out.results[0]).toMatchObject({ sent: 3, failed: 0 });
    const byKind = Object.fromEntries(sends.map((s) => [s.payload.kind, s]));
    expect(byKind.email_action_created.opts).toEqual({ users: ["u1"], roles: [] });
    expect(byKind.email_action_overdue.opts).toEqual({ users: ["u1"], roles: [] });
    expect(byKind.email_action_escalation.opts).toEqual({ users: ["u3"], roles: ["sales_manager"] });
    expect(H.db.tables.email_actions[0].escalation_level).toBe(1);
    expect(H.db.tables.audit_events.map((a) => a.action).sort()).toEqual(["email_action_escalated", "email_action_overdue_notice"]);
  });

  it("the ladder climbs with time: level 2 after a day, admin at level 3 after two", async () => {
    await sweep();
    await sweep(new Date(NOW.getTime() + 25 * HOUR));
    expect(H.db.tables.email_actions[0].escalation_level).toBe(2);
    sends.length = 0;
    await sweep(new Date(NOW.getTime() + 49 * HOUR));
    expect(H.db.tables.email_actions[0].escalation_level).toBe(3);
    expect(sends.find((s) => s.payload.kind === "email_action_escalation").opts.roles).toEqual(["admin"]);
  });

  it("an escalation names no mail subject; a notice to the owner does", async () => {
    await sweep();
    const esc = sends.find((s) => s.payload.kind === "email_action_escalation").payload;
    expect(esc.title).not.toMatch(/Legal notice/);
    expect(esc.body).toBeNull();
    expect(sends.find((s) => s.payload.kind === "email_action_overdue").payload.title).toMatch(/Legal notice/);
    expect(esc).toMatchObject({ link_route: "email_actions", link_params: { id: "ea-1" }, object_id: "ea-1" });
  });

  it("an owner who left the tenant: the backup and the policy roles are told instead", async () => {
    seed({ members: ["u3", "mgr"] });
    await sweep();
    const overdue = sends.find((s) => s.payload.kind === "email_action_overdue");
    expect(overdue.opts).toEqual({ users: ["u3"], roles: ["sales_manager"] });
  });

  it("a policy override by action type sends payment escalations to finance", async () => {
    const policy = { overrides: [{ match: { action_type: "confirm_payment" }, set: { escalation: { critical: [{ after_minutes: 0, roles: ["finance"] }] } } }] };
    seed({ policy, pairs: [pair({}, { action_type: "confirm_payment" })] });
    await sweep();
    expect(sends.find((s) => s.payload.kind === "email_action_escalation").opts.roles).toEqual(["finance"]);
  });

  it("performed, cancelled and informational items get nothing", async () => {
    seed({ pairs: [
      pair({ id: "wi-1", status: "performed", status_category: "done" }),
      pair({ id: "wi-2", status: "cancelled", status_category: "cancelled" }, { id: "ea-2", work_item_id: "wi-2" }),
      pair({ id: "wi-3", priority: 4 }, { id: "ea-3", work_item_id: "wi-3" }),
    ] });
    await sweep();
    expect(sends).toHaveLength(0);
  });
});

describe("[12] repeated runs do not duplicate reminders", () => {
  it("a second and a third sweep at the same time send nothing", async () => {
    await sweep();
    const first = keys();
    await sweep();
    await sweep(new Date(NOW.getTime() + 60_000));
    expect(sends).toHaveLength(3);
    expect(keys()).toEqual(first);
  });

  it("a notice another sweep claimed first is not sent again", async () => {
    H.db.tables.email_action_notices.push({ id: "n0", tenant_id: "t1", email_action_id: "ea-1", notice_key: "created:0:u1", status: "claimed", attempts: 0 });
    await sweep();
    expect(sends.map((s) => s.payload.kind)).not.toContain("email_action_created");
  });

  it("a failed send is retried on later sweeps, at most 3 attempts", async () => {
    const down = async () => ({ notified: 0, error: "insert failed" });
    await sweep(NOW, down);
    await sweep(NOW, down);
    await sweep(NOW, down);
    await sweep(NOW, fakeSend);
    expect(sends).toHaveLength(0);
    expect(H.db.tables.email_action_notices.every((n) => n.status === "failed" && n.attempts === 3)).toBe(true);
  });

  it("a send that recovers within 3 attempts is marked sent once", async () => {
    await sweep(NOW, async () => ({ notified: 0, skipped: "migration_253_not_applied" }));
    await sweep();
    await sweep();
    expect(sends).toHaveLength(3);
    expect(H.db.tables.email_action_notices.every((n) => n.status === "sent" && n.attempts === 2)).toBe(true);
  });

  it("the per-run cap holds the rest for the next sweep", async () => {
    seed({ policy: { max_notices_per_run: 2 } });
    const out = await sweep();
    expect(out.results[0]).toMatchObject({ sent: 2, waiting: 1 });
    await sweep();
    expect(sends).toHaveLength(3);
  });
});

describe("changes re-arm only what they should", () => {
  it("a new owner gets the owner notices; the escalation is not sent again", async () => {
    await sweep();
    H.db.tables.work_items[0].assignee_user_id = "u2";
    sends.length = 0;
    await sweep();
    expect(sends.map((s) => s.payload.kind).sort()).toEqual(["email_action_created", "email_action_overdue"]);
    expect(sends.every((s) => s.opts.users[0] === "u2")).toBe(true);
  });

  it("a new due time re-arms the overdue ladder", async () => {
    await sweep();
    Object.assign(H.db.tables.work_items[0], { due_at: iso(NOW.getTime() + 1 * HOUR) });
    sends.length = 0;
    await sweep();
    expect(sends.map((s) => s.payload.kind)).toEqual(["email_action_due_soon"]);
    sends.length = 0;
    await sweep(new Date(NOW.getTime() + 2 * HOUR));
    expect(sends.map((s) => s.payload.kind).sort()).toEqual(["email_action_escalation", "email_action_overdue"]);
  });

  it("a reopen starts a new cycle", async () => {
    await sweep();
    H.db.tables.email_actions[0].reopen_count = 1;
    sends.length = 0;
    await sweep();
    expect(sends).toHaveLength(3);
  });

  it("observe mode sends nothing", async () => {
    seed({ mode: "observe" });
    const out = await sweep();
    expect(out.tenants).toBe(0);
    expect(sends).toHaveLength(0);
  });
});

describe("reminders before the due time, in business hours", () => {
  const P = () => tenantPolicy({});
  const at = (wi, ea = {}, now = NOW) => noticesFor({ ...pair(wi, ea), ownerActive: true }, P(), now.getTime()).map((n) => n.kind);

  it("not started after the acknowledgement time: one reminder; started: none", () => {
    expect(at({ priority: 2, status: "pending", status_category: "todo", created_at: iso(T - 24 * HOUR), due_at: iso(T + 48 * HOUR) })).toEqual(["ack"]);
    expect(at({ priority: 2, status: "in_progress", status_category: "in_progress", created_at: iso(T - 5 * HOUR), due_at: iso(T + 48 * HOUR) })).toEqual([]);
  });

  it("acknowledgement time counts business hours: made Friday 17:00, due for the reminder Monday", () => {
    const fri = new Date("2026-10-23T11:30:00Z");
    const wi = { priority: 2, status: "pending", status_category: "todo", created_at: fri.toISOString(), due_at: iso(fri.getTime() + 96 * HOUR) };
    expect(at(wi, {}, new Date("2026-10-24T05:00:00Z"))).toEqual([]);
    expect(at(wi, {}, new Date("2026-10-26T08:00:00Z"))).toEqual(["ack"]);
  });

  it("due soon: inside the reminder window only", () => {
    expect(at({ priority: 2, status: "in_progress", status_category: "in_progress", created_at: iso(T - HOUR), due_at: iso(T + HOUR) })).toEqual(["due_soon"]);
    expect(at({ priority: 2, status: "in_progress", status_category: "in_progress", created_at: iso(T - HOUR), due_at: iso(T + 5 * HOUR) })).toEqual([]);
  });

  it("a closed item is due nothing, even overdue", () => {
    expect(at({ status: "performed", status_category: "done" })).toEqual([]);
    expect(at({ status: "cancelled", status_category: "cancelled" })).toEqual([]);
  });

  it("a tenant that works on Saturday counts Saturday", () => {
    const sat = new Date("2026-10-24T05:00:00Z");
    expect(addBusinessMinutes(sat, 60, "Asia/Kolkata", { start: "09:30", end: "17:30", weekend: ["Sun"] }).toISOString()).toBe("2026-10-24T06:00:00.000Z");
  });
});

describe("the real notify(): one bell row per person", () => {
  it("users and role members each get their own row", async () => {
    await sweep(NOW, notify);
    const rows = H.db.tables.admin_notifications.filter((r) => r.kind === "email_action_escalation");
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual(["mgr", "u3"]);
    expect(H.db.tables.email_action_notices.every((n) => n.status === "sent")).toBe(true);
  });
});

describe("the policy", () => {
  it("overlays the defaults key by key, and an override applies by match", () => {
    const p = tenantPolicy({ due_minutes: { high: 120 }, business_hours: { weekend: ["Sun"] } });
    expect(p.due_minutes).toEqual({ critical: 240, high: 120, normal: 960 });
    expect(p.business_hours).toEqual({ start: "09:30", end: "17:30", weekend: ["Sun"] });
    const q = policyFor(tenantPolicy({ overrides: [{ match: { priority: "high" }, set: { due_minutes: { high: 30 } } }] }), { priority: "high" });
    expect(q.due_minutes.high).toBe(30);
  });

  it("refuses an unknown key, a bad time, a bad role and a ladder that does not grow", () => {
    expect(policyErrors({ cadence: 1 })).toContain("cadence is not a policy key");
    expect(policyErrors({ business_hours: { start: "18:00", end: "09:00" } }).join()).toMatch(/before end/);
    expect(policyErrors({ timezone: "Mars/Base" }).join()).toMatch(/timezone/);
    expect(policyErrors({ escalation: { high: [{ after_minutes: 60, roles: ["boss"] }] } }).join()).toMatch(/known roles/);
    expect(policyErrors({ escalation: { high: [{ after_minutes: 60 }, { after_minutes: 30 }] } }).join()).toMatch(/grow/);
    expect(policyErrors({ business_hours: { weekend: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] } }).join()).toMatch(/work day/);
    expect(policyErrors({ due_minutes: { high: 120 } })).toEqual([]);
  });

  it("GET shows the effective policy; only an admin may PUT; a bad policy is 400", async () => {
    H.ctx = { tenantId: "t1", user: { id: "u1" }, role: "sales_engineer" };
    const g = await callHandler(policyApi, { method: "GET" });
    expect(g.body.effective.due_minutes.critical).toBe(240);
    expect((await callHandler(policyApi, { method: "PUT", body: { policy: {} } })).status).toBe(403);
    H.ctx = { tenantId: "t1", user: { id: "adm" }, role: "admin" };
    const badPut = await callHandler(policyApi, { method: "PUT", body: { policy: { due_minutes: { high: -5 } } } });
    expect(badPut.status).toBe(400);
    expect(badPut.body.error.errors.length).toBeGreaterThan(0);
    const ok = await callHandler(policyApi, { method: "PUT", body: { policy: { business_hours: { weekend: ["Sun"] } } } });
    expect(ok.status).toBe(200);
    expect(H.db.tables.tenant_settings[0].email_policy).toEqual({ business_hours: { weekend: ["Sun"] } });
    expect(H.db.tables.audit_events[0]).toMatchObject({ action: "email_policy_changed" });
  });
});
