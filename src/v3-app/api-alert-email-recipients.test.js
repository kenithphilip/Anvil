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

import { describe, it, expect, beforeEach, vi } from "vitest";
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
});
