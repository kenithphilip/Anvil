// Unit tests for backendFetch. Covers:
// - Throws when backend URL not configured.
// - Builds Authorization + x-anvil-tenant headers from localStorage.
// - Stringifies non-string bodies.
// - Treats 204 as void.
// - Throws on non-2xx with the response body included.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { backendFetch } from "./fetch";

const origFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("backendFetch", () => {
  it("throws when no backend URL is configured", async () => {
    await expect(backendFetch("/api/anything")).rejects.toThrow(/Backend URL not configured/);
  });

  it("attaches Authorization + x-anvil-tenant headers from localStorage", async () => {
    localStorage.setItem("obara:backend_config", JSON.stringify({ url: "https://api.example.com", tenantId: "OBARA-IN" }));
    localStorage.setItem("obara:backend_session", JSON.stringify({ access_token: "abc" }));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock as any;
    await backendFetch("/api/x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect((init.headers as any).Authorization).toBe("Bearer abc");
    expect((init.headers as any)["x-anvil-tenant"]).toBe("OBARA-IN");
  });

  it("strips trailing slashes from the configured URL", async () => {
    localStorage.setItem("obara:backend_config", JSON.stringify({ url: "https://api.example.com//" }));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as any;
    await backendFetch("/api/x");
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe("https://api.example.com/api/x");
  });

  it("JSON.stringifies non-string bodies", async () => {
    localStorage.setItem("obara:backend_config", JSON.stringify({ url: "https://api.example.com" }));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as any;
    await backendFetch("/api/x", { method: "POST", body: { foo: 1 } });
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(init.body).toBe('{"foo":1}');
  });

  it("returns undefined on a 204 response", async () => {
    localStorage.setItem("obara:backend_config", JSON.stringify({ url: "https://api.example.com" }));
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as any;
    const r = await backendFetch("/api/x");
    expect(r).toBeUndefined();
  });

  it("throws with the response body on non-2xx", async () => {
    localStorage.setItem("obara:backend_config", JSON.stringify({ url: "https://api.example.com" }));
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as any;
    await expect(backendFetch("/api/x")).rejects.toThrow(/HTTP 500: boom/);
  });
});
