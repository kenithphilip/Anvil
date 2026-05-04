// MCP (Model Context Protocol) helpers.
//
// MCP is the Anthropic-defined protocol for exposing tools and
// resources to LLM clients (Claude desktop, ChatGPT, Copilot
// Workspace). The wire format is JSON-RPC 2.0 over either stdio
// (local servers) or HTTP/SSE (remote servers). Anvil exposes a
// remote HTTP server so any external AI assistant with a token
// can query data.
//
// We support:
//   - initialize           handshake, returns protocolVersion + capabilities
//   - tools/list           returns all tools the token's scopes allow
//   - tools/call           dispatches to erp-chat-tools.js
//   - resources/list       (no resources exposed in v1; tools are the surface)
//   - resources/read       (no-op in v1)
//   - ping                 keepalive
//
// Auth: Bearer <plaintext token>. We look up by sha256 hash. A
// revoked token short-circuits with -32001. Scopes are checked at
// tool dispatch time.

import crypto from "node:crypto";
import { erpChatTools, dispatchErpChatTool, erpChatToolScope } from "./erp-chat-tools.js";

const PROTOCOL_VERSION = "2024-11-05";

export const mcpHashToken = (plaintext) =>
  crypto.createHash("sha256").update(String(plaintext || "")).digest("hex");

export const mcpNewToken = () => {
  const buf = crypto.randomBytes(32);
  return buf.toString("base64url");
};

const jsonrpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const jsonrpcError = (id, code, message, data) => ({
  jsonrpc: "2.0", id,
  error: { code, message, ...(data ? { data } : {}) },
});

// Resolve a token to a row. Returns { token } on success, or
// { error } shaped for jsonrpcError.
export const mcpLookupToken = async (svc, plaintext) => {
  if (!plaintext) return { error: { code: -32001, message: "missing token" } };
  const hash = mcpHashToken(plaintext);
  const r = await svc.from("mcp_tokens").select("*").eq("token_hash", hash).maybeSingle();
  if (r.error) return { error: { code: -32603, message: r.error.message } };
  if (!r.data) return { error: { code: -32001, message: "invalid token" } };
  if (r.data.revoked_at) return { error: { code: -32001, message: "token revoked" } };
  if (r.data.expires_at && new Date(r.data.expires_at) < new Date()) {
    return { error: { code: -32001, message: "token expired" } };
  }
  return { token: r.data };
};

// Bump use_count + last_used_at without blocking the response.
export const mcpTouchToken = async (svc, tokenId) => {
  await svc.from("mcp_tokens").update({
    last_used_at: new Date().toISOString(),
    use_count: undefined,
  }).eq("id", tokenId);
  // Increment use_count via RPC if available; fall back to a select+update.
  try {
    const cur = await svc.from("mcp_tokens").select("use_count").eq("id", tokenId).maybeSingle();
    await svc.from("mcp_tokens").update({
      use_count: (cur.data?.use_count || 0) + 1,
    }).eq("id", tokenId);
  } catch (_e) { /* swallow */ }
};

// Per-call audit row.
export const mcpAudit = async (svc, { tenantId, tokenId, tool, scope, args, status, error, latencyMs, rowsReturned, ip, userAgent }) => {
  await svc.from("mcp_call_log").insert({
    tenant_id: tenantId,
    token_id: tokenId,
    tool, scope, args: args || null,
    status, error: error || null,
    latency_ms: latencyMs || 0,
    rows_returned: rowsReturned || 0,
    ip: ip || null,
    user_agent: userAgent || null,
  });
};

// Handle a single JSON-RPC request. Token + scope checks already
// done by the caller; we just dispatch on `method`.
export const mcpHandle = async ({ svc, req, token, message }) => {
  const { id, method, params } = message || {};
  if (method === "initialize") {
    return jsonrpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        logging: {},
      },
      serverInfo: {
        name: "anvil-mcp",
        version: "1.0.0",
      },
    });
  }
  if (method === "ping") {
    return jsonrpcResult(id, {});
  }
  if (method === "tools/list") {
    const tools = erpChatTools({ scopes: token.scopes });
    return jsonrpcResult(id, { tools });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!name) return jsonrpcError(id, -32602, "missing tool name");
    const scope = erpChatToolScope(name);
    const t0 = Date.now();
    const result = await dispatchErpChatTool(token.tenant_id, name, args, { scopes: token.scopes });
    const latencyMs = Date.now() - t0;
    const rows = Array.isArray(result?.rows) ? result.rows.length
      : (result?.rows ? 1 : 0);
    if (result?.error) {
      await mcpAudit(svc, {
        tenantId: token.tenant_id, tokenId: token.id,
        tool: name, scope, args,
        status: result.error.includes("scope not allowed") ? "denied" : "error",
        error: result.error, latencyMs, rowsReturned: 0,
        ip: req.headers["x-forwarded-for"]?.split(",")[0],
        userAgent: req.headers["user-agent"],
      });
      const code = result.error.includes("scope not allowed") ? -32004 : -32603;
      return jsonrpcError(id, code, result.error);
    }
    await mcpAudit(svc, {
      tenantId: token.tenant_id, tokenId: token.id,
      tool: name, scope, args,
      status: "ok", latencyMs, rowsReturned: rows,
      ip: req.headers["x-forwarded-for"]?.split(",")[0],
      userAgent: req.headers["user-agent"],
    });
    return jsonrpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: false,
    });
  }
  if (method === "resources/list") {
    return jsonrpcResult(id, { resources: [] });
  }
  if (method === "resources/read") {
    return jsonrpcError(id, -32601, "no resources exposed");
  }
  return jsonrpcError(id, -32601, "method not found: " + method);
};
