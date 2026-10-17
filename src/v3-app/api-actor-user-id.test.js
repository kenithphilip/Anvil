// Every handler that records an actor records ctx.user.id.
//
// resolveContext returns { user, tenantId, role, anonymous } and never sets
// userId. These handlers used to read ctx.userId, so each one stored a null
// actor, and push subscribe / unsubscribe refused every caller with a 401.
// Each test drives the real handler against an in-memory Supabase stand-in
// and checks the row the handler wrote. The real requirePermission runs, and
// a request without a context goes through the real resolveContext.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0 }));

vi.mock("../api/_lib/supabase.js", () => {
  const from = (table) => {
    const st = { op: "select", payload: null, opts: {}, filters: [] };
    const rows = () => (H.store[table] = H.store[table] || []);
    const hit = (r) => st.filters.every((f) => f(r));
    const run = () => {
      const store = rows();
      if (st.op === "insert" || st.op === "upsert") {
        const items = Array.isArray(st.payload) ? st.payload : [st.payload];
        const out = [];
        for (const it of items) {
          if (st.op === "upsert" && st.opts.onConflict) {
            const keys = st.opts.onConflict.split(",").map((k) => k.trim());
            const ex = store.find((r) => keys.every((k) => r[k] === it[k]));
            if (ex) { if (!st.opts.ignoreDuplicates) Object.assign(ex, it); out.push(ex); continue; }
          }
          const rec = { id: table + "-" + (++H.seq), ...it };
          store.push(rec);
          out.push(rec);
        }
        return out;
      }
      const matched = store.filter(hit);
      if (st.op === "update") for (const r of matched) Object.assign(r, st.payload);
      if (st.op === "delete") H.store[table] = store.filter((r) => !hit(r));
      return matched;
    };
    const settle = (mode) => {
      const out = run();
      if (mode === "many") return Promise.resolve({ data: out, error: null });
      if (out.length > 1 || (mode === "single" && out.length === 0)) {
        return Promise.resolve({ data: null, error: { code: "PGRST116", message: "expected one row, got " + out.length } });
      }
      return Promise.resolve({ data: out[0] || null, error: null });
    };
    const q = {
      select() { return q; },
      insert(p) { st.op = "insert"; st.payload = p; return q; },
      upsert(p, o) { st.op = "upsert"; st.payload = p; st.opts = o || {}; return q; },
      update(p) { st.op = "update"; st.payload = p; return q; },
      delete() { st.op = "delete"; return q; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return q; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return q; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return q; },
      gte(c, v) { st.filters.push((r) => r[c] != null && r[c] >= v); return q; },
      lt(c, v) { st.filters.push((r) => r[c] != null && r[c] < v); return q; },
      // PostgREST "col.eq.value" alternatives, the only form these handlers send.
      or(expr) {
        const alts = expr.split(",").map((s) => {
          const [col, op, ...rest] = s.split(".");
          return { col, op, v: rest.join(".") };
        });
        st.filters.push((r) => alts.some((a) => a.op === "eq" && r[a.col] != null && String(r[a.col]) === a.v));
        return q;
      },
      order() { return q; },
      limit() { return q; },
      single() { return settle("single"); },
      maybeSingle() { return settle("maybe"); },
      then(res, rej) { return settle("many").then(res, rej); },
    };
    return q;
  };
  return {
    serviceClient: () => ({ from }),
    userClient: () => { throw new Error("userClient is not used in these tests"); },
  };
});

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // A test passes the context resolveContext would build as req._ctx. With
    // none, the real resolveContext runs, so a request with no Authorization
    // header gets the real 401.
    resolveContext: async (req) => (req._ctx ? req._ctx : real.resolveContext(req)),
  };
});

vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: async () => ({}),
  updateTenantSettings: async () => ({}),
}));
vi.mock("../api/_lib/docusign-client.js", () => ({
  docusignDecryptCreds: (s) => s,
  docusignIsConfigured: () => true,
  docusignCreateEnvelope: async () => ({ ok: true, status: 201, body: { envelopeId: "ds-env-1" } }),
  docusignFetch: async () => ({ ok: true, body: {} }),
  docusignGetSignedPdf: async () => ({ ok: false }),
}));

// audit/export reads its HMAC key when the module loads.
vi.stubEnv("AUDIT_EXPORT_HMAC_SECRET", "test-only-hmac-key");
afterAll(() => vi.unstubAllEnvs());

