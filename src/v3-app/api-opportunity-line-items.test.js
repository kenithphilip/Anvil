// /api/opportunities/line_items CRUD tests.
//
// The endpoint feeds the inventory-planning pipeline-demand path,
// so this test file enforces the contract:
//   - GET requires opportunity_id, returns rows ordered by line_index.
//   - POST validates: opportunity_id, product_family, qty>0,
//     win_probability_pct in 0..100. Auto-assigns line_index.
//   - PATCH whitelist + qty positivity + 400 when no recognised
//     fields present.
//   - DELETE returns ok:true.
//   - Router maps the path; client wrapper exposes 4 helpers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = 500; res._json = { error: { message: err?.message || String(err) } }; },
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async (req) => req._ctx || { tenantId: "t1", userId: "u1" },
  requirePermission: () => undefined,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
}));

vi.mock("../api/_lib/supabase.js", () => {
  let svc = null;
  return { serviceClient: () => svc, __setSvc: (s) => { svc = s; } };
});

// CRUD-aware mock that supports insert/update/delete chains.
const buildSvc = (seed = {}) => {
  const tables = new Map(Object.entries(seed));
  let nextId = 1000;
  const get = (t) => tables.get(t) || (tables.set(t, []).get(t));
  const matches = (filters, r) => filters.every((f) => (
    f.op === "eq" ? r[f.col] === f.v
    : f.op === "gte" ? String(r[f.col]) >= String(f.v)
    : true
  ));
  const builder = (table) => {
    const ctx = {
      table,
      filters: [],
      action: null,
      patch: null,
      insertRow: null,
      orderCol: null,
      orderAsc: true,
      lim: null,
    };
    const select = (rows) => {
      let out = rows.filter((r) => matches(ctx.filters, r));
      if (ctx.orderCol) {
        const dir = ctx.orderAsc ? 1 : -1;
        out = [...out].sort((a, b) => (a[ctx.orderCol] > b[ctx.orderCol] ? dir : a[ctx.orderCol] < b[ctx.orderCol] ? -dir : 0));
      }
      if (ctx.lim != null) out = out.slice(0, ctx.lim);
      return out;
    };
    const api = {
      select() { return api; },
      eq(c, v) { ctx.filters.push({ col: c, op: "eq", v }); return api; },
      gte(c, v) { ctx.filters.push({ col: c, op: "gte", v }); return api; },
      order(c, opts) { ctx.orderCol = c; ctx.orderAsc = opts?.ascending !== false; return api; },
      limit(n) { ctx.lim = n; return api; },
      maybeSingle() {
        const rows = select(get(table));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        // For insert/update/delete, single returns the touched row.
        if (ctx.action === "insert") {
          const id = "row-" + (nextId++);
          const row = { id, ...ctx.insertRow };
          get(table).push(row);
          return Promise.resolve({ data: row, error: null });
        }
        if (ctx.action === "update") {
          const arr = get(table);
          const idx = arr.findIndex((r) => matches(ctx.filters, r));
          if (idx === -1) return Promise.resolve({ data: null, error: { message: "not found" } });
          arr[idx] = { ...arr[idx], ...ctx.patch };
          return Promise.resolve({ data: arr[idx], error: null });
        }
        if (ctx.action === "delete") {
          const arr = get(table);
          const idx = arr.findIndex((r) => matches(ctx.filters, r));
          if (idx === -1) return Promise.resolve({ data: null, error: { message: "not found" } });
          const [removed] = arr.splice(idx, 1);
          return Promise.resolve({ data: removed, error: null });
        }
        // Plain select.
        const rows = select(get(table));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      insert(row) { ctx.action = "insert"; ctx.insertRow = row; return api; },
      update(patch) { ctx.action = "update"; ctx.patch = patch; return api; },
      delete() { ctx.action = "delete"; return api; },
      then(resolve) {
        const rows = select(get(table));
        resolve({ data: rows, error: null });
        return { catch: () => ({}) };
      },
    };
    return api;
  };
  return { from: builder, _tables: tables };
};

beforeEach(() => { vi.clearAllMocks(); });

const callHandler = async (method, url, body) => {
  const handler = (await import("../api/opportunities/line_items.js")).default;
  const req = { method, url, headers: {}, _body: body };
  const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
  await handler(req, res);
  return res;
};

describe("/api/opportunities/line_items :: GET", () => {
  it("requires ?opportunity_id", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("GET", "/api/opportunities/line_items");
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/opportunity_id/);
  });

  it("returns rows for the given opportunity ordered by line_index", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      opportunity_line_items: [
        { id: "li1", tenant_id: "t1", opportunity_id: "opp1", line_index: 2, product_family: "BRG", qty: 5 },
        { id: "li2", tenant_id: "t1", opportunity_id: "opp1", line_index: 1, product_family: "SEAL", qty: 3 },
        { id: "li3", tenant_id: "t1", opportunity_id: "opp2", line_index: 1, product_family: "BRG", qty: 9 },
      ],
    }));
    const res = await callHandler("GET", "/api/opportunities/line_items?opportunity_id=opp1");
    expect(res.statusCode).toBe(200);
    expect(res._json.line_items).toHaveLength(2);
    expect(res._json.line_items[0].line_index).toBe(1);     // SEAL first
    expect(res._json.line_items[1].line_index).toBe(2);
  });
});

