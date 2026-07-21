// CM PDM P1b: the /api/bom/from-drawing endpoint. Ingests a completed
// assembly_bom extraction (by run_id) into the BOM via the shared importBom
// core. Two-step like ack_extract->ack_accept: commit defaults to false so the
// default is a dry-run PREVIEW that never mutates the BOM; commit=true persists.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const USER = "00000000-0000-0000-0000-0000000000cc";

// ── in-memory svc (same shim as api-bom-import-endpoint) ─────────────
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
  resolveContext: async () => ({ tenantId: TENANT, user: { id: USER } }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));

import fromDrawing from "../api/bom/from_drawing.js";

const NORMALIZED = {
  classification: "assembly_bom",
  customer: null,
  title_block: { drawing_no: "GA-1234", revision: "B", asset_code: "GUN-77", title: "Weld Gun", sheet: "1 of 2" },
  lines: [
    { balloon_no: "1", partNumber: "SHANK-A", description: "Shank", quantity: 2, material: "EN8", is_spare: true },
    { balloon_no: "2", partNumber: "TIP-9", description: "Electrode tip", quantity: 4, is_spare: false },
  ],
  stated_line_count: 5,
};

const seedRun = (over = {}) => {
  tables.extraction_runs = [{
    id: "run-1", tenant_id: TENANT,
    extraction_kind: "assembly_bom", status: "ok", status_reason: "ok",
    confidence_overall: 0.9, normalized_extract: NORMALIZED,
    ...over,
  }];
};

const run = async (body) => {
  const req = { method: "POST", query: {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await fromDrawing(req, res);
  return res;
};

beforeEach(() => { tables = {}; });

describe("/api/bom/from-drawing — preview (default)", () => {
  it("dry-runs by default: returns the mapped asset + lines + shortfall warning, mutates nothing", async () => {
    seedRun();
    const res = await run({ run_id: "run-1" });
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.dry_run).toBe(true);
    expect(res._json.asset).toMatchObject({ asset_code: "GUN-77", source_format: "assembly_drawing" });
    expect(res._json.lines).toHaveLength(2);
    expect(res._json.warnings.map((w) => w.code)).toContain("line_count_shortfall");
    // no BOM tables were written on a preview
    expect(tables.bom_assets).toBeUndefined();
    expect(tables.bom_lines).toBeUndefined();
  });
});

describe("/api/bom/from-drawing — commit", () => {
  it("persists the BOM via importBom: asset, lines, item_master, edges", async () => {
    seedRun();
    const res = await run({ run_id: "run-1", commit: true });
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(true);
    expect(res._json.committed).toBe(true);
    expect(res._json.asset_id).toBeTruthy();
    expect(res._json.lines).toBe(2);

    expect(tables.bom_assets).toHaveLength(1);
    expect(tables.bom_assets[0]).toMatchObject({ asset_code: "GUN-77", uploaded_by: USER, source_format: "assembly_drawing" });
    expect(tables.bom_lines).toHaveLength(2);
    // balloon number carried onto the line (the customer-facing spare identity)
    const shank = tables.bom_lines.find((l) => l.part_no === "SHANK-A");
    expect(shank).toMatchObject({ balloon_no: "1", is_spare: true, qty: 2 });
    // every child part landed in item_master; edges root at the assembly
    const parts = (tables.item_master || []).map((r) => r.part_no).sort();
    expect(parts).toEqual(["SHANK-A", "TIP-9"]);
    const edges = (tables.bill_of_materials || []).map((e) => e.parent_part_no + ">" + e.child_part_no).sort();
    expect(edges).toEqual(["GUN-77>SHANK-A", "GUN-77>TIP-9"]);
  });

  it("refuses to commit when no asset_code/drawing_no roots the BOM", async () => {
    seedRun({ normalized_extract: { ...NORMALIZED, title_block: { title: "no id" } } });
    const res = await run({ run_id: "run-1", commit: true });
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(false);
    expect(res._json.needs).toBe("asset_code");
    expect(tables.bom_assets).toBeUndefined();
  });

  it("accepts an operator asset_code override to root an untitled drawing", async () => {
    seedRun({ normalized_extract: { ...NORMALIZED, title_block: { title: "no id" } } });
    const res = await run({ run_id: "run-1", commit: true, asset_code: "GUN-99" });
    expect(res._json.ok).toBe(true);
    expect(tables.bom_assets[0].asset_code).toBe("GUN-99");
  });
});

describe("/api/bom/from-drawing — guards", () => {
  it("400s without a run_id", async () => {
    const res = await run({});
    expect(res._status).toBe(400);
  });

  it("404s when the run does not exist", async () => {
    tables.extraction_runs = [];
    const res = await run({ run_id: "nope" });
    expect(res._status).toBe(404);
  });

  it("422s when the run is a different kind", async () => {
    seedRun({ extraction_kind: "po" });
    const res = await run({ run_id: "run-1" });
    expect(res._status).toBe(422);
  });

  it("surfaces (does not ingest) a non-ok extraction", async () => {
    seedRun({ status: "failed", status_reason: "non_drawing" });
    const res = await run({ run_id: "run-1", commit: true });
    expect(res._status).toBe(200);
    expect(res._json.ok).toBe(false);
    expect(res._json.status_reason).toBe("non_drawing");
    expect(tables.bom_assets).toBeUndefined();
  });

  it("does not cross tenants (run belongs to another tenant)", async () => {
    seedRun({ tenant_id: "other-tenant" });
    const res = await run({ run_id: "run-1" });
    expect(res._status).toBe(404);
  });
});
