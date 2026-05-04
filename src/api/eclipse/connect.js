// POST /api/eclipse/connect

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings, updateTenantSettings } from "../_lib/stripe-client.js";
import { eclipseEncryptCreds, eclipseDecryptCreds, eclipseFetch } from "../_lib/eclipse-client.js";
import { isSecretsConfigured } from "../_lib/secrets.js";

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
    const enc = eclipseEncryptCreds({ username: body.username, password: body.password });
    const updated = await updateTenantSettings(svc, ctx.tenantId, {
      eclipse_base_url: String(body.base_url).replace(/\/+$/, ""),
      eclipse_default_branch: body.default_branch || null,
      eclipse_default_warehouse: body.default_warehouse || null,
      ...enc,
    });
    const decrypted = eclipseDecryptCreds({ ...updated, tenant_id: ctx.tenantId });
    let probe = null;
    try {
      probe = await eclipseFetch(decrypted, { method: "GET", path: "/eterm/customers", query: { $top: "1" } });
    } catch (err) { probe = { ok: false, status: 0, body: { error: err.message } }; }
    if (probe.ok) {
      await updateTenantSettings(svc, ctx.tenantId, { eclipse_connected_at: new Date().toISOString() });
    }
    await recordAudit(ctx, {
      action: "eclipse_connect", objectType: "tenant_settings", objectId: ctx.tenantId,
      detail: probe.ok ? "probe_ok" : ("probe_failed::" + probe.status),
    });
    return json(res, 200, {
      ok: probe.ok,
      probe_status: probe.status,
      probe_error: probe.ok ? null : (probe.body?.error || probe.body?.raw),
      transport: probe.transport || "json",
      storage_mode: isSecretsConfigured() ? "encrypted" : "plaintext",
    });
  } catch (err) { sendError(res, err); }
}
