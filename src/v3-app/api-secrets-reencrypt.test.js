// The one-off re-encryption path (src/api/_lib/secrets-reencrypt.js):
// rewrites a tenant's old-format credentials (one IV per bundle) as v2
// values (own IV each). Run against an in-memory stand-in for supabase-js.

import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encryptField, openField } from "../api/_lib/secrets.js";
import { reencryptTenantSecrets, planBundle } from "../api/_lib/secrets-reencrypt.js";

const HEX_KEY = "d".repeat(64);
const T1 = "tenant-1";
const T2 = "tenant-2";

let savedKey;
beforeAll(() => { savedKey = process.env.ANVIL_SECRETS_KEY; process.env.ANVIL_SECRETS_KEY = HEX_KEY; });
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANVIL_SECRETS_KEY;
  else process.env.ANVIL_SECRETS_KEY = savedKey;
});

// A value in the old format: ciphertext || tag under the bundle IV.
const legacy = (plaintext, ivHex) => {
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(HEX_KEY, "hex"), Buffer.from(ivHex, "hex"));
  return "\\x" + Buffer.concat([c.update(plaintext, "utf8"), c.final(), c.getAuthTag()]).toString("hex");
};
const ivOf = (enc) => Buffer.from(enc.slice(2), "hex").subarray(3, 15).toString("hex");
const IV_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const IV_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
// Real Azure tokens run to a few KB each: too long to send as filters.
const ACCESS = "access-" + "a".repeat(2500);
const REFRESH = "refresh-" + "r".repeat(2500);
const EXPIRES = "2026-10-17T10:00:00.000+00:00";

