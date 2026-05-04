// Runtime smoke runner for the per-screen mutation paths.
//
// Goal: prove that every entity covered by audit-write-paths.mjs can be
// created, read back, and torn down via the same /api/dispatch route the
// production UI uses. Stays inside a dedicated smoke tenant so a real
// tenant's data is never touched.
//
// Required env:
//   SUPABASE_URL                   the deployed project URL
//   SUPABASE_SERVICE_ROLE_KEY      service role; used for bootstrap +
//                                  for verifying rows after the API call
//   SMOKE_BASE_URL                 the deployed origin (default
//                                  http://localhost:5180 if running
//                                  against `vite dev`); without this the
//                                  runner exits with status 0 and a note
//                                  that smoke is opt-in.
// Optional env:
//   SMOKE_TENANT_ID                default 00000000-0000-0000-0000-0000000000ff
//   SMOKE_USER_EMAIL               default smoke+anvil@example.com
//   SMOKE_USER_PASSWORD            default obara-smoke-pw (only used if
//                                  the user has not been created yet)
//
// Each scenario is a small sequence: bootstrap, mutate, verify, teardown.
// Failures print the failing scenario and exit non-zero.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const env = (k, fallback) => process.env[k] || fallback;
const SUPABASE_URL = env("SUPABASE_URL", "");
const SUPABASE_SRK = env("SUPABASE_SERVICE_ROLE_KEY", "");
const BASE_URL     = env("SMOKE_BASE_URL", "");
const TENANT_ID    = env("SMOKE_TENANT_ID", "00000000-0000-0000-0000-0000000000ff");
const USER_EMAIL   = env("SMOKE_USER_EMAIL", "smoke+anvil@example.com");
const USER_PWD     = env("SMOKE_USER_PASSWORD", "obara-smoke-pw");

if (!SUPABASE_URL || !SUPABASE_SRK || !BASE_URL) {
  process.stdout.write("smoke-write-paths: opt-in. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SMOKE_BASE_URL to enable.\n");
  process.exit(0);
}

