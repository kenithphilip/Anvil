// drawings/list by gun_no (the BOM / gun-view shortcut) + the download redaction.
// Uses the REAL hasAction/SERVER_ACTIONS (only resolveContext overridden).

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, store: {} }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const rows = () => H.store[table] || [];
      const q = {
        _f: [],
        select() { return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        order() { return this; },
        _run() { return { data: rows().filter((r) => this._f.every((fn) => fn(r))), error: null }; },
        then(res, rej) { return Promise.resolve(this._run()).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: handler } = await import("../api/spare_matrix/drawings/list.js");

const run = async (query = {}) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method: "GET", headers: {}, url: "/api/spare_matrix/drawings/list", query }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.store = {
    gun_drawings: [
      { id: "a", tenant_id: "t-1", matrix_id: "m1", gun_no: "GUN-12", kind: "eg_sheet", status: "committed", document_id: "doc-1", link_url: null, original_filename: "EG.pdf" },
      { id: "b", tenant_id: "t-1", matrix_id: "m2", gun_no: "GUN-12", kind: "drawing_3d", status: "committed", document_id: null, link_url: "https://pdm/x.step", original_filename: null },
      { id: "c", tenant_id: "t-1", matrix_id: "m1", gun_no: "GUN-99", kind: "eg_sheet", status: "committed", document_id: "doc-9", link_url: null, original_filename: "OTHER.pdf" },
    ],
  };
});

describe("drawings/list by gun_no", () => {
  it("400s when neither matrix_id nor gun_no is given", async () => {
    H.ctx = { user: { id: "u" }, tenantId: "t-1", role: "admin", anonymous: false };
    expect((await run({})).status).toBe(400);
  });

  it("lists a gun's committed drawings across matrices (admin sees file + link)", async () => {
    H.ctx = { user: { id: "u" }, tenantId: "t-1", role: "admin", anonymous: false };
    const r = await run({ gun_no: "GUN-12", status: "committed" });
    expect(r.status).toBe(200);
    expect(r.body.drawings.map((d) => d.id).sort()).toEqual(["a", "b"]); // both matrices, not GUN-99
    expect(r.body.drawings.find((d) => d.id === "a").document_id).toBe("doc-1");
    expect(r.body.drawings.find((d) => d.id === "b").link_url).toBe("https://pdm/x.step");
  });

  it("redacts the file/link for a role without drawing.download", async () => {
    H.ctx = { user: { id: "u" }, tenantId: "t-1", role: "viewer", anonymous: false };
    const r = await run({ gun_no: "GUN-12", status: "committed" });
    expect(r.status).toBe(200);
    expect(r.body.drawings).toHaveLength(2);
    for (const d of r.body.drawings) {
      expect(d.document_id).toBeNull();
      expect(d.link_url).toBeNull();
      expect(d.download_restricted).toBe(true);
      expect(["eg_sheet", "drawing_3d"]).toContain(d.kind); // kind still visible
    }
  });
});