const { default: pushSubscribe } = await import("../api/push/subscribe.js");
const { default: pushUnsubscribe } = await import("../api/push/unsubscribe.js");
const { default: accessReview } = await import("../api/admin/access_review.js");
const { default: installVerticalPack } = await import("../api/admin/install_vertical_pack.js");
const { default: deductions } = await import("../api/ap/deductions.js");
const { default: auditExport } = await import("../api/audit/export.js");
const { default: esignEnvelopes } = await import("../api/esign/envelopes.js");
const { default: portalTokens } = await import("../api/portal/tokens.js");
const { default: prospectingCampaigns } = await import("../api/prospecting/campaigns.js");
const { default: prospectingTargets } = await import("../api/prospecting/targets.js");
const { default: rlhfFeedback } = await import("../api/rlhf/feedback.js");
const { default: tallyReconcile } = await import("../api/tally/reconcile.js");
const { default: tallyDriftAddon } = await import("../api/tally/drift_addon.js");

const TENANT = "t-1";
// What resolveContext returns for an approved member.
const signedIn = (id, role = "admin") => ({ user: { id }, tenantId: TENANT, role, anonymous: false });
// What resolveContext returns when ALLOW_ANONYMOUS_TENANT is on (dev only).
const anonymous = () => ({ user: null, tenantId: TENANT, role: "sales_engineer", anonymous: true });

const call = async (handler, { method = "POST", url = "/", body = {}, ctx } = {}) => {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method, url, headers: {}, query: {}, body, _ctx: ctx }, res);
  const isJson = String(res.headers["content-type"] || "").includes("application/json");
  return { status: res.statusCode, body: isJson ? JSON.parse(res.body) : res.body };
};

const table = (name) => H.store[name] || [];

beforeEach(() => {
  H.store = {};
  H.seq = 0;
});

const WEB_SUB = { endpoint: "https://push.example.test/send/abc", p256dh: "p256dh-key", auth: "auth-secret" };

describe("push/subscribe", () => {
  it("lets a signed-in user subscribe and stores their id on the row", async () => {
    const out = await call(pushSubscribe, { body: WEB_SUB, ctx: signedIn("u-1", "viewer") });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, updated: false });
    expect(table("push_subscriptions")).toHaveLength(1);
    expect(table("push_subscriptions")[0]).toMatchObject({
      id: out.body.id, tenant_id: TENANT, user_id: "u-1", endpoint: WEB_SUB.endpoint, is_active: true,
    });
  });

  it("re-subscribing the same endpoint reactivates the caller's own row", async () => {
    const first = await call(pushSubscribe, { body: WEB_SUB, ctx: signedIn("u-1") });
    table("push_subscriptions")[0].is_active = false;
    const again = await call(pushSubscribe, { body: WEB_SUB, ctx: signedIn("u-1") });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, updated: true, id: first.body.id });
    expect(table("push_subscriptions")).toHaveLength(1);
    expect(table("push_subscriptions")[0].is_active).toBe(true);
  });

  it("does not take over another user's row for the same endpoint", async () => {
    H.store.push_subscriptions = [{ id: "sub-u2", tenant_id: TENANT, user_id: "u-2", endpoint: WEB_SUB.endpoint, is_active: false }];
    const out = await call(pushSubscribe, { body: WEB_SUB, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(out.body.updated).toBe(false);
    expect(out.body.id).not.toBe("sub-u2");
    const rows = table("push_subscriptions");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "sub-u2")).toMatchObject({ user_id: "u-2", is_active: false });
    expect(rows.find((r) => r.id === out.body.id)).toMatchObject({ user_id: "u-1", is_active: true });
  });

  it("refuses a context with no user with 401 and writes nothing", async () => {
    const out = await call(pushSubscribe, { body: WEB_SUB, ctx: anonymous() });
    expect(out.status).toBe(401);
    expect(table("push_subscriptions")).toHaveLength(0);
  });

  it("refuses a request with no Authorization header with 401", async () => {
    const out = await call(pushSubscribe, { body: WEB_SUB });
    expect(out.status).toBe(401);
    expect(table("push_subscriptions")).toHaveLength(0);
  });
});