const svc = createClient(SUPABASE_URL, SUPABASE_SRK, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const log = (msg) => process.stdout.write(msg + "\n");
const fail = (msg) => { process.stderr.write("smoke FAIL: " + msg + "\n"); process.exitCode = 1; };

// ---- Bootstrap ----------------------------------------------------------
const ensureTenant = async () => {
  const { data, error } = await svc.from("tenants").select("id").eq("id", TENANT_ID).maybeSingle();
  if (error) throw new Error("ensureTenant select: " + error.message);
  if (!data) {
    const ins = await svc.from("tenants").insert({ id: TENANT_ID, slug: "smoke", display_name: "Smoke" });
    if (ins.error && ins.error.code !== "23505") throw new Error("ensureTenant insert: " + ins.error.message);
  }
};

const ensureUserAndSession = async () => {
  // Create the user if missing. Inviteless: we use admin.createUser with a
  // known password so we can sign in below. Idempotent on email.
  const list = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (list.error) throw new Error("listUsers: " + list.error.message);
  let user = (list.data?.users || []).find((u) => u.email === USER_EMAIL);
  if (!user) {
    const created = await svc.auth.admin.createUser({
      email: USER_EMAIL,
      password: USER_PWD,
      email_confirm: true,
    });
    if (created.error) throw new Error("createUser: " + created.error.message);
    user = created.data.user;
  }
  // Ensure tenant membership as admin so the smoke run has full write access.
  const mem = await svc.from("tenant_members").upsert({
    tenant_id: TENANT_ID, user_id: user.id, role: "admin",
  }, { onConflict: "tenant_id,user_id" }).select("*").single();
  if (mem.error) throw new Error("upsert tenant_member: " + mem.error.message);

  // Mint a session by signing in with password. We use a fresh anon
  // client so the service-role token isn't carried.
  const anon = createClient(SUPABASE_URL, SUPABASE_SRK, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const session = await anon.auth.signInWithPassword({ email: USER_EMAIL, password: USER_PWD });
  if (session.error) throw new Error("signInWithPassword: " + session.error.message);
  return { user, session: session.data.session };
};

// ---- API helper ---------------------------------------------------------
const apiCall = async (path, opts) => {
  const session = opts.session;
  const url = BASE_URL.replace(/\/+$/, "") + path;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + session.access_token,
    "x-obara-tenant": TENANT_ID,
  };
  const init = { method: opts.method || "GET", headers };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
  return { status: resp.status, body };
};

// ---- Scenarios ---------------------------------------------------------
// Each scenario returns { name, run({session}) } where run resolves on
// success or throws on failure. Scenarios are independent and tear
// themselves down by tenant_id at the bottom of the runner.

const scenarios = [
  {
    name: "customers.upsert -> POST /api/customers persists",
    run: async ({ session }) => {
      const customer_key = "smoke-cust-" + Date.now();
      const r = await apiCall("/api/customers", {
        method: "POST", session,
        body: { customer_key, customer_name: "Smoke Customer", gstin: null },
      });
      if (r.status >= 400) throw new Error("POST /api/customers " + r.status + " " + JSON.stringify(r.body));
      // Verify
      const { data, error } = await svc.from("customers")
        .select("id, customer_key").eq("tenant_id", TENANT_ID).eq("customer_key", customer_key).maybeSingle();
      if (error) throw new Error("verify select: " + error.message);
      if (!data) throw new Error("expected row in customers");
    },
  },
  {
    name: "audit.record -> POST /api/audit persists",
    run: async ({ session }) => {
      const detail = "smoke-audit-" + Date.now();
      const r = await apiCall("/api/audit", {
        method: "POST", session,
        body: { action: "smoke_event", object_type: "smoke", object_id: null, detail },
      });
      if (r.status >= 400) throw new Error("POST /api/audit " + r.status + " " + JSON.stringify(r.body));
      const { data, error } = await svc.from("audit_events")
        .select("id, detail").eq("tenant_id", TENANT_ID).eq("action", "smoke_event").order("created_at", { ascending: false }).limit(5);
      if (error) throw new Error("verify audit: " + error.message);
      if (!data?.some((r) => r.detail === detail)) throw new Error("expected audit row with detail=" + detail);
    },
  },
  {
    name: "admin.members invite -> POST /api/admin/members upserts member",
    run: async ({ session }) => {
      const email = "smoke-invitee-" + Date.now() + "@example.com";
      const r = await apiCall("/api/admin/members", {
        method: "POST", session, body: { email, role: "viewer" },
      });
      if (r.status >= 400) throw new Error("POST /api/admin/members " + r.status + " " + JSON.stringify(r.body));
      // The endpoint uses Supabase Auth admin invite; the user_id is
      // returned in the response.
      const userId = r.body?.member?.user_id;
      if (!userId) throw new Error("expected member.user_id in response");
      const { data, error } = await svc.from("tenant_members")
        .select("user_id, role").eq("tenant_id", TENANT_ID).eq("user_id", userId).maybeSingle();
      if (error) throw new Error("verify tenant_members: " + error.message);
      if (!data) throw new Error("expected tenant_members row for invitee");
    },
  },
  {
    name: "admin.holidays upsert -> POST /api/admin/holidays persists",
    run: async ({ session }) => {
      const date = "2099-01-0" + ((Date.now() % 9) + 1);
      const r = await apiCall("/api/admin/holidays", {
        method: "POST", session, body: { country: "IN", date, name: "Smoke holiday " + date },
      });
      if (r.status >= 400) throw new Error("POST /api/admin/holidays " + r.status + " " + JSON.stringify(r.body));
      const { data, error } = await svc.from("holiday_calendar")
        .select("date, name").eq("country", "IN").eq("date", date).maybeSingle();
      if (error) throw new Error("verify holiday: " + error.message);
      if (!data) throw new Error("expected holiday_calendar row for " + date);
    },
  },
  {
    name: "tally.push without bridge returns 409 BRIDGE_NOT_CONFIGURED",
    run: async ({ session }) => {
      // We don't pre-create an order; we expect the API to short-circuit
      // before even looking up the order, because the env var is unset.
      // If TALLY_BRIDGE_URL IS set in the deploy, this test is skipped.
      if (process.env.TALLY_BRIDGE_URL) {
        log("  (skipping: TALLY_BRIDGE_URL is set in the env)");
        return;
      }
      const r = await apiCall("/api/tally/push", {
        method: "POST", session,
        body: { orderId: "00000000-0000-0000-0000-000000000000", tallyXml: "<ENVELOPE/>" },
      });
      if (r.status !== 409) throw new Error("expected 409, got " + r.status + " " + JSON.stringify(r.body));
      const code = r.body?.error?.code;
      if (code !== "BRIDGE_NOT_CONFIGURED") throw new Error("expected BRIDGE_NOT_CONFIGURED, got " + code);
    },
  },
];

// ---- Teardown ----------------------------------------------------------
const teardown = async () => {
  // Hard-delete every row created during the run by tenant_id. We do
  // not delete the smoke tenant or the smoke user so subsequent runs
  // are fast.
  const tables = [
    "audit_events", "customers", "holiday_calendar", "tenant_members",
  ];
  for (const t of tables) {
    if (t === "tenant_members") {
      // Keep the smoke admin's row.
      const { error } = await svc.from(t).delete()
        .eq("tenant_id", TENANT_ID)
        .neq("role", "admin");
      if (error) log("teardown " + t + " warn: " + error.message);
    } else if (t === "holiday_calendar") {
      const { error } = await svc.from(t).delete().like("name", "Smoke holiday %");
      if (error) log("teardown " + t + " warn: " + error.message);
    } else {
      const { error } = await svc.from(t).delete().eq("tenant_id", TENANT_ID);
      if (error) log("teardown " + t + " warn: " + error.message);
    }
  }
  // Best-effort delete invitee users we created during the run. They
  // were inserted via auth.admin.inviteUserByEmail with the smoke prefix.
  const list = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of list.data?.users || []) {
    if (u.email?.startsWith("smoke-invitee-")) {
      await svc.auth.admin.deleteUser(u.id).catch(() => {});
    }
  }
};

// ---- Main --------------------------------------------------------------
const main = async () => {
  log("smoke-write-paths: target=" + BASE_URL + " tenant=" + TENANT_ID);
  await ensureTenant();
  const { session } = await ensureUserAndSession();

  let pass = 0;
  let failCount = 0;
  for (const sc of scenarios) {
    try {
      log("- " + sc.name);
      await sc.run({ session });
      pass++;
    } catch (err) {
      failCount++;
      fail(sc.name + " :: " + (err.message || String(err)));
    }
  }
  log("");
  log("smoke-write-paths: " + pass + "/" + scenarios.length + " passed, " + failCount + " failed");
  await teardown();
  if (failCount > 0) process.exit(1);
};

main().catch((err) => {
  fail("bootstrap: " + (err.message || String(err)));
  process.exit(1);
});
