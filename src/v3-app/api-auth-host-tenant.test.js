// Phase 0 per-tenant domain mapping: host parsing, host->tenant lookup, and the
// resolveContext precedence + membership guard (header > host-if-member > default).
// supabase.js / tenancy.js are mocked so importing auth.js has no real I/O.

import { describe, it, expect, vi } from "vitest";

const USER = { id: "u1" };

// A tiny Supabase query-builder double that is BOTH awaitable (for the direct
// `await svc.from(...).select(...).eq(...)` in resolveContext) and supports
// .maybeSingle() (for the tenants lookups in resolveHostTenant).
function makeSvc({ memberships = [], bySlug = {}, byDomain = {} } = {}) {
  return {
    from(table) {
      const f = {};
      const resolve = () => {
        if (table === "tenant_members") return { data: memberships, error: null };
        if (table === "tenants") {
          if (f.domain != null) return { data: byDomain[f.domain] ? { id: byDomain[f.domain] } : null, error: null };
          if (f.slug != null) return { data: bySlug[f.slug] ? { id: bySlug[f.slug] } : null, error: null };
        }
        return { data: null, error: null };
      };
      const q = {
        select() { return q; },
        eq(c, v) { f[c] = v; return q; },
        ilike(c, v) { f[c] = v; return q; },       // domain lookup uses ilike
        maybeSingle() { return Promise.resolve(resolve()); },
        then(onF, onR) { return Promise.resolve(resolve()).then(onF, onR); },
      };
      return q;
    },
  };
}

let currentSvc = makeSvc();
vi.mock("../api/_lib/supabase.js", () => ({
  userClient: () => ({ auth: { getUser: async () => ({ data: { user: USER }, error: null }) } }),
  serviceClient: () => currentSvc,
}));
vi.mock("../api/_lib/tenancy.js", () => ({
  ensureMembership: async () => [],
  isAutoOnboardEnabled: () => false,
}));

const { hostFromReq, subdomainLabel, resolveHostTenant, resolveContext } = await import("../api/_lib/auth.js");

const reqWith = (host, headers = {}) => ({ headers: { host, ...headers } });

describe("hostFromReq", () => {
  it("prefers x-forwarded-host, strips port, lowercases", () => {
    expect(hostFromReq({ headers: { host: "raw:3000", "x-forwarded-host": "Obara.Anvil.App:443" } })).toBe("obara.anvil.app");
  });
  it("takes the first host in a comma list; empty when absent", () => {
    expect(hostFromReq({ headers: { "x-forwarded-host": "a.anvil.app, b.anvil.app" } })).toBe("a.anvil.app");
    expect(hostFromReq({ headers: {} })).toBe("");
  });
});

describe("subdomainLabel", () => {
  it("returns the leftmost label for sub.domain.tld", () => {
    expect(subdomainLabel("obara.anvil.app")).toBe("obara");
    expect(subdomainLabel("spares.obara.com")).toBe("spares");
  });
  it("returns '' for apex / bare / localhost / IP", () => {
    expect(subdomainLabel("anvil.app")).toBe("");
    expect(subdomainLabel("localhost")).toBe("");
    expect(subdomainLabel("127.0.0.1")).toBe("");
    expect(subdomainLabel("")).toBe("");
  });
});

describe("resolveHostTenant", () => {
  it("matches an explicit full-host domain first", async () => {
    const svc = makeSvc({ byDomain: { "spares.obara.com": "T-DOMAIN" }, bySlug: { spares: "T-SLUG" } });
    expect(await resolveHostTenant(svc, reqWith("spares.obara.com"))).toBe("T-DOMAIN");
  });
  it("falls back to subdomain label -> slug", async () => {
    const svc = makeSvc({ bySlug: { obara: "T-OBARA" } });
    expect(await resolveHostTenant(svc, reqWith("obara.anvil.app"))).toBe("T-OBARA");
  });
  it("returns null when nothing matches, and never throws on svc error", async () => {
    expect(await resolveHostTenant(makeSvc(), reqWith("unknown.anvil.app"))).toBeNull();
    const boom = { from() { throw new Error("db down"); } };
    expect(await resolveHostTenant(boom, reqWith("obara.anvil.app"))).toBeNull();
  });
});

describe("resolveContext — tenant precedence + membership guard", () => {
  const authed = { authorization: "Bearer tok" };

  it("explicit x-anvil-tenant header wins over the host", async () => {
    currentSvc = makeSvc({
      memberships: [{ tenant_id: "T-A", role: "admin", status: "approved" }, { tenant_id: "T-HOST", role: "admin", status: "approved" }],
      bySlug: { obara: "T-HOST" },
    });
    const ctx = await resolveContext(reqWith("obara.anvil.app", { ...authed, "x-anvil-tenant": "T-A" }));
    expect(ctx.tenantId).toBe("T-A");
  });

  it("uses the host tenant when the user is a member and no header is sent", async () => {
    currentSvc = makeSvc({
      memberships: [{ tenant_id: "T-A", role: "sales_engineer", status: "approved" }, { tenant_id: "T-HOST", role: "admin", status: "approved" }],
      bySlug: { obara: "T-HOST" },
    });
    const ctx = await resolveContext(reqWith("obara.anvil.app", authed));
    expect(ctx.tenantId).toBe("T-HOST");
  });

  it("IGNORES a host that maps to a tenant the user is NOT a member of (no cross-tenant access)", async () => {
    currentSvc = makeSvc({
      memberships: [{ tenant_id: "T-A", role: "sales_engineer", status: "approved" }],
      bySlug: { obara: "T-OTHER" },   // resolves to a tenant the user does not belong to
    });
    const ctx = await resolveContext(reqWith("obara.anvil.app", authed));
    expect(ctx.tenantId).toBe("T-A");   // falls back to the user's own membership
  });

  it("falls back to the first membership when the host matches nothing", async () => {
    currentSvc = makeSvc({ memberships: [{ tenant_id: "T-A", role: "admin", status: "approved" }] });
    const ctx = await resolveContext(reqWith("app.anvil.app", authed));
    expect(ctx.tenantId).toBe("T-A");
  });
});
