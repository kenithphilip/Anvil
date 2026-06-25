// Integration test for the /api/bom/import handler. Drives the real
// handler with a mocked CORS/auth/supabase/audit layer and an in-memory
// svc, asserting the full derivation: bom_assets + bom_lines persisted,
// item_master rows created, bill_of_materials edges derived from levels,
// a bom_import_events provenance row written, and the diff returned.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000cc";

// ── in-memory svc ────────────────────────────────────────────────────
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
    const withId = (r) => ({ id: r.id || ("id-" + table + "-" + (ds.length + 1)), ...r });
    const terminal = () => {
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "insert" || mode === "upsert") {
        const arr = (Array.isArray(payload) ? payload : [payload]).map(withId);
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
  resolveContext: async () => ({ tenantId: TENANT, userId: USER }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));

import importHandler from "../api/bom/import.js";

const run = async (body) => {
  const req = { method: "POST", query: {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await importHandler(req, res);
  return res;
};

beforeEach(() => { tables = {}; });

describe("/api/bom/import", () => {
  it("ingests a multi-level BOM: asset, lines, item_master, edges, event", async () => {
    const res = await run({
      asset: { asset_code: "GUN-1", name: "Servo Gun", source_country: "O-CHINA" },
      file_name: "GUN-1.xlsx",
      lines: [
        { seq_no: 1, level: 1, part_no: "TOP", part_name: "Top assy", qty: 1 },
        { seq_no: 2, level: 2, part_no: "SUB", part_name: "Sub", qty: 2 },
        { seq_no: 3, level: 3, part_no: "LEAF", part_name: "Leaf", material: "CuCrZr", qty: 4 },
      ],
    });
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.lines).toBe(3);
    expect(res._json.diff).toEqual({ added: 3, removed: 0, changed: 0, unchanged: 0 });

    // asset + lines persisted
    expect(tables.bom_assets).toHaveLength(1);
    expect(tables.bom_assets[0]).toMatchObject({ asset_code: "GUN-1", uploaded_by: USER, last_uploaded_by: USER });
    expect(tables.bom_lines).toHaveLength(3);

    // every part is now in item_master (the core requirement)
    const parts = (tables.item_master || []).map((r) => r.part_no).sort();
    expect(parts).toEqual(["LEAF", "SUB", "TOP"]);
    const top = tables.item_master.find((r) => r.part_no === "TOP");
    expect(top).toMatchObject({ is_assembly: true, data_source: "imported", source_country: "O-CHINA" });
    const leaf = tables.item_master.find((r) => r.part_no === "LEAF");
    expect(leaf.is_assembly).toBe(false);

    // bill_of_materials edges reflect the level hierarchy
    const edges = (tables.bill_of_materials || []).map((e) => e.parent_part_no + ">" + e.child_part_no).sort();
    expect(edges).toEqual(["GUN-1>TOP", "SUB>LEAF", "TOP>SUB"]);

    // provenance event recorded
    expect(tables.bom_import_events).toHaveLength(1);
    expect(tables.bom_import_events[0]).toMatchObject({ uploaded_by: USER, line_count: 3 });
    expect(res._json.derived.edges_upserted).toBe(3);
  });

  it("links a project when project_id is supplied", async () => {
    const res = await run({
      asset: { asset_code: "GUN-2" },
      project_id: "proj-1",
      lines: [{ seq_no: 1, part_no: "A", qty: 1 }],
    });
    expect(res._status).toBe(200);
    expect(tables.bom_asset_projects).toHaveLength(1);
    expect(tables.bom_asset_projects[0]).toMatchObject({ project_id: "proj-1", created_by: USER });
  });

  it("rejects an import with no asset_code", async () => {
    const res = await run({ asset: {}, lines: [{ part_no: "A" }] });
    expect(res._status).toBe(400);
  });

  it("rejects an import with no lines", async () => {
    const res = await run({ asset: { asset_code: "X" }, lines: [] });
    expect(res._status).toBe(400);
  });
});
