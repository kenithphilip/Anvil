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
import { notifyAdmins } from "../_lib/notifications.js";
import { affectedPartKeys, matchChangesToParts, describeImpact } from "../_lib/plm-impact.js";

const isCronAuthed = (req) => {
  const got = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const want = process.env.CRON_SECRET || "";
  return want && got && got === want;
};

// TELL SOMEBODY AN ECO LANDED ON A PART WE HOLD.
//
// plm_changes had exactly one reference in the codebase — the upsert above —
// so every engineering change this sync has ever pulled went into a table
// nothing reads. The cron ran, the API call was spent, the row was written,
// and a supplier revising a part we buy produced no consequence at all.
//
// Alerts only on changes NEW to us, and only where the ECO names a part in
// item_master. Both halves matter: notifyAdmins dedups on a five-minute
// window, which is a flap guard rather than an alert-once guarantee, so
// without the created_at filter every tick would re-raise the same ECO
// forever; and a PLM instance carries changes for the supplier's whole
// catalogue, so without the item_master intersection the useful ones would be
// buried in the noise that gets alerting switched off.
const alertOnImpact = async (svc, tenantId, upserted, beforeUpsert) => {
  const fresh = (upserted || []).filter((r) => r.created_at && r.created_at >= beforeUpsert);
  if (!fresh.length) return { new_changes: 0, impacting: 0 };

  const keys = affectedPartKeys(fresh);
  if (!keys.length) return { new_changes: fresh.length, impacting: 0 };

  // One bounded lookup for the whole batch rather than a query per change.
  const im = await svc.from("item_master")
    .select("part_no").eq("tenant_id", tenantId).in("part_no", keys);
  if (im.error) return { new_changes: fresh.length, impacting: 0, error: im.error.message };

  const impacts = matchChangesToParts(fresh, (im.data || []).map((r) => r.part_no));
  if (!impacts.length) return { new_changes: fresh.length, impacting: 0 };

  // One notification per ECO, keyed on its external id, so two changes landing
  // in the same tick do not collapse into each other under the 5-minute dedup.
  for (const impact of impacts) {
    await notifyAdmins(svc, tenantId, {
      kind: "plm_change_impacts_stock",
      title: "Engineering change affects a part you hold",
      body: describeImpact(impact),
      // notifyAdmins builds an explicit row rather than spreading the payload,
      // so a field admin_notifications does not have (there is no `severity`
      // column) would be dropped in silence. These four exist.
      link_route: "#/admin?tab=plm",
      object_type: "plm_change",
      // The ROW id, not external_id. object_id is a uuid column, and a text
      // external id would fail the insert — which notifyAdmins catches and
      // reports as { notified: 0 }, so the alert would never fire and nothing
      // would say why.
      object_id: impact.change.id,
    }, { dedupKey: "plm_change:" + impact.change.external_id });
  }
  return { new_changes: fresh.length, impacting: impacts.length };
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
      // Stamped BEFORE the upsert so a row's created_at tells us whether this
      // run is the first time we saw that ECO. The upsert re-touches rows we
      // already had, so "returned by the upsert" is not the same as "new".
      const beforeUpsert = new Date().toISOString();
      const { data: upserted, error } = await svc.from("plm_changes")
        .upsert(rows, { onConflict: "tenant_id,source_system,external_id" })
        .select("id, external_id, eco_number, title, status, effective_date, affected_parts, created_at");
      if (error) throw new Error("Change upsert: " + error.message);
      result.changes = changes.length;
      result.impact = await alertOnImpact(svc, system.tenant_id, upserted || [], beforeUpsert);
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
