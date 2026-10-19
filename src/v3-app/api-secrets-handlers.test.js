// Handler-level checks for credential storage and the Tally bridge:
//   - netsuite/connect and auth/mfa refuse (400) without ANVIL_SECRETS_KEY
//     and store nothing; with the key they store v2 values only.
//   - tally/companies rejects a plain-http bridge URL (localhost excepted).
//   - tally/validate's dry run uses only the resolved company's URL and
//     token, never the env bridge token for another tenant's URL.
//   - admin/secrets_reencrypt is admin-only; GET is a dry run, POST applies
//     and is audited.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openField, encryptField } from "../api/_lib/secrets.js";

const h = vi.hoisted(() => ({
  ctx: null, calls: [], single: {}, list: {}, fetches: [], audits: [], settingsUpdates: [],
}));

// supabase-js stand-in: every chain records its calls; awaiting it yields
// h.list[table], and single()/maybeSingle() yield h.single[table].
const chain = (table) => {
  const rec = { table, ops: [] };
  h.calls.push(rec);
  const p = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve) => resolve({ data: h.list[table] || [], error: null, count: 0 });
      if (prop === "maybeSingle" || prop === "single") {
        return async () => {
          const v = h.single[table];
          return { data: (typeof v === "function" ? v(rec) : v) ?? null, error: null };
        };
      }
      return (...args) => { rec.ops.push([prop, ...args]); return p; };
    },
  });
  return p;
};
const opsOn = (table, op) => h.calls.filter((c) => c.table === table).flatMap((c) => c.ops.filter((o) => o[0] === op));

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: (t) => chain(t) }) }));
vi.mock("../api/_lib/auth.js", async () => {
  const actual = await vi.importActual("../api/_lib/auth.js");
  return { ...actual, resolveContext: async () => h.ctx };
});
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req.body,
  json: (res, status, body) => { res.__status = status; res.__body = body; return res; },
  sendError: (res, err) => { res.__status = err?.status || 500; res.__body = { error: { message: err?.message } }; return res; },
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (_ctx, payload) => { h.audits.push(payload); },
  recordEvent: async () => {},
}));
vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: async () => ({}),
  updateTenantSettings: async (_svc, _t, patch) => { h.settingsUpdates.push(patch); return { ...patch }; },
}));
vi.mock("../api/_lib/netsuite-client.js", () => ({
  netsuiteFetch: async () => ({ ok: false, status: 401, body: {} }),
}));
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (url, init) => {
    h.fetches.push({ url, init });
    return { ok: true, status: 200, text: async () => "<ENVELOPE/>" };
  },
}));

const KEY = "e".repeat(64);
const ADMIN = { tenantId: "t-1", user: { id: "u-1", email: "a@example.com" }, role: "admin" };

const HANDLERS = {
  "netsuite/connect": () => import("../api/netsuite/connect.js"),
  "auth/mfa": () => import("../api/auth/mfa.js"),
  "tally/companies": () => import("../api/tally/companies.js"),
  "tally/validate": () => import("../api/tally/validate.js"),
  "admin/secrets_reencrypt": () => import("../api/admin/secrets_reencrypt.js"),
  "tally/health": () => import("../api/tally/health.js"),
};

const call = async (path, req) => {
  const handler = (await HANDLERS[path]()).default;
  const res = { setHeader: () => {}, end: () => {}, __status: 0, __body: null };
  await handler({ headers: {}, on: () => {}, query: {}, ...req }, res);
  return res;
};