describe("/api/opportunities/line_items :: POST validation", () => {
  it("rejects missing opportunity_id", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/opportunities/line_items", { product_family: "BRG", qty: 5 });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/opportunity_id/);
  });

  it("rejects missing product_family", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/opportunities/line_items", { opportunity_id: "opp1", qty: 5 });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/product_family/);
  });

  it("rejects qty <= 0", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/opportunities/line_items", { opportunity_id: "opp1", product_family: "BRG", qty: 0 });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/qty/);
  });

  it("rejects win_probability_pct outside 0..100", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("POST", "/api/opportunities/line_items", {
      opportunity_id: "opp1", product_family: "BRG", qty: 5, win_probability_pct: 150,
    });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/win_probability_pct/);
  });

  it("inserts a valid line and auto-assigns line_index = max+1", async () => {
    const svc = buildSvc({
      opportunity_line_items: [
        { id: "li-existing", tenant_id: "t1", opportunity_id: "opp1", line_index: 3, product_family: "OLD", qty: 1 },
      ],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("POST", "/api/opportunities/line_items", {
      opportunity_id: "opp1", product_family: "BRG", qty: 5, expected_unit_price: 250,
    });
    expect(res.statusCode).toBe(200);
    expect(res._json.line_item.line_index).toBe(4);
    expect(res._json.line_item.product_family).toBe("BRG");
    expect(res._json.line_item.qty).toBe(5);
  });
});

describe("/api/opportunities/line_items :: PATCH", () => {
  it("rejects missing ?id", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("PATCH", "/api/opportunities/line_items", { qty: 7 });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/id/);
  });

  it("rejects body with no recognised fields", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("PATCH", "/api/opportunities/line_items?id=li1", { not_a_field: "x" });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/no recognised fields/);
  });

  it("rejects qty <= 0 on update", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({
      opportunity_line_items: [{ id: "li1", tenant_id: "t1", opportunity_id: "opp1", line_index: 1, product_family: "BRG", qty: 5 }],
    }));
    const res = await callHandler("PATCH", "/api/opportunities/line_items?id=li1", { qty: -1 });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/qty/);
  });

  it("applies whitelisted fields only", async () => {
    const svc = buildSvc({
      opportunity_line_items: [{ id: "li1", tenant_id: "t1", opportunity_id: "opp1", line_index: 1, product_family: "BRG", qty: 5 }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("PATCH", "/api/opportunities/line_items?id=li1", { qty: 9, evil: "drop_table" });
    expect(res.statusCode).toBe(200);
    expect(res._json.line_item.qty).toBe(9);
    expect(res._json.line_item.evil).toBeUndefined();
  });
});

describe("/api/opportunities/line_items :: DELETE", () => {
  it("rejects missing ?id", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("DELETE", "/api/opportunities/line_items");
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/id/);
  });

  it("removes the row and returns ok:true", async () => {
    const svc = buildSvc({
      opportunity_line_items: [{ id: "li1", tenant_id: "t1", opportunity_id: "opp1", line_index: 1, product_family: "BRG", qty: 5 }],
    });
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(svc);
    const res = await callHandler("DELETE", "/api/opportunities/line_items?id=li1");
    expect(res.statusCode).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(svc._tables.get("opportunity_line_items")).toHaveLength(0);
  });
});

describe("/api/opportunities/line_items :: routing + client wrapper", () => {
  it("router registers the path", () => {
    const router = read("src/api/router.js");
    expect(router).toMatch(/opportunityLineItems/);
    expect(router).toMatch(/["']\/opportunities\/line_items["']/);
  });

  it("anvil-client exposes list/create/update/delete helpers", () => {
    const client = read("src/client/anvil-client.js");
    expect(client).toMatch(/listOpportunityLines/);
    expect(client).toMatch(/createOpportunityLine/);
    expect(client).toMatch(/updateOpportunityLine/);
    expect(client).toMatch(/deleteOpportunityLine/);
  });

  it("returns 405 for unsupported methods", async () => {
    const { __setSvc } = await import("../api/_lib/supabase.js");
    __setSvc(buildSvc({}));
    const res = await callHandler("PUT", "/api/opportunities/line_items");
    expect(res.statusCode).toBe(405);
  });
});