// In-memory supabase-js stand-in: select/update with eq/is filters, awaited
// as a thenable. `beforeUpdate` runs just before an update is applied, to
// model a save that lands between the read and the write. Filters travel in
// the URL, so a query whose filter values pass URL_LIMIT fails as PostgREST
// would.
const URL_LIMIT = 8000;
const fakeDb = (tables) => {
  const db = { tables, updates: [], beforeUpdate: null };
  db.from = (table) => {
    const filters = [];
    let urlLen = 0;
    let patch = null;
    const run = () => {
      const rows = tables[table];
      if (!rows) return { data: null, error: { message: "relation \"" + table + "\" does not exist" } };
      if (urlLen > URL_LIMIT) return { data: null, error: { message: "414 URI Too Long" } };
      if (patch) {
        if (db.beforeUpdate) { const f = db.beforeUpdate; db.beforeUpdate = null; f(); }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of hit) Object.assign(r, patch);
        db.updates.push({ table, patch, matched: hit.length });
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return { data: rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
    };
    const q = {
      select: () => q,
      update: (p) => { patch = p; return q; },
      eq: (col, v) => { urlLen += String(v).length; filters.push((r) => r[col] === v); return q; },
      is: (col, v) => { filters.push((r) => (r[col] ?? null) === v); return q; },
      then: (resolve, reject) => { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return q;
  };
  return db;
};

const seed = () => {
  const settings1 = {
    tenant_id: T1,
    // Two ERP fields sharing one IV: the old layout.
    sap_client_id_enc: legacy("sap-id", IV_A),
    sap_client_secret_enc: legacy("sap-secret", IV_A),
    sap_creds_iv: "\\x" + IV_A,
    // DocAI: one key still old-format, one already v2.
    docai_gemini_api_key_enc: legacy("gem-key", IV_B),
    docai_mistral_api_key_enc: encryptField("mis-key"),
    docai_creds_iv: "\\x" + IV_B,
    // Graph tokens, guarded by graph_token_expires_at.
    graph_access_token_enc: legacy(ACCESS, IV_A),
    graph_refresh_token_enc: legacy(REFRESH, IV_A),
    graph_token_iv: "\\x" + IV_A,
    graph_token_expires_at: EXPIRES,
    // A value nothing can decrypt (wrong IV): reported, never touched.
    razorpay_key_secret_enc: legacy("rzp", IV_B),
    razorpay_creds_iv: "\\x" + IV_A,
  };
  const settings2 = {
    tenant_id: T2,
    sap_client_id_enc: legacy("t2-id", IV_A),
    sap_client_secret_enc: legacy("t2-secret", IV_A),
    sap_creds_iv: "\\x" + IV_A,
    // Same expiry as tenant 1: the Graph guard alone cannot tell the rows apart.
    graph_access_token_enc: legacy("t2-access", IV_A),
    graph_refresh_token_enc: legacy("t2-refresh", IV_A),
    graph_token_iv: "\\x" + IV_A,
    graph_token_expires_at: EXPIRES,
  };
  return {
    tenant_settings: [settings1, settings2],
    tally_companies: [{ id: "co-1", tenant_id: T1, bridge_token_enc: legacy("bridge", IV_B), bridge_iv: "\\x" + IV_B }],
    plm_systems: [],
    inbound_chat_configs: [],
    // voice_configs is missing on purpose: an unapplied migration.
  };
};

describe("planBundle", () => {
  it("plans a rewrite only for old-format values", () => {
    const row = { a_enc: legacy("one", IV_A), b_enc: encryptField("two"), c_enc: null, x_iv: "\\x" + IV_A };
    const plan = planBundle(row, { iv: "x_iv", fields: ["a_enc", "b_enc", "c_enc"] });
    expect(Object.keys(plan.patch)).toEqual(["a_enc"]);
    expect(openField(plan.patch.a_enc)).toEqual({ plaintext: "one", version: 2 });
    expect(plan.v2).toBe(1);
    expect(plan.unreadable).toEqual([]);
  });
});

describe("reencryptTenantSecrets", () => {
  it("dry run counts the old-format values and writes nothing", async () => {
    const db = fakeDb(seed());
    const before = JSON.stringify(db.tables);
    const report = await reencryptTenantSecrets(db, T1, { apply: false });
    expect(report.apply).toBe(false);
    // sap 2 + gemini 1 + graph 2 + tally 1
    expect(report.totals.v1).toBe(6);
    expect(report.totals.rewritten).toBe(0);
    expect(db.updates).toHaveLength(0);
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it("rewrites every old-format value as v2 with its own IV and the same plaintext", async () => {
    const db = fakeDb(seed());
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(report.totals.rewritten).toBe(6);
    const s = db.tables.tenant_settings[0];
    const cols = ["sap_client_id_enc", "sap_client_secret_enc", "docai_gemini_api_key_enc",
      "graph_access_token_enc", "graph_refresh_token_enc"];
    const plain = ["sap-id", "sap-secret", "gem-key", ACCESS, REFRESH];
    cols.forEach((col, i) => expect(openField(s[col])).toEqual({ plaintext: plain[i], version: 2 }));
    expect(new Set(cols.map((c) => ivOf(s[c]))).size).toBe(cols.length);
    expect(openField(db.tables.tally_companies[0].bridge_token_enc)).toEqual({ plaintext: "bridge", version: 2 });
    // The IV columns are left as they were.
    expect(s.sap_creds_iv).toBe("\\x" + IV_A);
    expect(db.tables.tally_companies[0].bridge_iv).toBe("\\x" + IV_B);
  });

  it("is idempotent: a second run rewrites nothing and leaves the values byte-identical", async () => {
    const db = fakeDb(seed());
    await reencryptTenantSecrets(db, T1, { apply: true });
    const after1 = JSON.stringify(db.tables);
    const writes1 = db.updates.length;
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(report.totals.v1).toBe(0);
    expect(report.totals.rewritten).toBe(0);
    expect(report.totals.already_v2).toBe(7);   // the 6 rewritten + mistral
    expect(db.updates.length).toBe(writes1);
    expect(JSON.stringify(db.tables)).toBe(after1);
  });

  it("leaves a value it cannot decrypt untouched and reports it", async () => {
    const db = fakeDb(seed());
    const bad = db.tables.tenant_settings[0].razorpay_key_secret_enc;
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(db.tables.tenant_settings[0].razorpay_key_secret_enc).toBe(bad);
    const ts = report.tables.find((t) => t.table === "tenant_settings");
    expect(ts.unreadable).toEqual(["razorpay_key_secret_enc"]);
    expect(report.totals.unreadable).toBe(1);
  });

  it("touches only the caller's tenant", async () => {
    const db = fakeDb(seed());
    const other = JSON.stringify(db.tables.tenant_settings[1]);
    await reencryptTenantSecrets(db, T1, { apply: true });
    expect(JSON.stringify(db.tables.tenant_settings[1])).toBe(other);
  });

  it("rewrites the Graph tokens even though they are too long to filter on", async () => {
    const db = fakeDb(seed());
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(report.totals.errors).toBe(1);   // only the missing voice_configs table
    expect(openField(db.tables.tenant_settings[0].graph_refresh_token_enc)).toEqual({ plaintext: REFRESH, version: 2 });
  });

  it("does not overwrite a credential saved between the read and the write", async () => {
    const db = fakeDb(seed());
    const fresh = encryptField("sap-secret-NEW");
    // The first update is the SAP bundle; a connect lands just before it.
    db.beforeUpdate = () => { db.tables.tenant_settings[0].sap_client_secret_enc = fresh; };
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(db.tables.tenant_settings[0].sap_client_secret_enc).toBe(fresh);
    expect(report.totals.conflicts).toBe(1);
    // A re-run picks up what is still old-format.
    const again = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(again.totals.rewritten).toBe(1);   // sap_client_id_enc
    expect(openField(db.tables.tenant_settings[0].sap_client_secret_enc).plaintext).toBe("sap-secret-NEW");
  });

  it("guards the Graph tokens on graph_token_expires_at", async () => {
    const db = fakeDb(seed());
    const fresh = encryptField("access-NEW");
    // Fire the hook on the Graph-token update only: a token refresh lands first.
    let n = 0;
    const realFrom = db.from;
    db.from = (table) => {
      const q = realFrom(table);
      const update = q.update;
      q.update = (p) => {
        if ("graph_access_token_enc" in p) {
          n += 1;
          db.beforeUpdate = () => {
            const s = db.tables.tenant_settings[0];
            s.graph_access_token_enc = fresh;
            s.graph_token_expires_at = "2026-10-17T11:00:00.000+00:00";
          };
        }
        return update(p);
      };
      return q;
    };
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    expect(n).toBe(1);
    expect(db.tables.tenant_settings[0].graph_access_token_enc).toBe(fresh);
    expect(report.totals.conflicts).toBe(1);
  });

  it("reports a table the live schema lacks and still processes the rest", async () => {
    const db = fakeDb(seed());
    const report = await reencryptTenantSecrets(db, T1, { apply: true });
    const voice = report.tables.find((t) => t.table === "voice_configs");
    expect(voice.error).toMatch(/does not exist/);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.rewritten).toBe(6);
  });

  it("never puts a plaintext credential in the report", async () => {
    const db = fakeDb(seed());
    const report = JSON.stringify(await reencryptTenantSecrets(db, T1, { apply: true }));
    for (const secret of ["sap-id", "sap-secret", "gem-key", "mis-key", ACCESS, REFRESH, "bridge", "rzp"]) {
      expect(report.includes('"' + secret + '"')).toBe(false);
    }
  });
});