const ENV = ["ANVIL_SECRETS_KEY", "TALLY_BRIDGE_URL", "TALLY_BRIDGE_TOKEN", "TALLY_BRIDGE_TENANT_ID"];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.ANVIL_SECRETS_KEY = KEY;
  h.ctx = ADMIN; h.calls = []; h.single = {}; h.list = {}; h.fetches = []; h.audits = []; h.settingsUpdates = [];
});
afterEach(() => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const NS_BODY = { account_id: "1234567", consumer_key: "ck", consumer_secret: "cs", token_id: "ti", token_secret: "ts" };

describe("netsuite/connect", () => {
  it("refuses with 400 and stores nothing without ANVIL_SECRETS_KEY", async () => {
    delete process.env.ANVIL_SECRETS_KEY;
    const res = await call("netsuite/connect", { method: "POST", body: NS_BODY });
    expect(res.__status).toBe(400);
    expect(h.settingsUpdates).toHaveLength(0);
  });

  it("stores each credential as its own v2 value and nulls the plaintext columns", async () => {
    await call("netsuite/connect", { method: "POST", body: NS_BODY });
    const patch = h.settingsUpdates[0];
    expect(openField(patch.netsuite_consumer_key_enc)).toEqual({ plaintext: "ck", version: 2 });
    expect(openField(patch.netsuite_token_secret_enc)).toEqual({ plaintext: "ts", version: 2 });
    expect(patch.netsuite_consumer_key).toBeNull();
    expect(patch.netsuite_token_secret).toBeNull();
    expect(patch).not.toHaveProperty("netsuite_creds_iv");
  });
});

describe("auth/mfa enroll", () => {
  it("refuses with 400 and writes no TOTP secret without ANVIL_SECRETS_KEY", async () => {
    delete process.env.ANVIL_SECRETS_KEY;
    const res = await call("auth/mfa", { method: "POST", body: { action: "enroll" } });
    expect(res.__status).toBe(400);
    expect(opsOn("user_security_settings", "insert")).toHaveLength(0);
    expect(opsOn("user_security_settings", "update")).toHaveLength(0);
  });

  it("verify reads a pending secret stored with no IV column", async () => {
    h.single.user_security_settings = {
      user_id: "u-1",
      totp_pending_secret_enc: encryptField("JBSWY3DPEHPK3PXP"),
      totp_pending_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const res = await call("auth/mfa", { method: "POST", body: { action: "verify", code: "000000" } });
    // 401 = the secret was read and the code checked against it (a reader
    // that could not read it answers 400 "No pending enrollment").
    expect(res.__status).toBe(401);
    expect(res.__body.error.code).toBe("INVALID_CODE");
  });

  it("stores the pending secret as a v2 value only", async () => {
    const res = await call("auth/mfa", { method: "POST", body: { action: "enroll" } });
    expect(res.__status).toBe(200);
    const row = opsOn("user_security_settings", "insert")[0][1];
    expect(openField(row.totp_pending_secret_enc).version).toBe(2);
    expect(row.totp_pending_secret).toBeNull();
    expect(row.totp_pending_secret_iv).toBeNull();
  });
});

describe("tally/companies bridge URL", () => {
  beforeEach(() => {
    h.single.tally_companies = (rec) => {
      const ins = rec.ops.find((o) => o[0] === "insert");
      return ins ? { id: "co-1", ...ins[1] } : null;
    };
  });

  it("rejects a plain-http bridge URL on create, and inserts nothing", async () => {
    const res = await call("tally/companies", { method: "POST", body: { name: "Acme", bridge_url: "http://bridge.example.com" } });
    expect(res.__status).toBe(400);
    expect(res.__body.error.code).toBe("BRIDGE_URL_INSECURE");
    expect(opsOn("tally_companies", "insert")).toHaveLength(0);
  });

  it("rejects a plain-http bridge URL on update, and updates nothing", async () => {
    const res = await call("tally/companies", { method: "PATCH", query: { id: "co-1" }, body: { bridge_url: "http://bridge.example.com" } });
    expect(res.__status).toBe(400);
    expect(opsOn("tally_companies", "update")).toHaveLength(0);
  });

  it("accepts https and stores the token as a v2 value", async () => {
    const res = await call("tally/companies", { method: "POST", body: { name: "Acme", bridge_url: "https://bridge.example.com", bridge_token: "tok" } });
    expect(res.__status).toBe(200);
    const row = opsOn("tally_companies", "insert")[0][1];
    expect(row.bridge_url).toBe("https://bridge.example.com");
    expect(row.bridge_token).toBeNull();
    expect(row.bridge_iv).toBeNull();
    expect(openField(row.bridge_token_enc)).toEqual({ plaintext: "tok", version: 2 });
  });

  it("accepts plain http for localhost", async () => {
    const res = await call("tally/companies", { method: "POST", body: { name: "Dev", bridge_url: "http://localhost:9000" } });
    expect(res.__status).toBe(200);
  });
});

describe("tally/validate dry run", () => {
  const body = { salesOrder: { voucherNo: "V1", date: "2026-10-01", lineItems: [] }, attemptDryRun: true, tallyXml: "<ENVELOPE/>" };

  it("does not use the env bridge for a tenant it does not serve", async () => {
    process.env.TALLY_BRIDGE_URL = "https://env-bridge.example.com";
    process.env.TALLY_BRIDGE_TOKEN = "env-token";
    process.env.TALLY_BRIDGE_TENANT_ID = "someone-else";
    const res = await call("tally/validate", { method: "POST", body });
    expect(res.__status).toBe(200);
    expect(res.__body.remote).toEqual({ skipped: true, reason: "not_configured" });
    expect(h.fetches).toHaveLength(0);
  });

  it("never sends the env bridge token to the tenant's own bridge URL", async () => {
    process.env.TALLY_BRIDGE_URL = "https://env-bridge.example.com";
    process.env.TALLY_BRIDGE_TOKEN = "env-token";
    h.single.tally_companies = { id: "co-1", tenant_id: "t-1", bridge_url: "https://own-bridge.example.com" };
    await call("tally/validate", { method: "POST", body });
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0].url).toBe("https://own-bridge.example.com");
    expect(h.fetches[0].init.headers.Authorization).toBeUndefined();
  });

  it("does not call a plain-http bridge", async () => {
    h.single.tally_companies = { id: "co-1", tenant_id: "t-1", bridge_url: "http://own-bridge.example.com" };
    const res = await call("tally/validate", { method: "POST", body });
    expect(h.fetches).toHaveLength(0);
    expect(res.__body.remote.status).toBe(0);
  });
});

