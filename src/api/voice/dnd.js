// /api/voice/dnd
//
//   GET                                 list dnd entries (filterable by phone, source).
//   POST                                add one or many rows. Two payload shapes:
//                                       { phone_number, source, region?, reason? }
//                                       { rows: [{...}], source: 'tenant_manual'|... }
//                                       Bulk shape is used by the operator's CSV
//                                       upload path: split + parse CSV client-side,
//                                       POST one batch.
//   DELETE ?id=<uuid>                   remove a tenant_manual entry. Global rows
//                                       (TRAI / FCC) are not deletable via this
//                                       endpoint; they're owned by the cron loader.
//
// Audit: DEFERRED_ROADMAP §1 (voice AI). Migration 080 created the
// voice_dnd_list table with source enum (tenant_manual, trai_ndnc,
// fcc_dnc, customer_request); this is the operator-facing surface.
// The TRAI / FCC list cron loader is a separate follow-up gated on
// registry credentials.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { normalizeE164, regionFromE164 } from "../_lib/voice-compliance.js";

const VALID_SOURCES = new Set(["tenant_manual", "trai_ndnc", "fcc_dnc", "customer_request"]);
const TENANT_OWNED_SOURCES = new Set(["tenant_manual", "customer_request"]);

const buildRow = ({ tenantId, addedBy, phoneNumber, source, region, reason }) => {
  const e164 = normalizeE164(phoneNumber);
  if (!e164) {
    throw Object.assign(new Error("phone_number could not be parsed to E.164"), { status: 400 });
  }
  const src = source || "tenant_manual";
  if (!VALID_SOURCES.has(src)) {
    throw Object.assign(new Error("source must be one of: " + [...VALID_SOURCES].join(", ")), { status: 400 });
  }
  // Tenant-only enforcement: a tenant-scoped POST cannot insert
  // global rows (those land via the future cron loader using a
  // service-role bypass; out of scope here).
  if (!TENANT_OWNED_SOURCES.has(src)) {
    throw Object.assign(new Error("source '" + src + "' is owned by the registry cron loader; not insertable from the tenant API"), { status: 403 });
  }
  return {
    tenant_id: tenantId,
    phone_number: e164,
    source: src,
    region: region || regionFromE164(e164),
    reason: reason || null,
    added_by: addedBy || null,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const phone = req.query?.phone || null;
      const source = req.query?.source || null;
      const limit = Math.min(Number(req.query?.limit) || 200, 1000);
      let q = svc.from("voice_dnd_list")
        .select("id, tenant_id, phone_number, source, region, reason, added_at, source_loaded_at")
        .or("tenant_id.eq." + ctx.tenantId + ",tenant_id.is.null")
        .order("added_at", { ascending: false })
        .limit(limit);
      if (phone) {
        const e164 = normalizeE164(phone);
        if (!e164) return json(res, 400, { error: { message: "phone could not be parsed to E.164" } });
        q = q.eq("phone_number", e164);
      }
      if (source) {
        if (!VALID_SOURCES.has(source)) {
          return json(res, 400, { error: { message: "source must be one of: " + [...VALID_SOURCES].join(", ") } });
        }
        q = q.eq("source", source);
      }
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { rows: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      // Bulk: { rows: [...], source }
      if (Array.isArray(body?.rows)) {
        if (body.rows.length === 0) return json(res, 400, { error: { message: "rows array is empty" } });
        if (body.rows.length > 5000) return json(res, 400, { error: { message: "rows capped at 5000 per request; split the CSV" } });
        const built = [];
        const errors = [];
        body.rows.forEach((r, i) => {
          try {
            built.push(buildRow({
              tenantId: ctx.tenantId,
              addedBy: ctx.user?.id || null,
              phoneNumber: r.phone_number,
              source: r.source || body.source || "tenant_manual",
              region: r.region,
              reason: r.reason,
            }));
          } catch (err) {
            errors.push({ row: i, phone: r.phone_number, error: err.message });
          }
        });
        if (built.length === 0) {
          return json(res, 400, { error: { message: "No rows could be parsed", errors } });
        }
        // Idempotent: ON CONFLICT DO NOTHING on the (tenant_id,
        // phone_number, source) unique index. Migration 080 used
        // coalesce(tenant_id::text, '') as part of the index; we
        // don't have a clean upsert match here so insert + ignore
        // duplicates. Supabase JS doesn't expose ignoreDuplicates
        // for a custom expression index; we just count successful
        // inserts and report the rest as duplicates.
        const ins = await svc.from("voice_dnd_list").insert(built, { upsert: false }).select("id, phone_number");
        // PostgREST returns a 23505 unique violation if any row
        // conflicts; we pass the rows individually as a fallback.
        if (ins.error) {
          // Retry one by one to surface partial success.
          const succeeded = [];
          const skipped = [];
          for (const row of built) {
            const r = await svc.from("voice_dnd_list").insert(row).select("id, phone_number").maybeSingle();
            if (r.error) skipped.push({ phone: row.phone_number, error: r.error.message });
            else if (r.data) succeeded.push(r.data);
          }
          await recordAudit(ctx, {
            action: "voice_dnd_bulk_upload",
            objectType: "voice_dnd_list",
            objectId: null,
            detail: "succeeded=" + succeeded.length + " skipped=" + skipped.length + " parse_errors=" + errors.length,
          });
          return json(res, 200, { added: succeeded, skipped, parse_errors: errors });
        }
        await recordAudit(ctx, {
          action: "voice_dnd_bulk_upload",
          objectType: "voice_dnd_list",
          objectId: null,
          detail: "added=" + (ins.data || []).length + " parse_errors=" + errors.length,
        });
        return json(res, 200, { added: ins.data || [], skipped: [], parse_errors: errors });
      }
      // Single-row payload.
      let row;
      try {
        row = buildRow({
          tenantId: ctx.tenantId,
          addedBy: ctx.user?.id || null,
          phoneNumber: body?.phone_number,
          source: body?.source,
          region: body?.region,
          reason: body?.reason,
        });
      } catch (err) {
        return json(res, err.status || 400, { error: { message: err.message } });
      }
      const ins = await svc.from("voice_dnd_list").insert(row).select("id, phone_number, source").single();
      if (ins.error) {
        // Treat unique-constraint violation as 200 + already_present.
        if (/unique|duplicate|23505/i.test(ins.error.message)) {
          return json(res, 200, { id: null, phone_number: row.phone_number, already_present: true });
        }
        throw new Error(ins.error.message);
      }
      await recordAudit(ctx, {
        action: "voice_dnd_added",
        objectType: "voice_dnd_list",
        objectId: ins.data.id,
        detail: ins.data.phone_number + "::" + ins.data.source,
      });
      return json(res, 200, { id: ins.data.id, phone_number: ins.data.phone_number, source: ins.data.source });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query?.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      // Tenant scope: refuse to delete a global row from the
      // tenant API. Global rows are owned by the cron loader.
      const r = await svc.from("voice_dnd_list")
        .delete()
        .eq("id", id)
        .eq("tenant_id", ctx.tenantId)
        .select("id, phone_number, source")
        .maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return json(res, 404, { error: { message: "Row not found in this tenant; global rows are not deletable here" } });
      await recordAudit(ctx, {
        action: "voice_dnd_removed",
        objectType: "voice_dnd_list",
        objectId: r.data.id,
        detail: r.data.phone_number + "::" + r.data.source,
      });
      return json(res, 200, { id: r.data.id, removed: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}

export const __test = { buildRow, VALID_SOURCES, TENANT_OWNED_SOURCES };
