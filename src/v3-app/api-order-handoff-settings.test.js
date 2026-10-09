// /api/admin/order_handoff_settings: the order-processing team an admin
// names for the handoff email (migration 251, docs/SO_TERMS_AND_HANDOFF_SCOPE.md
// 8.1). Requests go through the real router, auth.js is the REAL module (only
// resolveContext is overridden, so the admin gate is exercised), and
// recordAudit is real: audit rows land in the in-memory audit_events table.
//
// With H.no251 set, tenant_settings behaves as it does before migration 251:
// any statement that names an order_handoff_ column fails, as PostgREST fails
// it (42703 on a select, PGRST204 on a write). Every address is example.com.

import { describe, it, expect, beforeEach, vi } from "vitest";

// H.no251 = true: every read or write naming a 251 column fails.
// H.no251 = "write": reads succeed and the write fails, as when PostgREST's
// schema cache lags a half-finished apply.
const H = vi.hoisted(() => ({ ctx: null, store: {}, users: {}, no251: false, writes: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

const makeSvc = () => ({
  auth: {
    admin: {
      getUserById: async (id) => ({ data: { user: H.users[id] || null }, error: null }),
    },
  },
  from(table) {
    if (!H.store[table]) H.store[table] = [];
    const st = { filters: [], mode: "select", cols: "*", row: null, onConflict: null, single: null };
    const touches251 = () => /order_handoff_/.test(st.cols) || (st.row && Object.keys(st.row).some((k) => k.startsWith("order_handoff_")));
    const run = () => {
      if (table === "tenant_settings" && H.no251 && touches251() && (H.no251 !== "write" || st.mode === "upsert")) {
        return st.mode === "upsert"
          ? { data: null, error: { code: "PGRST204", message: "Could not find the 'order_handoff_to' column of 'tenant_settings' in the schema cache" } }
          : { data: null, error: { code: "42703", message: "column tenant_settings.order_handoff_enabled does not exist" } };
      }
      const ds = H.store[table];
      const matches = (r) => st.filters.every((f) => f(r));
      let out;
      if (st.mode === "insert") {
        const rows = Array.isArray(st.row) ? st.row : [st.row];
        for (const r of rows) ds.push({ ...r });
        H.writes.push({ table, mode: "insert" });
        out = rows;
      } else if (st.mode === "upsert") {
        const keys = (st.onConflict || "id").split(",");
        let hit = ds.find((r) => keys.every((k) => r[k] === st.row[k]));
        if (hit) Object.assign(hit, st.row);
        else { hit = { ...st.row }; ds.push(hit); }
        H.writes.push({ table, mode: "upsert" });
        out = [hit];
      } else {
        out = ds.filter(matches);
      }
      out = out.map((r) => ({ ...r }));
      if (st.single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };
    const b = {
      select(cols) { st.cols = cols || "*"; return b; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return b; },
      insert(row) { st.mode = "insert"; st.row = row; return b; },
      upsert(row, opts) { st.mode = "upsert"; st.row = row; st.onConflict = opts && opts.onConflict; return b; },
      maybeSingle() { st.single = "maybe"; return Promise.resolve(run()); },
      single() { st.single = "one"; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  },
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));

const { dispatch } = await import("../api/router.js");

const call = async (method, body) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await dispatch({ method, headers: {}, url: "/api/admin/order_handoff_settings", body: body || {} }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

const T1 = "tenant-1";
const T2 = "tenant-2";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const as = (role, tenantId = T1) => { H.ctx = { user: { id: ADMIN }, tenantId, role, anonymous: false }; };
const row = (t) => H.store.tenant_settings.find((r) => r.tenant_id === t);
const audits = () => H.store.audit_events.filter((a) => a.action === "order_handoff_settings_updated");

beforeEach(() => {
  H.no251 = false;
  H.writes = [];
  H.users = {
    "u-op1": { id: "u-op1", email: "ravi.ops@example.com", user_metadata: { name: "Ravi Ops" } },
    "u-op2": { id: "u-op2", email: "sana.ops@example.com", user_metadata: {} },
    "u-t2": { id: "u-t2", email: "other.tenant@example.com", user_metadata: {} },
  };
  H.store = {
    tenant_settings: [
      { tenant_id: T1, order_handoff_enabled: false, order_handoff_to: ["orders@example.com", "role:operator"], order_handoff_cc: ["role:procurement"], order_handoff_sender: "graph", order_handoff_template: null },
      { tenant_id: T2, order_handoff_enabled: true, order_handoff_to: ["t2.orders@example.com"], order_handoff_cc: [], order_handoff_sender: "mailer", order_handoff_template: null },
    ],
    tenant_members: [
      { tenant_id: T1, user_id: "u-op1", role: "operator", status: "approved" },
      { tenant_id: T1, user_id: "u-op2", role: "operator", status: "pending" },
      { tenant_id: T2, user_id: "u-t2", role: "operator", status: "approved" },
    ],
    audit_events: [],
  };
  as("admin");
});

describe("GET", () => {
  it("returns the saved settings and how they resolve right now", async () => {
    const r = await call("GET");
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.settings).toEqual({
      order_handoff_enabled: false,
      order_handoff_to: ["orders@example.com", "role:operator"],
      order_handoff_cc: ["role:procurement"],
      order_handoff_sender: "graph",
      order_handoff_template: null,
    });
    expect(r.body.recipients.to.map((x) => [x.email, x.reason])).toEqual([
      ["orders@example.com", "listed address"],
      ["ravi.ops@example.com", "role:operator"],
    ]);
    expect(r.body.recipients.dropped.map((d) => [d.list, d.entry, d.reason])).toEqual([
      ["to", "role:operator", "inactive_member"],
      ["cc", "role:procurement", "no_active_members"],
    ]);
    expect(r.body.role_tokens).toContain("role:operator");
  });

  it("is scoped to the caller's tenant", async () => {
    as("admin", T2);
    const r = await call("GET");
    expect(r.body.settings.order_handoff_to).toEqual(["t2.orders@example.com"]);
    expect(r.body.recipients.to.map((x) => x.email)).toEqual(["t2.orders@example.com"]);
  });

  it("gives the defaults for a tenant with no settings row", async () => {
    as("admin", "tenant-new");
    const r = await call("GET");
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ order_handoff_enabled: false, order_handoff_to: [], order_handoff_cc: [], order_handoff_sender: null, order_handoff_template: null });
    expect(r.body.recipients).toEqual({ to: [], cc: [], reply_to: null, dropped: [] });
  });
});

describe("PATCH", () => {
  it("saves normalised entries, returns the new resolution, and audits before and after", async () => {
    const r = await call("PATCH", {
      order_handoff_enabled: true,
      order_handoff_to: [" Orders@Example.com ", "ROLE:Operator", "orders@example.com", ""],
      order_handoff_cc: ["accounts@example.com"],
      order_handoff_sender: "mailer",
    });
    expect(r.status).toBe(200);
    expect(row(T1)).toMatchObject({
      order_handoff_enabled: true,
      order_handoff_to: ["orders@example.com", "role:operator"],
      order_handoff_cc: ["accounts@example.com"],
      order_handoff_sender: "mailer",
    });
    expect(r.body.settings.order_handoff_to).toEqual(["orders@example.com", "role:operator"]);
    expect(r.body.recipients.cc.map((x) => x.email)).toEqual(["accounts@example.com"]);
    const [a] = audits();
    expect(a).toMatchObject({ tenant_id: T1, actor: ADMIN, actor_role: "admin", object_type: "tenant_settings", object_id: T1 });
    expect(a.before_payload).toEqual({ order_handoff_enabled: false, order_handoff_to: ["orders@example.com", "role:operator"], order_handoff_cc: ["role:procurement"], order_handoff_sender: "graph" });
    expect(a.after_payload).toEqual({ order_handoff_enabled: true, order_handoff_to: ["orders@example.com", "role:operator"], order_handoff_cc: ["accounts@example.com"], order_handoff_sender: "mailer" });
  });

  it("then GET reads back what was saved", async () => {
    await call("PATCH", { order_handoff_cc: ["role:operator"], order_handoff_sender: "" });
    const r = await call("GET");
    expect(r.body.settings.order_handoff_cc).toEqual(["role:operator"]);
    expect(r.body.settings.order_handoff_sender).toBeNull();
    // The other keys were not in the body, so they are unchanged.
    expect(r.body.settings.order_handoff_to).toEqual(["orders@example.com", "role:operator"]);
  });

  it("writes the caller's tenant only", async () => {
    await call("PATCH", { order_handoff_to: ["new.team@example.com"] });
    expect(row(T1).order_handoff_to).toEqual(["new.team@example.com"]);
    expect(row(T2).order_handoff_to).toEqual(["t2.orders@example.com"]);
  });

  it("creates the settings row for a tenant that has none", async () => {
    as("admin", "tenant-new");
    const r = await call("PATCH", { order_handoff_to: ["orders@example.com"] });
    expect(r.status).toBe(200);
    expect(row("tenant-new")).toMatchObject({ tenant_id: "tenant-new", order_handoff_to: ["orders@example.com"] });
  });

  it("refuses an entry that is neither an address nor a known role, by name, and saves nothing", async () => {
    const r = await call("PATCH", { order_handoff_to: ["orders@example.com", "role:wizard", "not an address"] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/order_handoff_to: not an email address or a known role token: role:wizard, not an address/);
    expect(H.writes).toEqual([]);
  });

  it("refuses an unknown sender, a non-boolean switch, and more than 20 entries", async () => {
    expect((await call("PATCH", { order_handoff_sender: "smtp" })).status).toBe(400);
    expect((await call("PATCH", { order_handoff_enabled: "yes" })).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `team${i}@example.com`);
    const r = await call("PATCH", { order_handoff_cc: many });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/more than 20 entries/);
    expect(H.writes).toEqual([]);
  });

  it("refuses to turn the handoff on with nobody in To", async () => {
    const r = await call("PATCH", { order_handoff_enabled: true, order_handoff_to: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/at least one To recipient/);
    expect(row(T1).order_handoff_enabled).toBe(false);
  });

  it("refuses a body with no recognised key", async () => {
    const r = await call("PATCH", { order_handoff_template: { subject: "x" } });
    expect(r.status).toBe(400);
    expect(H.writes).toEqual([]);
  });
});

describe("POST preview", () => {
  it("resolves a draft and saves nothing", async () => {
    const r = await call("POST", { to: ["role:operator", "bad entry"], cc: ["ravi.ops@example.com"] });
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(true);
    expect(r.body.recipients.to.map((x) => x.email)).toEqual(["ravi.ops@example.com"]);
    expect(r.body.recipients.dropped.map((d) => [d.list, d.reason])).toEqual([
      ["to", "inactive_member"], ["to", "invalid_address"], ["cc", "already_in_to"],
    ]);
    expect(H.writes).toEqual([]);
  });
});

describe("RBAC: admin only", () => {
  for (const role of ["sales_manager", "sales_engineer", "operator", "finance", "viewer", "customer_support"]) {
    it(`refuses ${role} on every method, and writes nothing`, async () => {
      as(role);
      for (const [method, body] of [["GET"], ["PATCH", { order_handoff_to: ["x@example.com"] }], ["POST", { to: ["role:operator"] }]]) {
        const r = await call(method, body);
        expect(r.status).toBe(403);
      }
      expect(row(T1).order_handoff_to).toEqual(["orders@example.com", "role:operator"]);
      expect(H.writes).toEqual([]);
    });
  }

  it("refuses an anonymous caller", async () => {
    H.ctx = { user: null, tenantId: T1, role: "sales_engineer", anonymous: true };
    const r = await call("GET");
    expect(r.status).toBe(401);
  });
});

describe("before migration 251 is applied", () => {
  beforeEach(() => { H.no251 = true; });

  it("GET answers 409 MIGRATION_NOT_APPLIED and names the file", async () => {
    const r = await call("GET");
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({
      code: "MIGRATION_NOT_APPLIED",
      migration: "251_order_handoff.sql",
      message: "The order handoff settings are not in this database yet. Apply supabase/migrations/251_order_handoff.sql, then retry.",
    });
  });

  it("PATCH answers the same 409 and writes no audit row", async () => {
    const r = await call("PATCH", { order_handoff_to: ["orders@example.com"] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MIGRATION_NOT_APPLIED");
    expect(r.body.error.migration).toBe("251_order_handoff.sql");
    expect(audits()).toEqual([]);
  });

  it("a write that meets a missing column also answers the 409, after a read that did not", async () => {
    H.no251 = "write";
    const r = await call("PATCH", { order_handoff_to: ["orders@example.com"] });
    expect(r.status).toBe(409);
    expect(r.body.error.migration).toBe("251_order_handoff.sql");
    expect(audits()).toEqual([]);
  });

  it("the preview still works, because it reads no 251 column", async () => {
    const r = await call("POST", { to: ["role:operator"] });
    expect(r.status).toBe(200);
    expect(r.body.recipients.to.map((x) => x.email)).toEqual(["ravi.ops@example.com"]);
  });
});
