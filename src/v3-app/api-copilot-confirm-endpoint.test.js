// Integration test for the copilot safe-action loop (PR2):
//   1. a write tool (create_lead) PROPOSES - no side effect, just a
//      proposal + confirm_token.
//   2. /api/copilot/confirm executes it once (lead created, proposal
//      consumed); a replay is rejected; another user's confirm is rejected.
//   3. MCP default-deny: a token without the write scope cannot call the
//      write tool.
//
// dispatchErpChatTool and the confirm handler both call serviceClient(),
// which we mock to return svc objects over one shared in-memory store.

import { describe, it, expect, vi, beforeEach } from "vitest";

const T1 = "tenant-1";
const U1 = "user-1";
const U2 = "user-2";

let tables;
let ctxState; // { tenantId, user }

const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select";
    let patch = null;
    let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      gt: (c, v) => { rows = rows.filter((r) => r[c] != null && String(r[c]) > String(v)); return b; },
      order: () => b,
      limit: () => b,
      single: () => { single = true; return b; },
      maybeSingle: () => { single = true; return b; },
      insert: (row) => { mode = "insert"; patch = row; return b; },
      update: (p) => { mode = "update"; patch = p; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const terminal = () => {
      if (mode === "insert") {
        const arr = (Array.isArray(patch) ? patch : [patch]).map((r) => ({ id: r.id || (table + "-" + (ds.length + 1)), ...r }));
        ds.push(...arr);
        return { data: single ? arr[0] : arr, error: null };
      }
      if (mode === "update") {
        for (const r of rows) Object.assign(r, patch);
        return { data: single ? rows[0] || null : rows, error: null };
      }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {},
  handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ctxState,
  requirePermission: () => {},
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));

import { dispatchErpChatTool } from "../api/_lib/erp-chat-tools.js";
import confirmHandler from "../api/copilot/confirm.js";

const confirm = async (token, ctx) => {
  ctxState = ctx;
  const req = { method: "POST", query: {}, _body: { confirm_token: token } };
  const res = { setHeader() {}, _status: 0, _json: null };
  await confirmHandler(req, res);
  return res;
};

beforeEach(() => { tables = {}; ctxState = { tenantId: T1, user: { id: U1 } }; });

describe("copilot safe actions - create_lead", () => {
  it("propose creates a proposal with ZERO side effect", async () => {
    const out = await dispatchErpChatTool(T1, "create_lead", { company_name: "Acme Corp" }, { userId: U1 });
    expect(out.proposed).toBe(true);
    expect(out.confirm_token).toBeTruthy();
    expect(tables.action_proposals).toHaveLength(1);
    expect(tables.leads).toBeUndefined(); // nothing created yet
  });

  it("confirm executes once; replay is rejected; lead created exactly once", async () => {
    const out = await dispatchErpChatTool(T1, "create_lead", { company_name: "Acme Corp", contact_email: "a@b.com" }, { userId: U1 });
    const token = out.confirm_token;

    const r1 = await confirm(token, { tenantId: T1, user: { id: U1 } });
    expect(r1._status).toBe(200);
    expect(r1._json.ok).toBe(true);
    expect(r1._json.result.lead.company_name).toBe("Acme Corp");
    expect(tables.leads).toHaveLength(1);
    expect(tables.action_proposals[0].status).toBe("consumed");

    const r2 = await confirm(token, { tenantId: T1, user: { id: U1 } });
    expect(r2._status).toBe(409);
    expect(r2._json.error.code).toBe("ALREADY_CONSUMED");
    expect(tables.leads).toHaveLength(1); // still one
  });

  it("another user cannot confirm a proposal they did not create", async () => {
    const out = await dispatchErpChatTool(T1, "create_lead", { company_name: "Acme" }, { userId: U1 });
    const r = await confirm(out.confirm_token, { tenantId: T1, user: { id: U2 } });
    expect(r._status).toBe(403);
    expect(r._json.error.code).toBe("WRONG_USER");
    expect(tables.leads).toBeUndefined();
  });

  it("cancel discards a proposal so confirm then fails", async () => {
    const out = await dispatchErpChatTool(T1, "create_lead", { company_name: "Acme" }, { userId: U1 });
    ctxState = { tenantId: T1, user: { id: U1 } };
    const cancelRes = { setHeader() {}, _status: 0, _json: null };
    await confirmHandler({ method: "POST", query: {}, _body: { confirm_token: out.confirm_token, cancel: true } }, cancelRes);
    expect(cancelRes._json.cancelled).toBe(true);
    const r = await confirm(out.confirm_token, { tenantId: T1, user: { id: U1 } });
    expect(r._status).toBe(409);
    expect(r._json.error.code).toBe("CANCELLED");
  });
});

describe("MCP default-deny for write tools", () => {
  it("a token without the write scope cannot call create_lead", async () => {
    const out = await dispatchErpChatTool(T1, "create_lead", { company_name: "Acme" }, { scopes: ["read.orders"], userId: U1 });
    expect(out.error).toMatch(/scope not allowed/);
    expect(tables.action_proposals).toBeUndefined();
  });
  it("a token WITH write.leads can propose", async () => {
    const out = await dispatchErpChatTool(T1, "create_lead", { company_name: "Acme" }, { scopes: ["write.leads"], userId: U1 });
    expect(out.proposed).toBe(true);
    expect(tables.action_proposals).toHaveLength(1);
  });
});
