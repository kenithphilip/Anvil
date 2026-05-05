// /api/plm/connect
//   POST { system, base_url, username?, password?, api_key?, display_name? }
//
// Stores PLM credentials (encrypted when secrets are configured)
// and runs a probe call to validate them. Phase 5.5.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { plmEncryptCreds, plmDecryptCreds, plmIsConfigured, plmProbe } from "../_lib/plm-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    const system = body?.system;
    const base_url = body?.base_url;
    if (!system || !base_url || !["windchill", "arena"].includes(system)) {
      return json(res, 400, { error: { message: "system in (windchill, arena) and base_url required" } });
    }
    const enc = plmEncryptCreds({ username: body.username, password: body.password, apiKey: body.api_key });
    const row = {
      tenant_id: ctx.tenantId,
      system,
      base_url,
      display_name: body.display_name || null,
      ...enc,
      active: true,
    };
    const svc = serviceClient();
    const { data, error } = await svc.from("plm_systems")
      .upsert(row, { onConflict: "tenant_id,system,base_url" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    // Probe to validate creds. We don't fail the upsert on probe
    // error; we record the error so the operator can fix and retry.
    const decrypted = plmDecryptCreds(data);
    let probed = false;
    let probeErr = null;
    if (plmIsConfigured(decrypted)) {
      try {
        await plmProbe(decrypted);
        probed = true;
        await svc.from("plm_systems")
          .update({ connected_at: new Date().toISOString(), last_error: null })
          .eq("id", data.id);
      } catch (err) {
        probeErr = err.message;
        await svc.from("plm_systems")
          .update({ last_error: err.message })
          .eq("id", data.id);
      }
    }

    await recordAudit(ctx, {
      action: "plm_connect",
      objectType: "plm_system",
      objectId: data.id,
      after: { system, base_url, probed, probeErr },
    });

    return json(res, 200, {
      system_id: data.id,
      probed,
      probe_error: probeErr,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
