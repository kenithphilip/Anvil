// Logistics and inventory alert emails are addressed, or not written at all.
//
// Both dispatchers queued their alert email with no recipient: the row had
// no to_addr, so the agents/run reaper could only fail it ("no recipient").
// Now the recipients come from the same roles the bell goes to, through
// resolveInternalRecipients (approved members of this tenant with an email).
// When nobody resolves, no row is written and the exception records why, so
// it leaves the work query instead of being retried on every tick.
//
// Runs the real dispatchers, notifyAdmins and the real resolver. Only the
// database and the auth user lookup are faked. Invented fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dispatchLogisticsNotifications } from "../api/_lib/logistics/notifications.js";
import { dispatchNotifications } from "../api/_lib/inventory/notifications.js";

let store;
let seq;
let users;
let getUserById;

// In-memory PostgREST stand-in. The JSON-path filters the logistics query
// uses (or / filter) do not narrow here; fixtures are built so they need not.
const makeSvc = () => ({
  from(table) {
    const rows = () => (store[table] = store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      in(c, vs) { this._f.push((r) => vs.includes(r[c])); return this; },
      not(c, op, v) { if (op === "is" && v === null) this._f.push((r) => r[c] != null); return this; },
      or() { return this; },
      filter() { return this; },
      gte() { return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      update(p) { this._op = "update"; this._payload = p; return this; },
      _run() {
        if (this._op === "insert") {
          return (Array.isArray(this._payload) ? this._payload : [this._payload]).map((p) => {
            seq += 1;
            const created = { id: table + "-" + seq, ...p };
            rows().push(created);
            return created;
          });
        }
        const hit = rows().filter((r) => this._f.every((fn) => fn(r)));
        if (this._op === "update") for (const r of hit) Object.assign(r, this._payload);
        return hit;
      },
      single() { const d = this._run(); return Promise.resolve({ data: d[0] || null, error: d[0] ? null : { message: "no rows" } }); },
      maybeSingle() { const d = this._run(); return Promise.resolve({ data: d[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: this._run(), error: null }).then(res, rej); },
    };
    return q;
  },
  auth: { admin: { getUserById: (id) => getUserById(id) } },
});

const member = (user_id, role, status = "approved") => ({ tenant_id: "t-1", user_id, role, status });
const comms = () => store.communications || [];

beforeEach(() => {
  seq = 0;
  users = {
    "u-proc": { email: "Proc.Lead@seller.test" },
    "u-admin": { email: "admin@seller.test" },
    "u-noemail": { email: null },
  };
  getUserById = vi.fn(async (id) => ({ data: { user: users[id] ? { id, ...users[id], user_metadata: {} } : null } }));
  store = {
    logistics_monitor_rules: [],
    tenant_members: [],
    admin_notifications: [],
    communications: [],
    logistics_exceptions: [],
    inventory_exceptions: [],
    tenant_settings: [],
  };
});

const logisticsException = (id) => ({
  id, tenant_id: "t-1", status: "open", severity: "bad", rule_kind: "po_source_country",
  ref_label: "PO 4411", breached_at: null, detail: {}, created_at: "2026-10-15T09:00:00Z",
});

describe("logistics alert email", () => {
  it("is addressed to the approved members of the bell's roles, To the first and CC the rest", async () => {
    store.tenant_members = [member("u-proc", "procurement"), member("u-admin", "admin")];
    store.logistics_exceptions = [logisticsException("lx-1")];
    const out = await dispatchLogisticsNotifications(makeSvc(), "t-1");

    expect(out.emailQueued).toBe(1);
    expect(out.emailSkipped).toBe(0);
    expect(comms()).toHaveLength(1);
    expect(comms()[0]).toMatchObject({
      tenant_id: "t-1", status: "queued", channel: "email", template_code: "logistics_alert",
      object_type: "logistics_exception", object_id: "lx-1",
      to_addr: "proc.lead@seller.test", cc_addrs: ["admin@seller.test"],
    });
    expect(store.logistics_exceptions[0].detail.notified.email_at).toBeTruthy();
    expect(store.logistics_exceptions[0].detail.notified.email_skipped).toBeUndefined();
  });

  it("follows the rule's escalate_roles", async () => {
    store.logistics_monitor_rules = [{ tenant_id: "t-1", rule_kind: "po_source_country", escalate_roles: ["admin"] }];
    store.tenant_members = [member("u-proc", "procurement"), member("u-admin", "admin")];
    store.logistics_exceptions = [logisticsException("lx-1")];
    await dispatchLogisticsNotifications(makeSvc(), "t-1");
    expect(comms()[0]).toMatchObject({ to_addr: "admin@seller.test", cc_addrs: [] });
  });

  it("writes no row when nobody resolves, and records why on the exception", async () => {
    // A pending procurement member and an admin with no email: no address.
    store.tenant_members = [member("u-proc", "procurement", "pending"), member("u-noemail", "admin")];
    store.logistics_exceptions = [logisticsException("lx-1")];
    const out = await dispatchLogisticsNotifications(makeSvc(), "t-1");

    expect(comms()).toEqual([]);
    expect(out.emailQueued).toBe(0);
    expect(out.emailSkipped).toBe(1);
    const notified = store.logistics_exceptions[0].detail.notified;
    expect(notified.email_skipped).toBe("no_recipients");
    expect(notified.email_at).toBeTruthy();
  });

  it("resolves the recipients once per run, not once per exception", async () => {
    store.tenant_members = [member("u-proc", "procurement"), member("u-admin", "admin")];
    store.logistics_exceptions = [logisticsException("lx-1"), logisticsException("lx-2"), logisticsException("lx-3")];
    await dispatchLogisticsNotifications(makeSvc(), "t-1");
    expect(comms()).toHaveLength(3);
    expect(comms().every((c) => c.to_addr === "proc.lead@seller.test")).toBe(true);
    expect(getUserById).toHaveBeenCalledTimes(2);
  });
});

const inventoryException = (id) => ({
  id, tenant_id: "t-1", status: "open", severity: "bad", exception_kind: "below_reorder_point",
  part_no: "NZ-100", detail: { fingerprint: "fp-" + id },
});

describe("inventory alert email", () => {
  it("is addressed to the tenant's approved admins, the bell's audience", async () => {
    store.tenant_members = [member("u-proc", "procurement"), member("u-admin", "admin")];
    store.inventory_exceptions = [inventoryException("ix-1")];
    const out = await dispatchNotifications(makeSvc(), "t-1");

    expect(out.emailQueued).toBe(1);
    expect(comms()).toHaveLength(1);
    expect(comms()[0]).toMatchObject({
      tenant_id: "t-1", status: "queued", template_code: "inventory_alert",
      object_id: "ix-1", to_addr: "admin@seller.test", cc_addrs: [],
    });
  });

  it("writes no row when no admin has an address, and records why", async () => {
    store.tenant_members = [member("u-proc", "procurement"), member("u-noemail", "admin")];
    store.inventory_exceptions = [inventoryException("ix-1")];
    const out = await dispatchNotifications(makeSvc(), "t-1");

    expect(comms()).toEqual([]);
    expect(out.emailQueued).toBe(0);
    expect(out.emailSkipped).toBe(1);
    expect(store.inventory_exceptions[0].detail.notified.email_skipped).toBe("no_recipients");
  });

  it("with two admins, goes To the first and CC the second", async () => {
    users["u-admin2"] = { email: "Second.Admin@seller.test" };
    store.tenant_members = [member("u-admin", "admin"), member("u-admin2", "admin"), member("u-proc", "procurement")];
    store.inventory_exceptions = [inventoryException("ix-1")];
    await dispatchNotifications(makeSvc(), "t-1");

    expect(comms()).toHaveLength(1);
    expect(comms()[0].to_addr).toBe("admin@seller.test");
    expect(comms()[0].cc_addrs).toEqual(["second.admin@seller.test"]);
  });
});

// The alert email had no backlog control once it was addressed: each
// exception queued its own email to every member of the alert roles.
describe("alert email volume", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const alreadyBelled = (id) => ({ ...logisticsException(id), detail: { notified: { bell_at: "2026-10-15T09:01:00Z" } } });

  it("a logistics backlog that the digest belled sends no per-exception email", async () => {
    store.tenant_members = [member("u-proc", "procurement"), member("u-admin", "admin")];
    // More first-time exceptions than the digest threshold (10).
    store.logistics_exceptions = Array.from({ length: 12 }, (_, i) => logisticsException("lx-" + i));
    const out = await dispatchLogisticsNotifications(makeSvc(), "t-1");

    expect(out.digested).toBe(12);
    expect(store.admin_notifications.filter((n) => n.kind === "logistics_exception_digest")).toHaveLength(1);
    expect(comms()).toEqual([]);
    expect(out.emailQueued).toBe(0);
    for (const e of store.logistics_exceptions) {
      expect(e.detail.notified).toMatchObject({ via: "digest", email_skipped: "digested" });
      expect(e.detail.notified.email_at).toBeTruthy();
    }
  });

  it("logistics sends at most the per-run cap and leaves the rest for the next run, unstamped", async () => {
    vi.stubEnv("LOGISTICS_MAX_ALERT_EMAILS_PER_RUN", "2");
    store.tenant_members = [member("u-admin", "admin")];
    store.logistics_exceptions = [alreadyBelled("lx-1"), alreadyBelled("lx-2"), alreadyBelled("lx-3")];
    const out = await dispatchLogisticsNotifications(makeSvc(), "t-1");

    expect(out.emailQueued).toBe(2);
    expect(comms().map((c) => c.object_id)).toEqual(["lx-1", "lx-2"]);
    expect(store.logistics_exceptions[2].detail.notified.email_at).toBeUndefined();

    // The next run sends the one that waited.
    const next = await dispatchLogisticsNotifications(makeSvc(), "t-1");
    expect(next.emailQueued).toBe(1);
    expect(comms().map((c) => c.object_id)).toEqual(["lx-1", "lx-2", "lx-3"]);
  });

  it("logistics stops at the per-day cap and stamps the exception daily_cap, so it leaves the query", async () => {
    vi.stubEnv("LOGISTICS_MAX_ALERT_EMAILS_PER_DAY", "2");
    store.tenant_members = [member("u-admin", "admin")];
    // Two alert emails already queued today.
    store.communications = [
      { id: "old-1", tenant_id: "t-1", template_code: "logistics_alert", status: "sent" },
      { id: "old-2", tenant_id: "t-1", template_code: "logistics_alert", status: "queued" },
      // Another tenant's and another template's rows do not count.
      { id: "other-t", tenant_id: "t-2", template_code: "logistics_alert", status: "sent" },
      { id: "other-k", tenant_id: "t-1", template_code: "inventory_alert", status: "sent" },
    ];
    store.logistics_exceptions = [alreadyBelled("lx-1")];
    const out = await dispatchLogisticsNotifications(makeSvc(), "t-1");

    expect(out.emailQueued).toBe(0);
    expect(out.emailCapped).toBe(1);
    expect(comms()).toHaveLength(4);
    expect(store.logistics_exceptions[0].detail.notified).toMatchObject({ email_skipped: "daily_cap" });
    expect(store.logistics_exceptions[0].detail.notified.email_at).toBeTruthy();
  });

  it("inventory sends at most the per-run cap; past the per-day cap it stamps daily_cap", async () => {
    vi.stubEnv("INVENTORY_MAX_ALERT_EMAILS_PER_RUN", "2");
    vi.stubEnv("INVENTORY_MAX_ALERT_EMAILS_PER_DAY", "3");
    store.tenant_members = [member("u-admin", "admin")];
    store.inventory_exceptions = ["ix-1", "ix-2", "ix-3", "ix-4"].map(inventoryException);

    const first = await dispatchNotifications(makeSvc(), "t-1");
    expect(first.emailQueued).toBe(2);
    expect(store.inventory_exceptions.filter((e) => e.detail.notified.email_at)).toHaveLength(2);

    // Second run: one left for today, then the cap.
    const second = await dispatchNotifications(makeSvc(), "t-1");
    expect(second.emailQueued).toBe(1);
    expect(second.emailCapped).toBe(1);
    expect(comms().filter((c) => c.template_code === "inventory_alert")).toHaveLength(3);
    const capped = store.inventory_exceptions.filter((e) => e.detail.notified.email_skipped === "daily_cap");
    expect(capped.map((e) => e.id)).toEqual(["ix-4"]);
    // The capped exception still rang the bell.
    expect(capped[0].detail.notified.bell_at).toBeTruthy();
  });
});
