// Tests for sharing a spare matrix to the customer portal: the share endpoint
// (provisions/updates a portal token with the 'spares' scope) and portal/view's
// scope-gated spares kind.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000cc";

let tables;
const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select"; let payload = null; let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      is: (c, v) => { rows = rows.filter((r) => (v === null ? r[c] == null : String(r[c]) === String(v))); return b; },
      in: (c, vals) => { const s = new Set(vals.map(String)); rows = rows.filter((r) => s.has(String(r[c]))); return b; },
      or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      update: (patch) => { mode = "update"; payload = patch; return b; },
      insert: (row) => { mode = "insert"; payload = row; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    let idc = 0;
    const terminal = () => {
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "insert") { const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || ("id-" + table + "-" + (++idc)), ...r })); ds.push(...arr); return { data: single ? arr[0] : arr, error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false, readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: USER }, role: "customer_support" }),
  requirePermission: () => {},
}));

import share from "../api/spare_matrix/share.js";
import portalView from "../api/portal/view.js";

const callShare = async (id) => { const res = { setHeader() {}, _status: 0, _json: null }; await share({ method: "POST", query: { id }, headers: {}, _body: {} }, res); return res; };
const callView = async (token, kind, extra = "") => { const res = { setHeader() {}, _status: 0, _json: null }; await portalView({ method: "GET", url: `/api/portal/view?token=${token}&kind=${kind}${extra}`, headers: {} }, res); return res; };

beforeEach(() => { tables = { spare_matrix: [], portal_tokens: [], spare_matrix_columns: [], spare_matrix_rows: [], gun_drawings: [], portal_access_log: [] }; });

describe("POST /spare_matrix/<id>/share", () => {
  it("provisions a new portal token scoped to 'spares' when the customer has none", async () => {
    tables.spare_matrix = [{ id: "m1", tenant_id: TENANT, customer_id: "c1", name: "Servo Guns" }];
    const res = await callShare("m1");
    expect(res._status).toBe(200);
    expect(res._json.scopes).toContain("spares");
    expect(res._json.token).toBeTruthy();
    expect(tables.portal_tokens.length).toBe(1);
    expect(tables.portal_tokens[0].customer_id).toBe("c1");
  });

  it("adds the 'spares' scope to the customer's existing active token (reuses the link)", async () => {
    tables.spare_matrix = [{ id: "m1", tenant_id: TENANT, customer_id: "c1", name: "M" }];
    tables.portal_tokens = [{ id: "t1", tenant_id: TENANT, customer_id: "c1", token: "EXIST", scopes: ["quotes", "invoices"], revoked_at: null, created_at: "2026-01-01" }];
    const res = await callShare("m1");
    expect(res._status).toBe(200);
    expect(res._json.token).toBe("EXIST");           // reused
    expect(res._json.scopes).toEqual(["quotes", "invoices", "spares"]);
    expect(tables.portal_tokens.length).toBe(1);     // no new token
  });

  it("rejects sharing a matrix with no customer (400) and an unknown matrix (404)", async () => {
    tables.spare_matrix = [{ id: "m2", tenant_id: TENANT, customer_id: null, name: "orphan" }];
    expect((await callShare("m2"))._status).toBe(400);
    expect((await callShare("nope"))._status).toBe(404);
  });
});

describe("portal/view spares scope", () => {
  it("403s a token that lacks the 'spares' scope", async () => {
    tables.portal_tokens = [{ id: "t1", tenant_id: TENANT, customer_id: "c1", token: "TK", scopes: ["quotes"], revoked_at: null }];
    const res = await callView("TK", "spares");
    expect(res._status).toBe(403);
  });

  it("lists the customer's matrices when scoped to 'spares'", async () => {
    tables.portal_tokens = [{ id: "t1", tenant_id: TENANT, customer_id: "c1", token: "TK", scopes: ["spares"], revoked_at: null }];
    tables.spare_matrix = [{ id: "m1", tenant_id: TENANT, customer_id: "c1", name: "Servo Guns", project_name: "Line A" }];
    const res = await callView("TK", "spares");
    expect(res._status).toBe(200);
    expect(res._json.spare_matrices.map((m) => m.id)).toEqual(["m1"]);
  });

  it("returns a full matrix (columns/rows/drawings) for kind=spare_matrix, ownership-checked", async () => {
    tables.portal_tokens = [{ id: "t1", tenant_id: TENANT, customer_id: "c1", token: "TK", scopes: ["spares"], revoked_at: null }];
    tables.spare_matrix = [{ id: "m1", tenant_id: TENANT, customer_id: "c1", name: "M", project_name: "L" }];
    tables.spare_matrix_columns = [{ tenant_id: TENANT, matrix_id: "m1", col_name: "SHANK", position: 0 }];
    tables.spare_matrix_rows = [{ tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12", position: 0, spare_values: {} }];
    tables.gun_drawings = [{ tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12", kind: "eg_sheet", status: "committed", link_url: null, original_filename: "GUN-12.pdf" }];
    const res = await callView("TK", "spare_matrix", "&matrix_id=m1");
    expect(res._status).toBe(200);
    expect(res._json.matrix.id).toBe("m1");
    expect(res._json.columns.length).toBe(1);
    expect(res._json.rows[0].gun_no).toBe("GUN-12");
    expect(res._json.drawings.length).toBe(1);
  });
});
