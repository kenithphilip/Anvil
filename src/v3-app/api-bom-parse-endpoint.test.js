// Integration test for /api/bom/parse: the handler merges built-in +
// tenant formats, runs the engine over a parsed sheet, and returns
// normalized lines + detected format + suggested asset. Also covers a
// tenant-authored format overriding detection.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let tables;
const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
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
  resolveContext: async () => ({ tenantId: TENANT, userId: "u1" }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));

import parseHandler from "../api/bom/parse.js";

const run = async (body) => {
  const req = { method: "POST", query: {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await parseHandler(req, res);
  return res;
};

beforeEach(() => { tables = {}; });

describe("/api/bom/parse", () => {
  it("detects a built-in format and returns normalized lines", async () => {
    const res = await run({
      file_name: "GUN-9.xlsx",
      rows: [
        ["Part No", "Part Name", "Qty", "Material"],
        ["A1", "Widget", "2", "EN8"],
      ],
    });
    expect(res._status).toBe(200);
    expect(res._json.source_format).toBe("obara_india");
    expect(res._json.asset.asset_code).toBe("GUN-9");
    expect(res._json.lines[0]).toMatchObject({ part_no: "A1", qty: 2, material: "EN8" });
  });

  it("honors a tenant-authored format (column aliases) merged over built-ins", async () => {
    tables.bom_source_formats = [{
      tenant_id: TENANT,
      key: "acme",
      label: "Acme Supplier",
      column_map: { part_no: ["acme pn"], part_name: ["title"], qty: ["count"] },
      detect: { any_label: ["acme corp"], priority: 50 },
      quirks: {},
      enabled: true,
    }];
    const res = await run({
      file_name: "x.xlsx",
      rows: [
        ["ACME CORP"],
        ["Acme PN", "Title", "Count"],
        ["P-1", "Bracket", "3"],
      ],
    });
    expect(res._status).toBe(200);
    expect(res._json.source_format).toBe("acme");
    expect(res._json.lines[0]).toMatchObject({ part_no: "P-1", part_name: "Bracket", qty: 3 });
  });

  it("forces a format with source_format and rejects an unknown one", async () => {
    const ok = await run({ source_format: "generic_flat", rows: [["SKU", "Description"], ["S1", "x"]] });
    expect(ok._status).toBe(200);
    expect(ok._json.source_format).toBe("generic_flat");

    const bad = await run({ source_format: "nope", rows: [["SKU"], ["S1"]] });
    expect(bad._status).toBe(400);
    expect(bad._json.error.code).toBe("UNKNOWN_FORMAT");
  });

  it("rejects a non-2D rows payload", async () => {
    const res = await run({ rows: "nope" });
    expect(res._status).toBe(400);
  });
});
