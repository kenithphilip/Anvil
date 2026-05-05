// /api/oracle_ebs/health — Phase 5.4b cluster C.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { oracleEbsDecryptCreds, oracleEbsIsConfigured, oracleEbsProbe } from "../_lib/oracle-ebs-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!sRow.data) return json(res, 200, { configured: false });
    const settings = oracleEbsDecryptCreds({ ...sRow.data, tenant_id: ctx.tenantId });
    const configured = oracleEbsIsConfigured(settings);
    let probeOk = null;
    let probeError = null;
    if (configured) {
      try {
        const r = await oracleEbsProbe(settings);
        probeOk = r.ok;
        if (!r.ok) probeError = JSON.stringify(r.body).slice(0, 400);
      } catch (err) {
        probeOk = false;
        probeError = err.message;
      }
    }
    const { data: state } = await svc.from("oracle_ebs_sync_state")
      .select("*").eq("tenant_id", ctx.tenantId);
    const { data: retryDue } = await svc.from("oracle_ebs_retry_queue")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).eq("status", "pending");
    return json(res, 200, {
      configured,
      probe_ok: probeOk,
      probe_error: probeError,
      base_url: settings.oracle_ebs_base_url || null,
      responsibility: settings.oracle_ebs_responsibility || null,
      org_id: settings.oracle_ebs_org_id || null,
      connected_at: settings.oracle_ebs_connected_at || null,
      sync_state: state || [],
      retry_pending: retryDue?.length || 0,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