describe("tally/health", () => {
  it("reports the env bridge as configured only for the tenant it serves", async () => {
    process.env.TALLY_BRIDGE_URL = "https://env-bridge.example.com";
    process.env.TALLY_BRIDGE_TENANT_ID = "someone-else";
    expect((await call("tally/health", { method: "GET" })).__body.configured).toBe(false);
    process.env.TALLY_BRIDGE_TENANT_ID = ADMIN.tenantId;
    expect((await call("tally/health", { method: "GET" })).__body.configured).toBe(true);
  });
});

describe("admin/secrets_reencrypt", () => {
  it("is admin-only", async () => {
    h.ctx = { ...ADMIN, role: "sales_manager" };
    const res = await call("admin/secrets_reencrypt", { method: "POST" });
    expect(res.__status).toBe(403);
    expect(h.calls.filter((c) => c.table === "tenant_settings")).toHaveLength(0);
  });

  it("refuses with 400 without ANVIL_SECRETS_KEY", async () => {
    delete process.env.ANVIL_SECRETS_KEY;
    const res = await call("admin/secrets_reencrypt", { method: "POST" });
    expect(res.__status).toBe(400);
  });

  it("GET is a dry run with no audit; POST applies and is audited", async () => {
    const dry = await call("admin/secrets_reencrypt", { method: "GET" });
    expect(dry.__status).toBe(200);
    expect(dry.__body.apply).toBe(false);
    expect(h.audits).toHaveLength(0);
    const run = await call("admin/secrets_reencrypt", { method: "POST" });
    expect(run.__status).toBe(200);
    expect(run.__body.apply).toBe(true);
    expect(h.audits.map((a) => a.action)).toEqual(["secrets_reencrypted"]);
  });
});
