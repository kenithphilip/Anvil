// Data-download control for gun drawings: GET /api/spare_matrix/drawings/download
// must enforce the real `drawing.download` action (design + sales + admin), and
// resolve a file to a signed URL / an external link to its URL. Uses the REAL
// requireAction + SERVER_ACTIONS (only resolveContext is overridden) so the gate
// itself is under test.

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
        maybeSingle() { const hit = rows().filter((r) => this._f.every((fn) => fn(r))); return Promise.resolve({ data: hit[0] || null, error: null }); },
      };
      return q;
    },
    storage: {
      from(bucket) {
        return { createSignedUrl: async (path) => ({ data: { signedUrl: "https://signed.example/" + bucket + "/" + path }, error: null }) };
      },
    },
  }),
}));

const { default: handler } = await import("../api/spare_matrix/drawings/download.js");

const run = async (query = {}) => {
  const qs = new URLSearchParams(query).toString();
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method: "GET", headers: {}, url: "/api/spare_matrix/drawings/download?" + qs, query }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  H.store = {
    gun_drawings: [
      { id: "gd-file", tenant_id: "t-1", kind: "eg_sheet", document_id: "doc-1", link_url: null, original_filename: "EG-123.pdf" },
      { id: "gd-link", tenant_id: "t-1", kind: "drawing_3d", document_id: null, link_url: "https://pdm.example/model.step", original_filename: null },
    ],
    documents: [{ id: "doc-1", tenant_id: "t-1", storage_bucket: "anvil-documents", storage_path: "t-1/123_EG-123.pdf" }],
  };
});

describe("drawing download-control gate", () => {
  it("BLOCKS a role without drawing.download (viewer) with 403", async () => {
    H.ctx = { user: { id: "u1" }, tenantId: "t-1", role: "viewer", anonymous: false };
    const r = await run({ id: "gd-file" });
    expect(r.status).toBe(403);
  });

  it("BLOCKS customer_support and procurement too", async () => {
    for (const role of ["customer_support", "procurement", "finance", "operator"]) {
      H.ctx = { user: { id: "u1" }, tenantId: "t-1", role, anonymous: false };
      expect((await run({ id: "gd-file" })).status).toBe(403);
    }
  });

  it("ALLOWS design_engineer + sales_engineer + admin and returns a signed URL for a file", async () => {
    for (const role of ["design_engineer", "sales_engineer", "admin"]) {
      H.ctx = { user: { id: "u1" }, tenantId: "t-1", role, anonymous: false };
      const r = await run({ id: "gd-file" });
      expect(r.status).toBe(200);
      expect(r.body.downloadUrl).toMatch(/^https:\/\/signed\.example\//);
      expect(r.body.filename).toBe("EG-123.pdf");
    }
  });

  it("returns the external link for a link-only 3D drawing", async () => {
    H.ctx = { user: { id: "u1" }, tenantId: "t-1", role: "design_manager", anonymous: false };
    const r = await run({ id: "gd-link" });
    expect(r.status).toBe(200);
    expect(r.body.external).toBe(true);
    expect(r.body.downloadUrl).toBe("https://pdm.example/model.step");
  });

  it("404s an unknown drawing id (for an allowed role)", async () => {
    H.ctx = { user: { id: "u1" }, tenantId: "t-1", role: "admin", anonymous: false };
    expect((await run({ id: "nope" })).status).toBe(404);
  });

  it("400s a missing id", async () => {
    H.ctx = { user: { id: "u1" }, tenantId: "t-1", role: "admin", anonymous: false };
    expect((await run({})).status).toBe(400);
  });
});
