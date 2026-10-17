// GET  /api/admin/secrets_reencrypt  -> dry run: counts the tenant's stored
//                                       credentials still in the v1 format
// POST /api/admin/secrets_reencrypt  -> rewrites them in the v2 format
//
// Admin-only, scoped to the caller's tenant. Idempotent: run it again and
// it rewrites nothing (totals.v1 is 0). The report holds counts and column
// names only, never a credential. See _lib/secrets.js for the formats and
// _lib/secrets-reencrypt.js for the columns covered.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { reencryptTenantSecrets } from "../_lib/secrets-reencrypt.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    if (!isSecretsConfigured()) {
      return json(res, 400, { error: { code: "ANVIL_SECRETS_KEY_MISSING", message: "ANVIL_SECRETS_KEY is not configured; stored credentials cannot be read." } });
    }
    const apply = req.method === "POST";
    const report = await reencryptTenantSecrets(serviceClient(), ctx.tenantId, { apply });
    if (apply) {
      const t = report.totals;
      await recordAudit(ctx, {
        action: "secrets_reencrypted",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: `rewritten=${t.rewritten} v1=${t.v1} unreadable=${t.unreadable} conflicts=${t.conflicts} errors=${t.errors}`,
      });
    }
    return json(res, 200, report);
  } catch (err) {
    return sendError(res, err);
  }
}
