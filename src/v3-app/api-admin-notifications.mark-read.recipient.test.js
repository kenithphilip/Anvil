// /api/admin/notifications with per-person rows (migration 253, C-17).
//
// A caller lists only the rows addressed to them, plus the broadcast rows
// (recipient_user_id null) when they are admin or operator. The recipient can
// mark their row read; nobody can mark another person's row read, one at a
// time or with "mark all read". Before migration 253 the recipient column is
// missing: a broadcast role gets the old list and every other role gets
// nothing. Invented fixtures; a PostgREST stand-in.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, rows: [], noRecipientColumn: false }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveContext: vi.fn(async () => H.ctx),
}));

vi.mock("../api/_lib/supabase.js", () => {
  // One filter term "col.op.val" of a PostgREST or=(...) list.
  const term = (t) => {
    const [col, op, ...rest] = t.split(".");
    const val = rest.join(".");
    if (op === "is" && val === "null") return (r) => r[col] == null;
    if (op === "eq") return (r) => r[col] === val;
    throw new Error("stand-in: unsupported or() term " + t);
  };
  const from = () => {
    const q = {
      _op: "select", _filters: [], _patch: null, _cols: [],
      select() { return this; },
      update(p) { this._op = "update"; this._patch = p; return this; },
      eq(col, val) { this._cols.push(col); this._filters.push((r) => r[col] === val); return this; },
      or(expr) {
        const fs = expr.split(",").map(term);
        expr.split(",").forEach((t) => this._cols.push(t.split(".")[0]));
        this._filters.push((r) => fs.some((f) => f(r)));
        return this;
      },
      order() { return this; },
      limit() { return this; },
      _exec() {
        if (H.noRecipientColumn && this._cols.includes("recipient_user_id")) {
          return Promise.resolve({ data: null, error: { code: "42703", message: "column admin_notifications.recipient_user_id does not exist" } });
        }
        const hit = H.rows.filter((r) => this._filters.every((f) => f(r)));
        if (this._op === "update") hit.forEach((r) => Object.assign(r, this._patch));
        return Promise.resolve({ data: this._op === "select" ? hit.map((r) => ({ ...r })) : null, error: null });
      },
      then(res, rej) { return this._exec().then(res, rej); },
    };
    return q;
  };
  return { serviceClient: () => ({ from }) };
});

vi.mock("../api/_lib/cors.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readBody: async (req) => req.body || {},
}));

const { default: handler } = await import("../api/admin/notifications.js");

const call = async ({ method = "GET", body } = {}) => {
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    send(p) { this.body = typeof p === "string" ? JSON.parse(p) : p; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
  await handler({ method, headers: {}, body }, res);
  return res;
};

const as = (userId, role, tenantId = "t-1") => { H.ctx = { user: { id: userId }, tenantId, role, anonymous: false }; };
const row = (id, extra = {}) => ({ id, tenant_id: "t-1", kind: "k", title: id, resolved: false, read_by: [], recipient_user_id: null, ...extra });
const byId = (id) => H.rows.find((r) => r.id === id);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  H.noRecipientColumn = false;
  H.rows = [
    row("for-eng", { recipient_user_id: "u-eng" }),
    row("for-mgr", { recipient_user_id: "u-mgr" }),
    row("broadcast"),
    row("other-tenant", { tenant_id: "t-2", recipient_user_id: "u-eng" }),
    row("done-for-eng", { recipient_user_id: "u-eng", resolved: true }),
  ];
});

describe("GET lists only the caller's rows", () => {
  it("shows a sales engineer their own row and no broadcast row", async () => {
    as("u-eng", "sales_engineer");
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.notifications.map((n) => n.id)).toEqual(["for-eng"]);
    expect(res.body.unread_count).toBe(1);
  });

  it("shows an admin their own rows and the broadcast rows, never another person's row", async () => {
    H.rows.push(row("for-admin", { recipient_user_id: "u-admin" }));
    as("u-admin", "admin");
    const res = await call();
    expect(res.body.notifications.map((n) => n.id).sort()).toEqual(["broadcast", "for-admin"]);
  });

  it("shows an operator the broadcast rows, as the bell did before", async () => {
    as("u-op", "operator");
    const res = await call();
    expect(res.body.notifications.map((n) => n.id)).toEqual(["broadcast"]);
  });
});

describe("POST mark_read", () => {
  it("lets the recipient mark their own row read", async () => {
    as("u-eng", "sales_engineer");
    const res = await call({ method: "POST", body: { action: "mark_read", id: "for-eng" } });
    expect(res.statusCode).toBe(200);
    expect(byId("for-eng").read_by).toEqual(["u-eng"]);
  });

  it("refuses to mark another person's row read", async () => {
    as("u-eng", "sales_engineer");
    const res = await call({ method: "POST", body: { action: "mark_read", id: "for-mgr" } });
    expect(res.statusCode).toBe(404);
    expect(byId("for-mgr").read_by).toEqual([]);
  });

  it("refuses an admin too: a broadcast role does not reach a person's row", async () => {
    as("u-admin", "admin");
    const res = await call({ method: "POST", body: { action: "mark_read", id: "for-mgr" } });
    expect(res.statusCode).toBe(404);
    expect(byId("for-mgr").read_by).toEqual([]);
  });

  it("refuses a sales engineer on a broadcast row", async () => {
    as("u-eng", "sales_engineer");
    const res = await call({ method: "POST", body: { action: "mark_read", id: "broadcast" } });
    expect(res.statusCode).toBe(404);
    expect(byId("broadcast").read_by).toEqual([]);
  });
});

describe("POST mark_all_read", () => {
  it("marks only the caller's own rows", async () => {
    as("u-eng", "sales_engineer");
    const res = await call({ method: "POST", body: { action: "mark_all_read" } });
    expect(res.statusCode).toBe(200);
    expect(byId("for-eng").read_by).toEqual(["u-eng"]);
    expect(byId("for-mgr").read_by).toEqual([]);
    expect(byId("broadcast").read_by).toEqual([]);
    expect(byId("other-tenant").read_by).toEqual([]);
  });
});

describe("POST resolve", () => {
  it("stays admin only", async () => {
    as("u-eng", "sales_engineer");
    const res = await call({ method: "POST", body: { action: "resolve", id: "for-eng" } });
    expect(res.statusCode).toBe(403);
    expect(byId("for-eng").resolved).toBe(false);
  });
});

describe("before migration 253 (no recipient_user_id column)", () => {
  beforeEach(() => {
    H.noRecipientColumn = true;
    // Before 253 no row has a recipient.
    H.rows = [row("broadcast"), row("broadcast-2")];
  });

  it("shows a sales engineer nothing", async () => {
    as("u-eng", "sales_engineer");
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.notifications).toEqual([]);
  });

  it("does not let a sales engineer mark a broadcast row read", async () => {
    as("u-eng", "sales_engineer");
    const all = await call({ method: "POST", body: { action: "mark_all_read" } });
    const one = await call({ method: "POST", body: { action: "mark_read", id: "broadcast" } });
    expect(all.statusCode).toBe(200);
    expect(one.statusCode).toBe(404);
    expect(H.rows.every((r) => r.read_by.length === 0)).toBe(true);
  });

  it("keeps the admin bell as it was", async () => {
    as("u-admin", "admin");
    const res = await call();
    expect(res.body.notifications.map((n) => n.id).sort()).toEqual(["broadcast", "broadcast-2"]);
    const mark = await call({ method: "POST", body: { action: "mark_read", id: "broadcast" } });
    expect(mark.statusCode).toBe(200);
    expect(byId("broadcast").read_by).toEqual(["u-admin"]);
  });
});
