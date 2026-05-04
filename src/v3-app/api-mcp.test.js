// Unit tests for the MCP wire-protocol helpers.

import { describe, it, expect } from "vitest";
import { mcpHashToken, mcpNewToken, mcpHandle } from "../api/_lib/mcp.js";
import { erpChatScopes } from "../api/_lib/erp-chat-tools.js";

const fakeToken = {
  id: "tok-1",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  scopes: ["read.orders", "read.invoices", "read.customers", "read.inventory", "read.pipeline", "read.misc"],
};

const fakeReq = { headers: {} };

const fakeSvc = () => {
  // Stub Supabase: every call returns no rows but doesn't error so
  // mcpHandle's tools/call path completes without exploding. We also
  // capture writes for assertions.
  const writes = [];
  const make = () => ({
    select: () => make(),
    insert: (row) => { writes.push({ kind: "insert", row }); return make(); },
    update: (row) => { writes.push({ kind: "update", row }); return make(); },
    delete: () => make(),
    eq: () => make(),
    in: () => make(),
    or: () => make(),
    not: () => make(),
    ilike: () => make(),
    gte: () => make(),
    lte: () => make(),
    order: () => make(),
    limit: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
  });
  return { from: (_t) => make(), _writes: writes };
};

describe("MCP / token helpers", () => {
  it("mcpNewToken yields a base64url string of meaningful length", () => {
    const t = mcpNewToken();
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(40);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("mcpHashToken is deterministic + 64 hex chars", () => {
    const a = mcpHashToken("hello");
    const b = mcpHashToken("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(mcpHashToken("hello")).not.toBe(mcpHashToken("world"));
  });
});

describe("MCP / handler dispatch", () => {
  it("initialize returns protocol version + serverInfo", async () => {
    const r = await mcpHandle({
      svc: fakeSvc(), req: fakeReq, token: fakeToken,
      message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(r.jsonrpc).toBe("2.0");
    expect(r.result.protocolVersion).toBeTruthy();
    expect(r.result.serverInfo.name).toBe("anvil-mcp");
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it("tools/list filters by token scope set", async () => {
    const restricted = { ...fakeToken, scopes: ["read.orders"] };
    const r = await mcpHandle({
      svc: fakeSvc(), req: fakeReq, token: restricted,
      message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    const names = r.result.tools.map((t) => t.name);
    expect(names).toContain("search_orders");
    expect(names).not.toContain("search_invoices");
    expect(names).not.toContain("search_customers");
  });

  it("tools/list returns all tools when token has every scope", async () => {
    const r = await mcpHandle({
      svc: fakeSvc(), req: fakeReq, token: fakeToken,
      message: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });
    const names = r.result.tools.map((t) => t.name);
    expect(names).toContain("search_orders");
    expect(names).toContain("search_invoices");
    expect(names).toContain("get_quote_status");
    expect(names).toContain("summarize_open_pipeline");
  });

  it("tools/call denies a tool whose scope isn't in the token", async () => {
    const restricted = { ...fakeToken, scopes: ["read.orders"] };
    const r = await mcpHandle({
      svc: fakeSvc(), req: fakeReq, token: restricted,
      message: { jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "search_invoices", arguments: {} } },
    });
    expect(r.error).toBeTruthy();
    expect(r.error.code).toBe(-32004);
    expect(r.error.message).toMatch(/scope not allowed/);
  });

  it("ping returns an empty result", async () => {
    const r = await mcpHandle({
      svc: fakeSvc(), req: fakeReq, token: fakeToken,
      message: { jsonrpc: "2.0", id: 5, method: "ping" },
    });
    expect(r.result).toEqual({});
  });

  it("unknown method returns -32601", async () => {
    const r = await mcpHandle({
      svc: fakeSvc(), req: fakeReq, token: fakeToken,
      message: { jsonrpc: "2.0", id: 6, method: "weird/thing" },
    });
    expect(r.error.code).toBe(-32601);
  });

  it("erpChatScopes enumerates the live scope set", () => {
    const all = erpChatScopes();
    expect(all).toContain("read.orders");
    expect(all).toContain("read.invoices");
    expect(all).toContain("read.customers");
    expect(all).toContain("read.inventory");
    expect(all).toContain("read.pipeline");
  });
});
