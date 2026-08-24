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
import { affectedPartKeys, matchChangesToParts, describeImpact, partKey } from "../_lib/plm-impact.js";
import { directChildren, ourChildren, compareBom, describeBomDrift, comparable } from "../_lib/plm-bom-drift.js";

const isCronAuthed = (req) => {
  const got = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  const want = process.env.CRON_SECRET || "";
  return want && got && got === want;
};

// A bounded `.in(...)` — PostgREST puts the whole list in the URL.
//
// plmFetchBoms pulls up to 500 parts ($top), so an unchunked .in() on 500 part
// numbers is a ~7.5KB query string against a cap that is usually 8KB. It would
// work in testing and fail on somebody's larger catalogue, which is the worst
// way for it to fail. 100 is the batch size bom-import-core.js already uses.
const IN_BATCH = 100;
const selectIn = async (svc, table, columns, filters, column, values) => {
  const out = [];
  for (let i = 0; i < values.length; i += IN_BATCH) {
    let q = svc.from(table).select(columns);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const r = await q.in(column, values.slice(i, i + IN_BATCH));
    if (r.error) return { error: r.error };
    out.push(...(r.data || []));
  }
  return { data: out };
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
  const im = await selectIn(svc, "item_master", "part_no", { tenant_id: tenantId }, "part_no", keys);
  if (im.error) return { new_changes: fresh.length, impacting: 0, error: im.error.message };

  const impacts = matchChangesToParts(fresh, (im.data || []).map((r) => r.part_no));
  if (!impacts.length) return { new_changes: fresh.length, impacting: 0 };

  // One notification per impacting ECO. Idempotency across ticks is the
  // created_at filter above, not a dedup key — see the note in the call.
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
      // Same reasoning as the BOM loop below: notifyAdmins ignores the key's
      // value, so a per-ECO key would drop every impacting change after the
      // first in a tick. #501 shipped with one and a comment claiming it
      // prevented exactly the collapse it was causing.
    });
  }
  return { new_changes: fresh.length, impacting: impacts.length };
};

