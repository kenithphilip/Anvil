// Router unit tests. Confirms:
// - Every documented endpoint resolves to a handler.
// - Unknown routes return 404 with a helpful message.
// - Dynamic /<group>/<id> routes inject req.query.id.
// - Query strings parse into req.query.
// - The Vercel /api/ prefix is tolerated.
//
// We import the router module and invoke its dispatch() with mock
// req/res so we can assert handler invocation without spinning up a
// real HTTP server. The handlers themselves are validated by their
// own existing tests + the Supabase wire-up; here we only check
// routing.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { dispatch } from "../api/router.js";

const mockReqRes = (url, method = "GET") => {
  const req = { url, method, query: {} };
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: vi.fn((k, v) => { headers[k] = v; }),
    end: vi.fn(),
    headers,
    body: undefined,
  };
  res.end = vi.fn((b) => { res.body = b; });
  return { req, res };
};

describe("router dispatch", () => {
  it("returns 404 for an unknown path", async () => {
    const { req, res } = mockReqRes("/api/does/not/exist");
    await dispatch(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Route not found");
  });

  it("strips the /api prefix when matching", async () => {
    const { req, res } = mockReqRes("/api/this/path/never/matches");
    await dispatch(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("/this/path/never/matches");
  });

  it("matches a static route and parses query string", async () => {
    const { req, res } = mockReqRes("/api/orders?limit=10&status=DRAFT");
    // The orders handler will throw because no Supabase context, but
    // before it does, we should see req.query populated. Stop the
    // handler at the first failure and assert what we have.
    try { await dispatch(req, res); } catch (_) { /* expected */ }
    expect(req.query.limit).toBe("10");
    expect(req.query.status).toBe("DRAFT");
  });

  it("matches a dynamic [id] route and injects req.query.id", async () => {
    const { req, res } = mockReqRes("/api/orders/abc-123");
    try { await dispatch(req, res); } catch (_) { /* handler may fail */ }
    expect(req.query.id).toBe("abc-123");
  });

  it("does not match a nested path under a dynamic prefix", async () => {
    const { req, res } = mockReqRes("/api/orders/abc/extra");
    await dispatch(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("matches /api/source_pos/<id> via dynamic route", async () => {
    const { req, res } = mockReqRes("/api/source_pos/spo-7");
    try { await dispatch(req, res); } catch (_) {}
    expect(req.query.id).toBe("spo-7");
  });

  it("matches /api/documents/<id> via dynamic route", async () => {
    const { req, res } = mockReqRes("/api/documents/doc-42");
    try { await dispatch(req, res); } catch (_) {}
    expect(req.query.id).toBe("doc-42");
  });

  it("static /api/orders takes precedence over the dynamic /api/orders/ prefix", async () => {
    // /orders (no trailing /<id>) hits the static index handler.
    const { req, res } = mockReqRes("/api/orders");
    try { await dispatch(req, res); } catch (_) {}
    // The static handler does not set query.id; the dynamic route
    // would have set req.query.id = "" if it had matched.
    expect(req.query.id).toBeUndefined();
  });

  // The production code path: Vercel rewrites /api/<rest> to
  // /api/dispatch?_p=<rest>. The dispatcher should resolve based on
  // _p and ignore the dispatch URL itself.
  it("resolves a route from the _p query param when Vercel rewrites", async () => {
    const { req, res } = mockReqRes("/api/dispatch?_p=auth/magic_link", "POST");
    try { await dispatch(req, res); } catch (_) { /* handler may fail */ }
    // The auth/magic_link handler exists; we should not see Route-not-found.
    expect(res.statusCode).not.toBe(404);
  });

  it("resolves a dynamic /<group>/<id> route from _p", async () => {
    const { req, res } = mockReqRes("/api/dispatch?_p=orders/abc-789");
    try { await dispatch(req, res); } catch (_) {}
    expect(req.query.id).toBe("abc-789");
  });

  it("merges other query params alongside _p", async () => {
    const { req, res } = mockReqRes("/api/dispatch?_p=orders&limit=25&status=DRAFT");
    try { await dispatch(req, res); } catch (_) {}
    expect(req.query.limit).toBe("25");
    expect(req.query.status).toBe("DRAFT");
    // _p must not leak through into the handler's query object.
    expect(req.query._p).toBeUndefined();
  });

  it("returns a clear error if Vercel rewrite leaves us at /dispatch with empty _p", async () => {
    const { req, res } = mockReqRes("/api/dispatch");
    await dispatch(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Empty path");
  });
});

// Coverage gate: build a list of routes the v3 client expects and
// ensure dispatch returns a non-404 for each. We do this by walking
// every `apiFetch("/api/...")` literal in src/client/obara-client.js
// and testing dispatch on it with an empty body. Failing to match any
// one is a hard regression.
describe("client coverage", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  // import.meta.dirname here = repoRoot/src/v3-app, walk up two levels.
  const ROOT = path.resolve(import.meta.dirname, "..", "..");
  const clientText = fs.readFileSync(path.join(ROOT, "src", "client", "obara-client.js"), "utf8");

  // Pull every literal path. Keep only the bit before any template
  // expression — `?` + `query` + `+ id` etc are not part of routing.
  const literalPaths = new Set();
  for (const m of clientText.matchAll(/apiFetch\(["'`]([^"'`]+)["'`]/g)) {
    let p = m[1];
    p = p.split("?")[0].split("`")[0];
    if (!p.startsWith("/api/")) continue;
    // Skip dynamic-segment prefixes the client concatenates an id onto
    // (e.g. `apiFetch("/api/orders/" + id)`). Those are matched in the
    // dynamic-route tests above.
    if (p.endsWith("/")) continue;
    literalPaths.add(p);
  }

  it("knows about every literal /api/ path the obara-client uses", async () => {
    const missing = [];
    for (const p of literalPaths) {
      const { req, res } = mockReqRes(p);
      try { await dispatch(req, res); } catch (_) { /* handler may fail */ }
      // 404 means the dispatcher could not even resolve a handler.
      if (res.statusCode === 404) missing.push(p);
    }
    if (missing.length) {
      throw new Error(
        `These client paths do not resolve to a handler:\n  ${missing.join("\n  ")}`,
      );
    }
    expect(missing.length).toBe(0);
  });
});
