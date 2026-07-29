// Tests for the shared Admin helpers (extracted from screens/admin.tsx when its
// panels were split out). Covers:
//   - adminCrudFetch: URL + auth/tenant header build, 204 -> null, non-2xx throw,
//     non-string body stringified.
//   - parseCSV: quotes, escaped quotes, CRLF/LF, empty-row filtering.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./api", () => ({
  AnvilBackend: {
    getConfig: () => ({ url: "https://api.example.com/", tenantId: "t1" }),
    getSession: () => ({ access_token: "tok-abc" }),
  },
}));

import { adminCrudFetch, parseCSV } from "./admin-shared";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks(); });

describe("adminCrudFetch", () => {
  it("builds the URL (trailing slash stripped) + auth + tenant headers and returns JSON", async () => {
    const spy = vi.fn((_url: string, _init: any) => Promise.resolve({ ok: true, status: 200, json: async () => ({ rows: [1] }) }));
    globalThis.fetch = spy as any;
    const out = await adminCrudFetch("/api/admin/freight_rates");
    expect(out).toEqual({ rows: [1] });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/admin/freight_rates");   // no double slash
    expect(init.headers.Authorization).toBe("Bearer tok-abc");
    expect(init.headers["x-anvil-tenant"]).toBe("t1");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("stringifies a non-string body", async () => {
    const spy = vi.fn((_url: string, _init: any) => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
    globalThis.fetch = spy as any;
    await adminCrudFetch("/api/admin/x", { method: "POST", body: { a: 1 } as any });
    expect(spy.mock.calls[0][1].body).toBe('{"a":1}');
  });

  it("treats 204 as null", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 204, json: async () => ({}) })) as any;
    expect(await adminCrudFetch("/api/admin/x", { method: "DELETE" })).toBeNull();
  });

  it("throws on a non-2xx with the status", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "boom" })) as any;
    await expect(adminCrudFetch("/api/admin/x")).rejects.toThrow(/HTTP 500/);
  });
});

describe("parseCSV", () => {
  it("splits simple rows", () => {
    expect(parseCSV("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("handles quoted fields containing commas and newlines", () => {
    expect(parseCSV('"a,b",c')).toEqual([["a,b", "c"]]);
    expect(parseCSV('"line1\nline2",c')).toEqual([["line1\nline2", "c"]]);
  });
  it("handles escaped double-quotes", () => {
    expect(parseCSV('"a""b",c')).toEqual([['a"b', "c"]]);
  });
  it("handles CRLF line endings", () => {
    expect(parseCSV("a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("filters out fully-empty rows", () => {
    expect(parseCSV("a,b\n\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });
});
