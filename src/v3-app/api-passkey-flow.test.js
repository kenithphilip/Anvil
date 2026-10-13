// @vitest-environment node
//
// Passkey registration and sign-in, end to end, through the real handlers
// and the REAL @simplewebauthn/server. A software authenticator built on
// node:crypto produces genuine attestation and assertion payloads, so the
// library's input and output shapes are exercised, not mocked. Only
// Supabase, CORS, the auth context, the user lookup and tenancy are faked.
//
// Why this exists: the handlers were written against the v10 shapes
// (registrationInfo.credentialID / credentialPublicKey, and an
// `authenticator` argument to verifyAuthenticationResponse). v11 moved both
// to `credential: { id, publicKey, counter, transports }`, so on v11 and on
// v14 every registration threw after a good verify and every sign-in threw
// inside the library. A source-regex test could not see that.
//
// Node, not jsdom: the library verifies signatures with WebCrypto.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const ORIGIN = "https://anvil.example.com";
const RP_ID = "anvil.example.com";
const USER = {
  id: "00000000-0000-0000-0000-0000000000a1",
  email: "operator@example.com",
  user_metadata: { name: "Test Operator" },
};

const H = vi.hoisted(() => ({ db: null, ctx: null }));

// ---------- an in-memory Supabase, just wide enough for the handlers ----------
let seq = 0;
const likeToRe = (p) => new RegExp("^" + String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
const makeDb = () => {
  const tables = { user_passkeys: [], user_security_settings: [], user_security_audit: [] };
  return {
    tables,
    auth: {
      admin: {
        generateLink: async ({ email }) => ({
          data: { properties: { action_link: "https://db.example.com/auth/v1/verify?token=tok-" + encodeURIComponent(email) + "&type=magiclink" } },
          error: null,
        }),
      },
    },
    from(table) {
      const rows = tables[table] || (tables[table] = []);
      const filters = [];
      let op = "select";
      let payload = null;
      let onConflict = null;
      const run = async () => {
        if (op === "insert") {
          const out = payload.map((r) => ({ id: "row-" + (++seq), ...r }));
          rows.push(...out);
          return { data: out, error: null };
        }
        if (op === "upsert") {
          for (const r of payload) {
            const hit = onConflict ? rows.find((x) => x[onConflict] === r[onConflict]) : null;
            if (hit) Object.assign(hit, r);
            else rows.push({ id: "row-" + (++seq), ...r });
          }
          return { data: null, error: null };
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "delete") {
          for (const r of hit) rows.splice(rows.indexOf(r), 1);
          return { data: null, error: null };
        }
        if (op === "update") {
          for (const r of hit) Object.assign(r, payload);
          return { data: null, error: null };
        }
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const api = {
        select() { return api; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
        not(c, operator, pattern) {
          if (operator !== "like") throw new Error("fake db: unsupported not(" + operator + ")");
          const re = likeToRe(pattern);
          filters.push((r) => !re.test(String(r[c])));
          return api;
        },
        order() { return api; },
        insert(r) { op = "insert"; payload = Array.isArray(r) ? r : [r]; return api; },
        upsert(r, opts) { op = "upsert"; payload = Array.isArray(r) ? r : [r]; onConflict = opts?.onConflict || null; return api; },
        update(p) { op = "update"; payload = p; return api; },
        delete() { op = "delete"; return api; },
        maybeSingle: () => run().then((r) => ({ data: r.data?.[0] || null, error: r.error })),
        then: (f, rj) => run().then(f, rj),
      };
      return api;
    },
  };
};

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db }));
vi.mock("../api/_lib/auth.js", () => ({ resolveContext: async () => H.ctx }));
vi.mock("../api/_lib/auth-user-lookup.js", () => ({
  findUserByEmail: async (_svc, email) => ({ exhaustive: true, user: email === USER.email ? USER : null }),
}));
vi.mock("../api/_lib/tenancy.js", () => ({
  ensureMembership: async () => {},
  getMemberStatus: async () => ({ status: "approved" }),
  defaultTenantId: () => "00000000-0000-0000-0000-0000000000aa",
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      verifyOtp: async ({ email, token }) => ({
        data: { session: { access_token: "access-" + token, refresh_token: "refresh-" + email, expires_at: 1900000000 } },
        error: null,
      }),
    },
  }),
}));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {},
  handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));

const call = async (handler, body) => {
  const res = { setHeader() {}, _status: 0, _json: null };
  await handler({ method: "POST", headers: {}, _body: body }, res);
  return res;
};

// ---------- a software authenticator: ES256, "none" attestation ----------
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const UP_UV = 0x01 | 0x04;
const AT = 0x40;

