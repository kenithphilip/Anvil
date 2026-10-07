// tenant_settings.docai_gemini_fallback_model through /api/admin/docai_settings.
//
// The model callGemini tries when the selected one answers 503 overloaded. An
// admin can name one, turn it off with "none", or leave it blank for the
// deployment default. Migrations here are applied by hand, so a database
// without the column must get a message that names the migration, not a raw
// "column does not exist". Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => undefined,
  handlePreflight: () => false,
  json: (res, status, body) => { res.statusCode = status; res._json = body; return undefined; },
  readBody: async (req) => req._body || {},
  sendError: (res, err) => { res.statusCode = err?.status || 500; res._json = { error: { message: err?.message || String(err) } }; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: "t1", userId: "u1" }),
  requirePermission: () => undefined,
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => undefined), recordEvent: vi.fn(async () => undefined) }));
vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: vi.fn(async () => ({ docai_gemini_fallback_model: "gemini-3-flash-preview" })),
  updateTenantSettings: vi.fn(async (_svc, _t, patch) => ({ ...patch })),
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => null }));

const stripe = await import("../api/_lib/stripe-client.js");
const handler = (await import("../api/admin/docai_settings.js")).default;

const call = async (method, body) => {
  const res = { statusCode: 0, _json: null, setHeader() {}, end() {} };
  await handler({ method, url: "/api/admin/docai_settings", headers: {}, _body: body }, res);
  return res;
};

beforeEach(() => { vi.clearAllMocks(); });

describe("docai_gemini_fallback_model", () => {
  it("is returned by GET", async () => {
    const res = await call("GET");
    expect(res.statusCode).toBe(200);
    expect(res._json.docai_gemini_fallback_model).toBe("gemini-3-flash-preview");
  });

  it("saves a Gemini model id", async () => {
    const res = await call("PATCH", { docai_gemini_fallback_model: " gemini-3-flash-preview " });
    expect(res.statusCode).toBe(200);
    expect(stripe.updateTenantSettings.mock.calls[0][2]).toEqual({ docai_gemini_fallback_model: "gemini-3-flash-preview" });
  });

  it("saves 'none', which turns the fallback off", async () => {
    const res = await call("PATCH", { docai_gemini_fallback_model: "none" });
    expect(res.statusCode).toBe(200);
    expect(stripe.updateTenantSettings.mock.calls[0][2]).toEqual({ docai_gemini_fallback_model: "none" });
  });

  it("saves blank as null, which means the deployment default", async () => {
    const res = await call("PATCH", { docai_gemini_fallback_model: "" });
    expect(res.statusCode).toBe(200);
    expect(stripe.updateTenantSettings.mock.calls[0][2]).toEqual({ docai_gemini_fallback_model: null });
  });

  it("refuses a model from another family", async () => {
    const res = await call("PATCH", { docai_gemini_fallback_model: "claude-sonnet-4-6" });
    expect(res.statusCode).toBe(400);
    expect(res._json.error.message).toMatch(/docai_gemini_fallback_model must start with 'gemini-'/);
  });

  it("names migration 248 when the column is not in the database yet", async () => {
    stripe.updateTenantSettings.mockRejectedValueOnce(new Error("column tenant_settings.docai_gemini_fallback_model does not exist (42703)"));
    const res = await call("PATCH", { docai_gemini_fallback_model: "gemini-3-flash-preview" });
    expect(res.statusCode).toBe(409);
    expect(res._json.error.code).toBe("MIGRATION_NOT_APPLIED");
    expect(res._json.error.migration).toBe("248_docai_gemini_fallback_model.sql");
  });
});
