// GET /api/agent/personas
//
// Which Ask Anvil module personas this tenant has switched on. The browser
// renders the floating button only for a persona that comes back here, so a
// tenant without the flag never sees the surface at all.
//
// This is the SAME gate /api/erp_chat/send enforces, deliberately duplicated
// rather than shared as trust: the client asks what is enabled, but the send
// endpoint re-checks it, so a forged persona in a request body is rejected
// regardless of what this endpoint said. Neither half trusts the other.
//
// The system prompt is NOT returned — see agent-personas.js.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { enabledPersonas, publicPersona } from "../_lib/agent-personas.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    // `read` only: seeing that an assistant exists is not a privileged act, and
    // every tool it can reach is itself read-scoped. Anything that mutates
    // still goes through /api/copilot/confirm behind `approve`.
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    return json(res, 200, { personas: enabledPersonas(settings).map(publicPersona) });
  } catch (err) { sendError(res, err); }
}
