// notify(): one bell row per recipient (migration 253, C-17).
//
// A role expands to its APPROVED members of this tenant, and each gets a row
// with recipient_user_id set. A user id that is not an approved member of
// the tenant gets nothing. Before migration 253 the insert fails on the
// missing column, and notify skips: it never writes the notice as a
// broadcast row. notifyAdmins keeps writing one broadcast row. Invented
// fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { notify, notifyAdmins } from "../api/_lib/notifications.js";

// A PostgREST stand-in. With `noRecipientColumn`, an insert that names
// recipient_user_id fails like PostgREST does before migration 253.
const makeSvc = (store, { noRecipientColumn = false } = {}) => ({
  inserts: [],
  from(table) {
    const svc = this;
    store[table] = store[table] || [];
    const q = {
      _op: "select", _filters: [], _payload: null, _head: false, _count: null,
      select(_cols, opts = {}) { this._head = !!opts.head; this._count = opts.count || null; return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      eq(col, val) {
        const [c, key] = col.split("->>");
        this._filters.push((r) => (key ? (r[c] || {})[key] : r[c]) === val);
        return this;
      },
      in(col, arr) { this._filters.push((r) => arr.includes(r[col])); return this; },
      gte(col, val) { this._filters.push((r) => String(r[col]) >= String(val)); return this; },
      _exec() {
        if (this._op === "insert") {
          const items = Array.isArray(this._payload) ? this._payload : [this._payload];
          svc.inserts.push(items);
          if (noRecipientColumn && items.some((it) => "recipient_user_id" in it)) {
            return Promise.resolve({ data: null, error: { code: "PGRST204", message: "Could not find the 'recipient_user_id' column of 'admin_notifications' in the schema cache" } });
          }
          for (const it of items) store[table].push({ id: "n-" + (store[table].length + 1), resolved: false, created_at: new Date().toISOString(), ...it });
          return Promise.resolve({ data: null, error: null });
        }
        const hit = store[table].filter((r) => this._filters.every((f) => f(r)));
        return Promise.resolve({ data: this._head ? null : hit, count: this._count ? hit.length : null, error: null });
      },
      then(resolve, reject) { return this._exec().then(resolve, reject); },
    };
    return q;
  },
});

let store;
const payload = { kind: "so_sent_for_approval", title: "Order sent for approval", body: "Order 81 needs a decision" };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  store = {
    tenant_members: [
      { tenant_id: "t-1", user_id: "u-mgr-1", role: "sales_manager", status: "approved" },
      { tenant_id: "t-1", user_id: "u-mgr-2", role: "sales_manager", status: "approved" },
      { tenant_id: "t-1", user_id: "u-mgr-pending", role: "sales_manager", status: "pending" },
      { tenant_id: "t-1", user_id: "u-mgr-gone", role: "sales_manager", status: "deactivated" },
      { tenant_id: "t-1", user_id: "u-eng", role: "sales_engineer", status: "approved" },
      { tenant_id: "t-1", user_id: "u-admin", role: "admin", status: "approved" },
      { tenant_id: "t-2", user_id: "u-mgr-other", role: "sales_manager", status: "approved" },
    ],
    admin_notifications: [],
  };
});

describe("notify(roles)", () => {
  it("writes one row per approved member of the role in this tenant", async () => {
    const out = await notify(makeSvc(store), "t-1", payload, { roles: ["sales_manager"] });
    expect(out).toEqual({ notified: 2 });
    const rows = store.admin_notifications;
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual(["u-mgr-1", "u-mgr-2"]);
    expect(rows.every((r) => r.tenant_id === "t-1" && r.kind === payload.kind && r.title === payload.title)).toBe(true);
  });

  it("gives each person one row when a user is named and also holds the role", async () => {
    const out = await notify(makeSvc(store), "t-1", payload, { roles: ["sales_manager"], users: ["u-mgr-1", "u-eng"] });
    expect(out).toEqual({ notified: 3 });
    expect(store.admin_notifications.map((r) => r.recipient_user_id).sort()).toEqual(["u-eng", "u-mgr-1", "u-mgr-2"]);
  });
});

describe("notify(users)", () => {
  it("writes a row for a named approved member only", async () => {
    const out = await notify(makeSvc(store), "t-1", payload, { users: ["u-eng"] });
    expect(out).toEqual({ notified: 1 });
    expect(store.admin_notifications).toHaveLength(1);
    expect(store.admin_notifications[0].recipient_user_id).toBe("u-eng");
  });

  it("writes nothing for a pending member or a member of another tenant", async () => {
    const out = await notify(makeSvc(store), "t-1", payload, { users: ["u-mgr-pending", "u-mgr-other"] });
    expect(out).toEqual({ notified: 0 });
    expect(store.admin_notifications).toHaveLength(0);
  });

  it("writes nothing when no recipient is named", async () => {
    const out = await notify(makeSvc(store), "t-1", payload, {});
    expect(out).toEqual({ notified: 0 });
    expect(store.admin_notifications).toHaveLength(0);
  });
});

describe("before migration 253 (no recipient_user_id column)", () => {
  it("skips the notice and never writes it as a broadcast row", async () => {
    const svc = makeSvc(store, { noRecipientColumn: true });
    const out = await notify(svc, "t-1", payload, { roles: ["sales_manager"] });
    expect(out).toEqual({ notified: 0, skipped: "migration_253_not_applied" });
    expect(store.admin_notifications).toHaveLength(0);
    // One attempt, and every row it sent carried a recipient. No retry
    // dropped the column.
    expect(svc.inserts).toHaveLength(1);
    expect(svc.inserts[0].every((r) => typeof r.recipient_user_id === "string")).toBe(true);
  });

  it("still lets notifyAdmins write its broadcast row", async () => {
    const out = await notifyAdmins(makeSvc(store, { noRecipientColumn: true }), "t-1", payload);
    expect(out).toEqual({ notified: 1 });
    expect(store.admin_notifications).toHaveLength(1);
  });
});

describe("notifyAdmins keeps its meaning", () => {
  it("writes one broadcast row with no recipient", async () => {
    const out = await notifyAdmins(makeSvc(store), "t-1", payload, { roles: ["admin", "sales_manager"] });
    expect(out).toEqual({ notified: 1 });
    expect(store.admin_notifications).toHaveLength(1);
    expect(store.admin_notifications[0].recipient_user_id).toBeUndefined();
  });
});
