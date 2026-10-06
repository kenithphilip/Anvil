// Integration tests for the gun-drawing bulk-upload endpoints (stage + commit),
// driving the REAL filename matcher through the handlers against an in-memory
// Supabase shim (same shim shape as api-bom-from-drawing).

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000cc";

let tables;
const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select";
    let payload = null;
    let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: (c, vals) => { const s = new Set(vals.map(String)); rows = rows.filter((r) => s.has(String(r[c]))); return b; },
      or: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      update: (patch) => { mode = "update"; payload = patch; return b; },
      insert: (row) => { mode = "insert"; payload = row; return b; },
      upsert: (row) => { mode = "upsert"; payload = row; return b; },
      delete: () => { mode = "delete"; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const withId = (r) => ({ id: r.id || ("id-" + table + "-" + (ds.length + Math.floor(rows.length))), ...r });
    let idc = 0;
    const terminal = () => {
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "insert" || mode === "upsert") {
        const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || ("id-" + table + "-" + (++idc) + "-" + ds.length), ...r }));
        ds.push(...arr);
        return { data: single ? arr[0] : arr, error: null };
      }
      if (mode === "delete") { for (const r of rows) { const i = ds.indexOf(r); if (i >= 0) ds.splice(i, 1); } return { data: null, error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {},
  handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: USER }, role: "design_engineer" }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));

import stage from "../api/spare_matrix/drawings/stage.js";
import commit from "../api/spare_matrix/drawings/commit.js";

const call = async (handler, body) => {
  const req = { method: "POST", query: {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await handler(req, res);
  return res;
};

const seed = () => {
  tables = {
    spare_matrix: [{ id: "m1", tenant_id: TENANT }],
    spare_matrix_rows: [
      { id: "g1", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12" },
      { id: "g2", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-13" },
    ],
    gun_drawings: [],
  };
};

beforeEach(seed);

describe("POST /spare_matrix/drawings/stage", () => {
  it("matches, flags issues, and stamps the uploader + role (track)", async () => {
    const res = await call(stage, {
      matrix_id: "m1",
      kind: "eg_sheet",
      files: [
        { document_id: "d1", filename: "GUN-12.pdf" },     // matched
        { document_id: "d2", filename: "GUN-12_EG.pdf" },  // within-batch duplicate of GUN-12
        { document_id: "d3", filename: "GUN-99.pdf" },     // unmatched
        { document_id: "d4", filename: "GUN-13.step" },    // wrong_type (step in an eg_sheet batch)
      ],
    });
    expect(res._status).toBe(200);
    const byFile = Object.fromEntries(res._json.staged.map((r) => [r.original_filename, r]));
    expect(byFile["GUN-12.pdf"].match_status).toBe("matched");
    expect(byFile["GUN-12.pdf"].gun_no).toBe("GUN-12");
    expect(byFile["GUN-12.pdf"].row_id).toBe("g1");
    expect(byFile["GUN-12.pdf"].format).toBe("pdf");
    // Upload track: uploader + role recorded on every row.
    expect(byFile["GUN-12.pdf"].uploaded_by).toBe(USER);
    expect(byFile["GUN-12.pdf"].uploader_role).toBe("design_engineer");
    expect(byFile["GUN-12.pdf"].status).toBe("staged");
    expect(byFile["GUN-12_EG.pdf"].match_status).toBe("duplicate");
    expect(byFile["GUN-99.pdf"].match_status).toBe("unmatched");
    expect(byFile["GUN-13.step"].match_status).toBe("wrong_type");
    expect(res._json.summary).toMatchObject({ matched: 1, duplicate: 1, unmatched: 1, wrong_type: 1 });
  });

  it("flags a clean match as duplicate when a committed artifact already exists for that gun+kind", async () => {
    tables.gun_drawings.push({ id: "existing", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12", kind: "eg_sheet", status: "committed" });
    const res = await call(stage, { matrix_id: "m1", kind: "eg_sheet", files: [{ document_id: "d1", filename: "GUN-12.pdf" }] });
    expect(res._json.staged[0].match_status).toBe("duplicate");
  });

  it("404s an unknown matrix and 400s a bad kind", async () => {
    expect((await call(stage, { matrix_id: "nope", kind: "eg_sheet", files: [{ filename: "x.pdf" }] }))._status).toBe(404);
    expect((await call(stage, { matrix_id: "m1", kind: "bogus", files: [{ filename: "x.pdf" }] }))._status).toBe(400);
  });
});

describe("POST /spare_matrix/drawings/commit", () => {
  it("commits eligible staged rows and skips unresolved / payload-less ones", async () => {
    tables.gun_drawings = [
      { id: "s1", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12", kind: "eg_sheet", match_status: "matched", document_id: "d1", status: "staged" },
      { id: "s2", tenant_id: TENANT, matrix_id: "m1", gun_no: null, kind: "eg_sheet", match_status: "unmatched", document_id: "d2", status: "staged" },
      { id: "s3", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-13", kind: "eg_sheet", match_status: "resolved", document_id: null, link_url: null, status: "staged" },
    ];
    const res = await call(commit, { matrix_id: "m1" });
    expect(res._status).toBe(200);
    expect(res._json.committed).toEqual(["s1"]);
    expect(res._json.skipped.map((s) => s.id).sort()).toEqual(["s2", "s3"]);
    expect(tables.gun_drawings.find((r) => r.id === "s1").status).toBe("committed");
  });

  it("blocks committing a second artifact for a gun+kind already committed", async () => {
    tables.gun_drawings = [
      { id: "c1", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12", kind: "eg_sheet", status: "committed" },
      { id: "s1", tenant_id: TENANT, matrix_id: "m1", gun_no: "GUN-12", kind: "eg_sheet", match_status: "matched", document_id: "d9", status: "staged" },
    ];
    const res = await call(commit, { matrix_id: "m1" });
    expect(res._json.committed).toEqual([]);
    expect(res._json.skipped[0].reason).toMatch(/already committed/);
    expect(tables.gun_drawings.find((r) => r.id === "s1").match_status).toBe("duplicate");
  });
});
