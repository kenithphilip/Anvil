// /api/plm/sync
//   GET                 list sync state for every PLM system
//   POST {system_id}    trigger an immediate sync (cron-equivalent)
//
// Phase 5.5. The cron path (/api/cron/tick) calls this with no body
// to sync every system; an admin click hits POST with a system_id
// to force a manual refresh.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { plmDecryptCreds, plmFetchBoms, plmFetchChanges, plmIsConfigured } from "../_lib/plm-client.js";

const isCronAuthed = (req) => {
  const got = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const want = process.env.CRON_SECRET || "";
  return want && got && got === want;
};

const syncOne = async (svc, system) => {
  const decrypted = plmDecryptCreds(system);
  if (!plmIsConfigured(decrypted)) {
    return { system_id: system.id, skipped: "not_configured" };
  }

  // Mark running.
  for (const entity of ["boms", "changes"]) {
    await svc.from("plm_sync_state").upsert({
      tenant_id: system.tenant_id,
      system_id: system.id,
      entity,
      status: "running",
    }, { onConflict: "tenant_id,system_id,entity" });
  }

  const result = { system_id: system.id, system: system.system, boms: 0, changes: 0, error: null };

  try {
    // BOMs.
    const lastBom = (await svc.from("plm_sync_state")
      .select("last_modified_high_water")
      .eq("system_id", system.id).eq("entity", "boms").maybeSingle()).data;
    const boms = await plmFetchBoms(decrypted, { since: lastBom?.last_modified_high_water || null });
    if (boms.length) {
      const rows = boms.map((b) => ({
        tenant_id: system.tenant_id,
        source_system: system.system,
        ...b,
      }));
      const { error } = await svc.from("plm_boms")
        .upsert(rows, { onConflict: "tenant_id,source_system,external_id" });
      if (error) throw new Error("BOM upsert: " + error.message);
      result.boms = boms.length;
    }
    await svc.from("plm_sync_state").upsert({
      tenant_id: system.tenant_id,
      system_id: system.id,
      entity: "boms",
      last_sync_at: new Date().toISOString(),
      last_modified_high_water: new Date().toISOString(),
      rows_pulled: boms.length,
      rows_updated: boms.length,
      status: "idle",
      last_error: null,
    }, { onConflict: "tenant_id,system_id,entity" });

    // Changes.
    const lastChg = (await svc.from("plm_sync_state")
      .select("last_modified_high_water")
      .eq("system_id", system.id).eq("entity", "changes").maybeSingle()).data;
    const changes = await plmFetchChanges(decrypted, { since: lastChg?.last_modified_high_water || null });
    if (changes.length) {
      const rows = changes.map((c) => ({
        tenant_id: system.tenant_id,
        source_system: system.system,
        ...c,
      }));
      const { error } = await svc.from("plm_changes")
        .upsert(rows, { onConflict: "tenant_id,source_system,external_id" });
      if (error) throw new Error("Change upsert: " + error.message);
      result.changes = changes.length;
    }
    await svc.from("plm_sync_state").upsert({
      tenant_id: system.tenant_id,
      system_id: system.id,
      entity: "changes",
      last_sync_at: new Date().toISOString(),
      last_modified_high_water: new Date().toISOString(),
      rows_pulled: changes.length,
      rows_updated: changes.length,
      status: "idle",
      last_error: null,
    }, { onConflict: "tenant_id,system_id,entity" });
  } catch (err) {
    result.error = err.message;
    // Mark error on whichever entity was running last; safest to
    // mark both.
    for (const entity of ["boms", "changes"]) {
      await svc.from("plm_sync_state").upsert({
        tenant_id: system.tenant_id,
        system_id: system.id,
        entity,
        status: "error",
        last_error: err.message,
      }, { onConflict: "tenant_id,system_id,entity" });
    }
  }
  return result;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const svc = serviceClient();

    // Cron-mode entry: bearer-secret header, sync every active system.
    if (req.method === "POST" && isCronAuthed(req)) {
      const { data: systems } = await svc.from("plm_systems").select("*").eq("active", true);
      const results = [];
      for (const s of systems || []) {
        results.push(await syncOne(svc, s));
      }
      return json(res, 200, { ok: true, count: results.length, results });
    }

    const ctx = await resolveContext(req);

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data: systems } = await svc.from("plm_systems")
        .select("*")
        .eq("tenant_id", ctx.tenantId);
      const { data: states } = await svc.from("plm_sync_state")
        .select("*")
        .eq("tenant_id", ctx.tenantId);
      return json(res, 200, { systems: systems || [], sync_state: states || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body?.system_id) return json(res, 400, { error: { message: "system_id required" } });
      const { data: system } = await svc.from("plm_systems")
        .select("*")
        .eq("id", body.system_id)
        .eq("tenant_id", ctx.tenantId)
        .maybeSingle();
      if (!system) return json(res, 404, { error: { message: "system not found" } });
      const result = await syncOne(svc, system);
      await recordAudit(ctx, {
        action: "plm_sync_manual",
        objectType: "plm_system",
        objectId: system.id,
        after: result,
      });
      return json(res, 200, result);
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