describe("push/unsubscribe", () => {
  const seedTwoUsers = () => {
    H.store.push_subscriptions = [
      { id: "sub-u1", tenant_id: TENANT, user_id: "u-1", endpoint: "https://push.example.test/send/one", is_active: true },
      { id: "sub-u2", tenant_id: TENANT, user_id: "u-2", endpoint: "https://push.example.test/send/two", is_active: true },
    ];
  };
  const active = (id) => table("push_subscriptions").find((r) => r.id === id).is_active;

  it("lets the owner deactivate their subscription by endpoint", async () => {
    seedTwoUsers();
    const out = await call(pushUnsubscribe, { body: { endpoint: "https://push.example.test/send/one" }, ctx: signedIn("u-1", "viewer") });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(active("sub-u1")).toBe(false);
    expect(active("sub-u2")).toBe(true);
  });

  it("lets the owner deactivate their subscription by id", async () => {
    seedTwoUsers();
    const out = await call(pushUnsubscribe, { body: { id: "sub-u1" }, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(active("sub-u1")).toBe(false);
  });

  it("does not let another user deactivate the owner's subscription", async () => {
    seedTwoUsers();
    const out = await call(pushUnsubscribe, { body: { id: "sub-u1" }, ctx: signedIn("u-2") });
    expect(out.status).toBe(200);
    expect(active("sub-u1")).toBe(true);
    expect(active("sub-u2")).toBe(true);
  });

  it("refuses a context with no user with 401 and changes nothing", async () => {
    seedTwoUsers();
    const out = await call(pushUnsubscribe, { body: { id: "sub-u1" }, ctx: anonymous() });
    expect(out.status).toBe(401);
    expect(active("sub-u1")).toBe(true);
  });

  it("refuses a request with no Authorization header with 401", async () => {
    seedTwoUsers();
    const out = await call(pushUnsubscribe, { body: { id: "sub-u1" } });
    expect(out.status).toBe(401);
    expect(active("sub-u1")).toBe(true);
  });
});

describe("handlers that stamp the actor on the row they write", () => {
  it("admin/access_review: reviewed_by is the admin who signed", async () => {
    H.store.tenant_members = [{ tenant_id: TENANT, user_id: "u-1", role: "admin", status: "approved" }];
    const out = await call(accessReview, { body: { acknowledgement_text: "Reviewed all roles." }, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("access_reviews")).toHaveLength(1);
    expect(table("access_reviews")[0]).toMatchObject({ tenant_id: TENANT, reviewed_by: "u-1" });
  });

  it("admin/install_vertical_pack: installed_by is the installing admin", async () => {
    const out = await call(installVerticalPack, { body: { vertical_id: "fasteners" }, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(out.body.already_installed).toBe(false);
    expect(table("vertical_pack_installs")).toHaveLength(1);
    expect(table("vertical_pack_installs")[0]).toMatchObject({ tenant_id: TENANT, vertical_id: "fasteners", installed_by: "u-1" });
  });

  it("ap/deductions: resolved_by is the approver who closed the deduction", async () => {
    H.store.deduction_queue = [{ id: "ded-1", tenant_id: TENANT, status: "open", resolved_by: null }];
    const out = await call(deductions, { method: "PATCH", body: { id: "ded-1", status: "recovered" }, ctx: signedIn("u-1", "finance") });
    expect(out.status).toBe(200);
    expect(table("deduction_queue")[0]).toMatchObject({ status: "recovered", resolved_by: "u-1" });
    expect(table("deduction_queue")[0].resolved_at).toBeTruthy();
  });

  it("audit/export: exported_by is the exporting admin, in the run log and the signed meta", async () => {
    H.store.audit_events = [{ id: "ev-1", tenant_id: TENANT, ts: "2026-10-01T00:00:00.000Z", action: "quote_sent" }];
    const out = await call(auditExport, { method: "GET", url: "/api/audit/export?from=2026-01-01T00:00:00.000Z", ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("audit_export_runs")).toHaveLength(1);
    expect(table("audit_export_runs")[0]).toMatchObject({ tenant_id: TENANT, exported_by: "u-1", rows_exported: 1 });
    const lines = String(out.body).trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]).meta.exported_by).toBe("u-1");
  });

  it("esign/envelopes: created_by is the approver who sent the envelope", async () => {
    const body = { order_id: "o-1", signers: [{ name: "Signer", email: "signer@example.test" }], pdf_base64: "JVBERi0xLjQK" };
    const out = await call(esignEnvelopes, { url: "/api/esign/envelopes", body, ctx: signedIn("u-1", "sales_manager") });
    expect(out.status).toBe(200);
    expect(table("esignature_envelopes")).toHaveLength(1);
    expect(table("esignature_envelopes")[0]).toMatchObject({ tenant_id: TENANT, status: "sent", created_by: "u-1" });
  });

  it("portal/tokens: created_by is the approver who minted the token", async () => {
    const out = await call(portalTokens, { url: "/api/portal/tokens", body: { customer_id: "c-1" }, ctx: signedIn("u-1", "sales_manager") });
    expect(out.status).toBe(200);
    expect(table("portal_tokens")).toHaveLength(1);
    expect(table("portal_tokens")[0]).toMatchObject({ tenant_id: TENANT, customer_id: "c-1", created_by: "u-1" });
  });

  it("prospecting/campaigns: created_by is the admin who created the campaign", async () => {
    const body = { name: "Q4 outreach", template_subject: "Hello", template_body: "Body" };
    const out = await call(prospectingCampaigns, { body, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("prospecting_campaigns")).toHaveLength(1);
    expect(table("prospecting_campaigns")[0]).toMatchObject({ tenant_id: TENANT, created_by: "u-1" });
  });

  it("prospecting/targets: approved_by is the admin who approved the target", async () => {
    H.store.prospecting_targets = [{ id: "pt-1", tenant_id: TENANT, status: "pending", approved_by: null }];
    const out = await call(prospectingTargets, { method: "PATCH", body: { id: "pt-1", action: "approve" }, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("prospecting_targets")[0]).toMatchObject({ status: "approved", approved_by: "u-1" });
  });

  it("rlhf/feedback: user_id is the user who rated the output", async () => {
    const body = { surface: "agent", rating: 1, prompt: "p", output: "o" };
    const out = await call(rlhfFeedback, { body, ctx: signedIn("u-1", "viewer") });
    expect(out.status).toBe(200);
    expect(table("rlhf_feedback")).toHaveLength(1);
    expect(table("rlhf_feedback")[0]).toMatchObject({ tenant_id: TENANT, user_id: "u-1", rating: 1 });
  });
});

describe("tally reconciliation records who ran it", () => {
  it("tally/reconcile mark: the reconciliation run carries the approver", async () => {
    H.store.orders = [{ id: "o-1", tenant_id: TENANT, status: "EXPORTED_TO_TALLY" }];
    const out = await call(tallyReconcile, { body: { mode: "mark", orderId: "o-1", status: "reconciled" }, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("orders")[0].status).toBe("RECONCILED");
    expect(table("tally_reconciliation_runs")).toHaveLength(1);
    expect(table("tally_reconciliation_runs")[0]).toMatchObject({ tenant_id: TENANT, scope_value: "o-1", triggered_by: "u-1" });
  });

  it("tally/reconcile drift_check: the reconciliation run carries the operator", async () => {
    H.store.tenant_settings = [{ tenant_id: TENANT, tally_drift_addon_enabled: true }];
    const out = await call(tallyReconcile, { body: { mode: "drift_check" }, ctx: signedIn("u-1", "sales_engineer") });
    expect(out.status).toBe(200);
    expect(table("tally_reconciliation_runs")).toHaveLength(1);
    expect(table("tally_reconciliation_runs")[0]).toMatchObject({ tenant_id: TENANT, triggered_by: "u-1" });
  });

  it("tally/reconcile PATCH: resolved_by is the approver who resolved the finding", async () => {
    H.store.tally_reconciliation_findings = [{ id: "f-1", tenant_id: TENANT, finding_kind: "total_mismatch", resolved_at: null }];
    const out = await call(tallyReconcile, { method: "PATCH", url: "/api/tally/reconcile?finding_id=f-1", ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("tally_reconciliation_findings")[0]).toMatchObject({ resolved_by: "u-1" });
  });

  it("tally/drift_addon first enable: the initial scan run carries the admin", async () => {
    H.store.tenant_settings = [{ tenant_id: TENANT, tally_drift_addon_enabled: false }];
    const out = await call(tallyDriftAddon, { body: { plan: "trial" }, ctx: signedIn("u-1") });
    expect(out.status).toBe(200);
    expect(table("tally_reconciliation_runs")).toHaveLength(1);
    expect(table("tally_reconciliation_runs")[0]).toMatchObject({ tenant_id: TENANT, trigger: "workspace", triggered_by: "u-1" });
  });
});
