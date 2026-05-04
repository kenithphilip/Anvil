// Tests for the ClamAV verdict shape.
//
// The shape changed from `{ skipped: true }` (opaque) to
// `{ invoked: bool, reason?, infected?, virus? }` so the UI can
// distinguish "not configured" from "scanned clean". Co-located with
// the v3-app vitest root because the rest of the api/ tree is not in
// the test include glob.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scanWithClamAV } from "../api/documents/_lib/scan-runner.js";

const buf = Buffer.from("hello world");

describe("scanWithClamAV verdict shape", () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("returns { invoked: false, reason: 'not_configured' } when no URL is provided", async () => {
    const r = await scanWithClamAV(buf, "test.pdf", { url: "" });
    expect(r).toEqual({ invoked: false, reason: "not_configured" });
  });

  it("returns invoked:true with infected:false on a clean response", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ infected: false, virus: null }),
    });
    const r = await scanWithClamAV(buf, "test.pdf", { url: "https://clamav.test", fetch: fakeFetch });
    expect(r.invoked).toBe(true);
    expect(r.infected).toBe(false);
    expect(r.virus).toBeNull();
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [calledUrl, init] = fakeFetch.mock.calls[0];
    expect(calledUrl).toBe("https://clamav.test/scan");
    expect(init.method).toBe("POST");
  });

  it("returns invoked:true with infected:true on an EICAR-style hit", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ infected: true, virus: "EICAR-Test-Signature" }),
    });
    const r = await scanWithClamAV(buf, "eicar.txt", {
      url: "https://clamav.test",
      token: "secret",
      fetch: fakeFetch,
    });
    expect(r.invoked).toBe(true);
    expect(r.infected).toBe(true);
    expect(r.virus).toBe("EICAR-Test-Signature");
    const [, init] = fakeFetch.mock.calls[0];
    expect(init.headers["Authorization"]).toBe("Bearer secret");
  });

  it("returns invoked:false with reason:'http_502' on a 5xx from the proxy", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    });
    const r = await scanWithClamAV(buf, "test.pdf", {
      url: "https://clamav.test",
      fetch: fakeFetch,
    });
    expect(r.invoked).toBe(false);
    expect(r.reason).toBe("http_502");
  });

  it("returns invoked:false with reason containing the network error", async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await scanWithClamAV(buf, "test.pdf", {
      url: "https://clamav.test",
      fetch: fakeFetch,
    });
    expect(r.invoked).toBe(false);
    expect(r.reason).toBe("ECONNREFUSED");
  });
});
