// notifyAdmins: a repeated dedupKey inside five minutes inserts no second row.
//
// The dedup never fired. Its lookup was a head:true count, which PostgREST
// answers with a count and NO rows, and the guard read the rows, so it always
// saw none and inserted again. It also matched on kind alone, never the key.
//
// The stand-in below behaves like PostgREST on the points that matter:
// select(..., { head: true }) returns data null plus the count, and a
// `col->>key` filter reads a jsonb field. Invented fixtures.

import { describe, it, expect, beforeEach } from "vitest";
import { notifyAdmins } from "../api/_lib/notifications.js";

const makeSvc = (store) => ({
  from(table) {
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
      limit() { return this; },
      _exec() {
        if (this._op === "insert") {
          const items = Array.isArray(this._payload) ? this._payload : [this._payload];
          for (const it of items) store[table].push({ id: "n-" + (store[table].length + 1), resolved: false, created_at: new Date().toISOString(), ...it });
          return Promise.resolve({ data: null, error: null });
        }
        const hit = store[table].filter((r) => this._filters.every((f) => f(r)));
        return Promise.resolve({
          data: this._head ? null : hit,
          count: this._count ? hit.length : null,
          error: null,
        });
      },
      then(resolve, reject) { return this._exec().then(resolve, reject); },
    };
    return q;
  },
});

let store;
let svc;
const payload = (extra = {}) => ({ kind: "push_failed", title: "Push to ERP failed", body: "Order 81 was rejected", ...extra });
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  store = {
    tenant_members: [
      { tenant_id: "t-1", user_id: "u-admin", role: "admin", status: "approved" },
      { tenant_id: "t-2", user_id: "u-admin2", role: "admin", status: "approved" },
    ],
    admin_notifications: [],
  };
  svc = makeSvc(store);
});

describe("the stand-in answers head:true like PostgREST", () => {
  it("returns a count and no rows", async () => {
    store.admin_notifications.push({ id: "x", tenant_id: "t-1" });
    const out = await svc.from("admin_notifications").select("id", { count: "exact", head: true }).eq("tenant_id", "t-1");
    expect(out.data).toBeNull();
    expect(out.count).toBe(1);
  });
});

describe("notifyAdmins dedupKey", () => {
  it("does not insert a repeated key inside the window", async () => {
    const first = await notifyAdmins(svc, "t-1", payload(), { dedupKey: "erp:ord-81" });
    const second = await notifyAdmins(svc, "t-1", payload(), { dedupKey: "erp:ord-81" });
    expect(first).toEqual({ notified: 1 });
    expect(second).toEqual({ notified: 0, deduped: true });
    expect(store.admin_notifications).toHaveLength(1);
  });

  it("still notifies a different key of the same kind", async () => {
    await notifyAdmins(svc, "t-1", payload(), { dedupKey: "erp:ord-81" });
    const other = await notifyAdmins(svc, "t-1", payload({ body: "Order 82 was rejected" }), { dedupKey: "erp:ord-82" });
    expect(other).toEqual({ notified: 1 });
    expect(store.admin_notifications).toHaveLength(2);
  });

  it("notifies again once the five-minute window has passed", async () => {
    store.admin_notifications.push({
      id: "old", tenant_id: "t-1", kind: "push_failed", resolved: false,
      created_at: minutesAgo(6), link_params: { dedup_key: "erp:ord-81" },
    });
    const out = await notifyAdmins(svc, "t-1", payload(), { dedupKey: "erp:ord-81" });
    expect(out).toEqual({ notified: 1 });
    expect(store.admin_notifications).toHaveLength(2);
  });

  it("notifies again when the earlier row was resolved", async () => {
    store.admin_notifications.push({
      id: "done", tenant_id: "t-1", kind: "push_failed", resolved: true,
      created_at: minutesAgo(1), link_params: { dedup_key: "erp:ord-81" },
    });
    const out = await notifyAdmins(svc, "t-1", payload(), { dedupKey: "erp:ord-81" });
    expect(out).toEqual({ notified: 1 });
  });

  it("does not let another tenant's row suppress this one", async () => {
    await notifyAdmins(svc, "t-2", payload(), { dedupKey: "erp:ord-81" });
    const out = await notifyAdmins(svc, "t-1", payload(), { dedupKey: "erp:ord-81" });
    expect(out).toEqual({ notified: 1 });
    expect(store.admin_notifications.map((n) => n.tenant_id)).toEqual(["t-2", "t-1"]);
  });

  it("keeps the caller's link_params and records the key beside them", async () => {
    await notifyAdmins(svc, "t-1", payload({ link_route: "admin", link_params: { tab: "tally" } }), { dedupKey: "erp:ord-81" });
    expect(store.admin_notifications[0].link_params).toEqual({ tab: "tally", dedup_key: "erp:ord-81" });
  });

  it("never dedups a call without a key", async () => {
    await notifyAdmins(svc, "t-1", payload());
    await notifyAdmins(svc, "t-1", payload());
    expect(store.admin_notifications).toHaveLength(2);
    expect(store.admin_notifications[0].link_params).toEqual({});
  });
});
