// POST /api/mcp/server
//
// Anvil's Model Context Protocol endpoint. Speaks JSON-RPC 2.0 over
// HTTP. Auth via `Authorization: Bearer <token>` (token issued by
// /api/mcp/tokens). Each request is a single JSON-RPC envelope; we
// answer synchronously. (Streaming via SSE is a follow-up; the
// current MCP HTTP transport spec accepts request-response.)
//
// Wire example (a Claude desktop client config would use this):
//
//   POST /api/mcp/server
//   Authorization: Bearer <token>
//   Content-Type: application/json
//
//   { "jsonrpc": "2.0", "id": 1, "method": "initialize",
//     "params": { "protocolVersion": "2024-11-05", "capabilities": {} } }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { mcpLookupToken, mcpTouchToken, mcpHandle } from "../_lib/mcp.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const svc = serviceClient();
    const lookup = await mcpLookupToken(svc, auth);
    if (lookup.error) {
      return json(res, 401, {
        jsonrpc: "2.0", id: null,
        error: lookup.error,
      });
    }
    const message = await readBody(req);
    if (!message || message.jsonrpc !== "2.0") {
      return json(res, 400, {
        jsonrpc: "2.0", id: null,
        error: { code: -32600, message: "invalid jsonrpc envelope" },
      });
    }
    const response = await mcpHandle({
      svc, req, token: lookup.token, message,
    });
    // Touch token after the response is built; don't block.
    mcpTouchToken(svc, lookup.token.id).catch(() => {});
    return json(res, 200, response);
  } catch (err) { sendError(res, err); }
}