const makeAuthenticator = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = Buffer.from(isoCBOR.encode(new Map([
    [1, 2],                                                   // kty: EC2
    [3, -7],                                                  // alg: ES256
    [-1, 1],                                                  // crv: P-256
    [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
    [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
  ])));
  const rawId = crypto.randomBytes(16);
  const id = b64url(rawId);
  let counter = 0;
  return {
    id,
    coseKey,
    // What @simplewebauthn/browser's startRegistration() resolves with.
    register(options) {
      const authData = Buffer.concat([
        sha256(options.rp.id), Buffer.from([UP_UV | AT]), u32(counter),
        Buffer.alloc(16), u16(rawId.length), rawId, coseKey,
      ]);
      const attestationObject = isoCBOR.encode(new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]));
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false,
      }));
      return {
        id, rawId: id, type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["internal", "hybrid"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    // What startAuthentication() resolves with.
    assert(options, { tamper = false } = {}) {
      counter += 1;
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([UP_UV]), u32(counter)]);
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.get", challenge: options.challenge, origin: ORIGIN, crossOrigin: false,
      }));
      const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
      if (tamper) signed[0] ^= 0xff;
      const signature = crypto.sign("sha256", signed, privateKey);   // DER, as authenticators emit
      return {
        id, rawId: id, type: "public-key",
        response: {
          authenticatorData: b64url(authData),
          clientDataJSON: b64url(clientDataJSON),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
};

const realPasskeys = () => H.db.tables.user_passkeys.filter((r) => !/::/.test(r.credential_id));

const registerBegin = async () => (await import("../api/auth/passkey/register_begin.js")).default;
const registerFinish = async () => (await import("../api/auth/passkey/register_finish.js")).default;
const authBegin = async () => (await import("../api/auth/passkey/auth_begin.js")).default;
const authFinish = async () => (await import("../api/auth/passkey/auth_finish.js")).default;

const enroll = async (authenticator, label = "Test laptop") => {
  const begin = await call(await registerBegin(), { label });
  expect(begin._status).toBe(200);
  const finish = await call(await registerFinish(), {
    pending_id: begin._json.pending_id,
    response: authenticator.register(begin._json.options),
  });
  return { begin, finish };
};

beforeEach(() => {
  vi.stubEnv("APP_URL", ORIGIN);
  vi.stubEnv("SUPABASE_URL", "https://db.example.com");
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key-for-tests");
  H.db = makeDb();
  H.ctx = { user: USER };
});

describe("passkey registration (real @simplewebauthn/server)", () => {
  it("offers only the pinned algorithms, never ML-DSA, whatever the runtime supports", async () => {
    const res = await call(await registerBegin(), { label: "x" });
    expect(res._status).toBe(200);
    const { options } = res._json;
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    expect(options.rp).toEqual({ name: "Anvil", id: RP_ID });
    expect(options.user.id).toBe(Buffer.from(USER.id).toString("base64url"));
    expect(options.attestation).toBe("none");
    // The challenge is held as a hash on a placeholder row, never raw.
    const pending = H.db.tables.user_passkeys.find((r) => r.credential_id === res._json.pending_id);
    expect(pending.pending_challenge_hash).toBe(sha256(options.challenge).toString("hex"));
  });

  it("stores credential.id, publicKey, counter and transports from registrationInfo.credential", async () => {
    const authenticator = makeAuthenticator();
    const { begin, finish } = await enroll(authenticator);

    expect(finish._status).toBe(200);
    expect(finish._json).toEqual({ ok: true, credential_id: authenticator.id });

    const rows = realPasskeys();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER.id,
      credential_id: authenticator.id,
      public_key: authenticator.coseKey.toString("base64"),
      counter: 0,
      transports: ["internal", "hybrid"],
      label: "Test laptop",
      device_type: "singleDevice",
    });
    // The placeholder that held the challenge is gone.
    expect(H.db.tables.user_passkeys.some((r) => r.credential_id === begin._json.pending_id)).toBe(false);
    expect(H.db.tables.user_security_settings[0]).toMatchObject({ user_id: USER.id, passkey_enrolled: true });
  });

  it("excludes the enrolled credential from the next registration", async () => {
    const authenticator = makeAuthenticator();
    await enroll(authenticator);
    const again = await call(await registerBegin(), { label: "second" });
    expect(again._json.options.excludeCredentials.map((c) => c.id)).toEqual([authenticator.id]);
  });
});

describe("passkey sign-in (real @simplewebauthn/server)", () => {
  it("verifies an assertion against the stored credential, bumps the counter and mints a session", async () => {
    const authenticator = makeAuthenticator();
    const { finish } = await enroll(authenticator);
    expect(finish._status).toBe(200);

    const begin = await call(await authBegin(), { email: USER.email });
    expect(begin._status).toBe(200);
    expect(begin._json.options.rpId).toBe(RP_ID);
    expect(begin._json.options.allowCredentials).toEqual([
      { id: authenticator.id, type: "public-key", transports: ["internal", "hybrid"] },
    ]);

    const res = await call(await authFinish(), {
      email: USER.email,
      challenge_id: begin._json.challenge_id,
      response: authenticator.assert(begin._json.options),
    });
    expect(res._status).toBe(200);
    expect(res._json.user).toMatchObject({ id: USER.id, email: USER.email });
    expect(res._json.session.access_token).toBe("access-tok-" + USER.email);

    expect(realPasskeys()[0].counter).toBe(1);
    expect(H.db.tables.user_passkeys.some((r) => r.credential_id === begin._json.challenge_id)).toBe(false);
    expect(H.db.tables.user_security_audit.map((a) => a.event)).toContain("passkey_login_ok");
  });

  it("refuses an assertion whose signature does not match the stored key", async () => {
    const authenticator = makeAuthenticator();
    await enroll(authenticator);
    const begin = await call(await authBegin(), { email: USER.email });

    const res = await call(await authFinish(), {
      email: USER.email,
      challenge_id: begin._json.challenge_id,
      response: authenticator.assert(begin._json.options, { tamper: true }),
    });
    expect(res._status).toBe(401);
    expect(res._json.error.code).toBe("PASSKEY_FAIL");
    expect(realPasskeys()[0].counter).toBe(0);
    expect(H.db.tables.user_security_audit.map((a) => a.event)).toContain("passkey_login_fail");
  });
});