// TELL SOMEBODY THE SUPPLIER'S BOM STOPPED MATCHING OURS.
//
// plm_boms was the second write-only table in this mirror. It is the more
// consequential one: an ECO announces a change, but a BOM revision IS the
// change — a child dropped upstream is a part we may still be buying, and one
// added upstream is a part we are not.
//
// Fires only when the supplier's REVISION MOVED (or the assembly is new to
// us), and only for assemblies we hold a BOM for.
//
// The revision test is the ONLY thing making this idempotent, and that is not
// belt-and-braces — it is the single mechanism. notifyAdmins appears to dedup
// on a five-minute window but does not: notifications.js:42 uses dedupKey only
// as a truthiness gate, never comparing the string, and the guard behind it
// reads `data` from a head:true request, which postgrest always returns as
// null. Nothing has ever been deduped, for any caller. So without the revision
// gate a drifted BOM — which stays drifted until somebody fixes it — would
// alert on every tick forever.
//
// Nothing to compare against, i.e. no BOM of our own for that parent, is not
// drift; alerting on it would fire for the supplier's entire catalogue.
const alertOnBomDrift = async (svc, tenantId, rows, priorRev) => {
  const revised = (rows || []).filter((r) => {
    if (!r.part_number) return false;
    if (!priorRev.has(r.external_id)) return true;              // new to us
    return (priorRev.get(r.external_id) ?? null) !== (r.revision ?? null);
  });
  if (!revised.length) return { revised: 0, drifted: 0 };

  // The PARENT has to be matched the same way the children are.
  //
  // Every child goes through partKey (trim + uppercase). The parent was being
  // compared as raw text on both sides, so a supplier assembly stored as
  // "assy-1" against our "ASSY-1" found nothing, fell through the
  // "we do not build it" continue below, and was silently never compared —
  // the feature would simply never fire, with no error and no log.
  //
  // There is no canonical part-number column to join on, so the query asks for
  // the plausible spellings and the map is keyed by partKey. That covers case
  // and padding, which is what actually varies; a parent differing in
  // punctuation is still missed, and deliberately so — partKey does not guess
  // that "AB-1" and "AB1" are the same part.
  const parentVariants = [...new Set(revised.flatMap((r) => {
    const p = String(r.part_number);
    return [p, p.trim(), p.trim().toUpperCase(), p.trim().toLowerCase()];
  }))];
  const bom = await selectIn(svc, "bill_of_materials", "parent_part_no, child_part_no, qty, uom",
    { tenant_id: tenantId }, "parent_part_no", parentVariants);
  if (bom.error) return { revised: revised.length, drifted: 0, error: bom.error.message };

  const byParent = new Map();
  for (const r of bom.data || []) {
    const key = partKey(r.parent_part_no);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }

  let drifted = 0;
  const skipped = {};
  // Cap the alerts. The plm handler has no CRON_HANDLER_BUDGETS entry so it
  // runs on the 20s default, and the plm_boms upsert COMMITS BEFORE this loop —
  // so a budget kill mid-loop leaves the revisions already written, the next
  // tick sees them unchanged, and the un-alerted tail never fires at all. A
  // bounded loop plus a roll-up is the difference between "we told you about
  // 25 of 300" and silently losing 275.
  const MAX_ALERTS = 25;
  for (const r of revised) {
    if (drifted >= MAX_ALERTS) break;
    const mine = byParent.get(partKey(r.part_number));
    if (!mine || !mine.length) continue;   // we do not build it; nothing to drift from
    // Refuse an incomplete tree. See comparable(): the pull is incremental, so
    // a just-revised parent usually arrives WITHOUT its unchanged children, and
    // comparing that reports a deletion that never happened.
    const safe = comparable(r.structure, mine.length);
    if (!safe.ok) { skipped[safe.reason] = (skipped[safe.reason] || 0) + 1; continue; }
    const drift = compareBom(directChildren(r.structure), ourChildren(mine));
    if (!drift.drifted) continue;
    drifted++;
    await notifyAdmins(svc, tenantId, {
      kind: "plm_bom_drift",
      title: "Supplier revised a BOM you also hold",
      body: describeBomDrift(r.part_number, r.revision, drift),
      link_route: "#/admin?tab=plm",
      object_type: "plm_bom",
      // The uuid row id would need a select-back off the upsert; part_number is
      // the thing an operator searches for and object_id is a uuid column, so
      // neither belongs here. Left null rather than passing a type that fails
      // the insert into an error notifyAdmins swallows.
      // NO dedupKey, and that is not an oversight.
      //
      // notifyAdmins does not read the key's VALUE — notifications.js:42-51
      // filters on tenant + kind + unresolved + the last five minutes, and the
      // string is never compared. So passing one here would mean the FIRST
      // drifted assembly notifies and every other one in the same tick is
      // silently swallowed, which is the opposite of what a per-assembly key
      // looks like it is doing.
      //
      // Idempotency across ticks comes from the revision gate above, which is
      // the honest mechanism. Within a tick, each drifted assembly is distinct
      // information and deserves its own row.
    });
  }
  if (drifted >= MAX_ALERTS) {
    await notifyAdmins(svc, tenantId, {
      kind: "plm_bom_drift",
      title: "More supplier BOM drift than could be listed",
      body: "Stopped after " + MAX_ALERTS + " alerts on this sync. Review the PLM tab; the rest are not queued and will not re-fire, because the revisions have already been recorded.",
      link_route: "#/admin?tab=plm",
    });
  }
  return { revised: revised.length, drifted, skipped };
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
      // What we held for these assemblies BEFORE the upsert overwrites it.
      // A revision that moved is the signal; see alertOnBomDrift.
      const priorRev = new Map();
      let priorRevUsable = true;
      {
        const ids = rows.map((r) => r.external_id).filter(Boolean);
        if (ids.length) {
          const prior = await selectIn(svc, "plm_boms", "external_id, revision",
            { tenant_id: system.tenant_id, source_system: system.system }, "external_id", ids);
          // FAIL CLOSED. selectIn returns { error } with no data, so an
          // unchecked failure leaves priorRev empty — every assembly then looks
          // new to us and the whole catalogue alerts at once. Skipping the
          // comparison for one tick is the cheaper mistake by a wide margin.
          if (prior.error) priorRevUsable = false;
          else for (const r of prior.data || []) priorRev.set(r.external_id, r.revision ?? null);
        }
      }
      const { error } = await svc.from("plm_boms")
        .upsert(rows, { onConflict: "tenant_id,source_system,external_id" });
      if (error) throw new Error("BOM upsert: " + error.message);
      result.boms = boms.length;
      // Alerting must never fail the sync. The mirror is the job; telling
      // somebody about it is a side benefit, and both alert helpers sit inside
      // the try whose catch sets result.error and flips plm_sync_state to
      // errored. A malformed structure or one bad notify row would otherwise
      // report the BOM pull as broken when it worked perfectly.
      try {
        result.bom_drift = priorRevUsable
          ? await alertOnBomDrift(svc, system.tenant_id, rows, priorRev)
          : { revised: 0, drifted: 0, skipped: "prior_revision_read_failed" };
      }
      catch (e) { result.bom_drift = { error: e?.message || String(e) }; }
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
      // Same guard for the ECO half, shipped in #501 without one.
      try { result.impact = await alertOnImpact(svc, system.tenant_id, upserted || [], beforeUpsert); }
      catch (e) { result.impact = { error: e?.message || String(e) }; }
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
