// POST /api/p21/connect

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { p21EncryptCreds, p21DecryptCreds, p21Fetch } from "../_lib/p21-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";
import { safeProbeError } from "../_lib/sanitize.js";

const REQUIRED = ["base_url", "username", "password"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    for (const k of REQUIRED) if (!body?.[k]) return json(res, 400, { error: { message: k + " required" } });
    const svc = serviceClient();
    await tenantSettings(svc, ctx.tenantId);
    const enc = p21EncryptCreds({ username: body.username, password: body.password });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      p21_base_url: String(body.base_url).replace(/\/+$/, ""),
      p21_company_id: body.company_id || null,
      p21_default_branch: body.default_branch || null,
      p21_default_warehouse: body.default_warehouse || null,
      p21_default_salesrep: body.default_salesrep || null,
      ...enc,
    });
    const decrypted = p21DecryptCreds({ ...updated, tenant_id: ctx.tenantId });
    let probe = null;
    try {
      probe = await p21Fetch(decrypted, { method: "GET", path: "/api/v2/odata/data/Customers", query: { $top: "1" } });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { p21_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "p21_connect", objectType: "tenant_settings", objectId: ctx.tenantId,
      detail: probe.ok ? "probe_ok" : ("probe_failed::" + probe.status),
    });
    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: safeProbeError(probe, "connection_failed"),
      storage_mode: isSecretsConfigured() ? "encrypted" : "plaintext",
    });
  } catch (err) { sendError(res, err); }
}
