// /api/failure_events - in-field failure / replacement event stream (reliability step 4a)
//   GET  ?equipment_id= | ?part_no=  list events (tenant-scoped, newest first)
//   POST  create an event for an asset instance
//
// item_id is auto-resolved from part_no by the DB trigger (migration 174 reuses
// set_item_id_from_part_no from 171). This endpoint only captures/lists events; it
// deliberately does not feed the planning engine (that is step 4b).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const EVENT_TYPES = new Set(["breakdown", "pm", "inspection", "replacement"]);
const num = (v) => { const n = Number(v); return (v != null && v !== "" && Number.isFinite(n)) ? n : null; };
// replaced_qty is an integer column -- round + clamp non-negative so bad input
// returns a clean value (never a 500 from a fractional/out-of-range DB insert).
const intOrNull = (v) => { const n = num(v); return n == null ? null : Math.max(0, Math.min(2147483647, Math.round(n))); };
// downtime_hours is numeric; keep it non-negative.
const nonNegOrNull = (v) => { const n = num(v); return n == null ? null : Math.max(0, n); };
const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("failure_events").select("*").eq("tenant_id", ctx.tenantId)
        .order("failed_at", { ascending: false }).limit(2000);
      if (req.query.equipment_id) q = q.eq("equipment_id", req.query.equipment_id);
      if (req.query.part_no) q = q.eq("part_no", req.query.part_no);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { events: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.equipment_id) return json(res, 400, { error: { message: "equipment_id required" } });
      // The asset instance MUST belong to this tenant -- the FK alone does not
      // enforce tenant isolation, so never trust a raw body equipment_id.
      const eq = await svc.from("equipment_hierarchy").select("id")
        .eq("tenant_id", ctx.tenantId).eq("id", body.equipment_id).maybeSingle();
      if (eq.error) throw new Error(eq.error.message);
      if (!eq.data) return json(res, 400, { error: { message: "Equipment not found in this tenant." } });

      const eventType = typeof body.event_type === "string" && EVENT_TYPES.has(body.event_type)
        ? body.event_type : "breakdown";
      // Normalize failed_at: accept a date/datetime string, fall back to now for
      // absent/unparseable input (so a bad value never 500s the insert).
      const failedAt = body.failed_at && !Number.isNaN(Date.parse(body.failed_at))
        ? new Date(body.failed_at).toISOString() : new Date().toISOString();

      const row = {
        tenant_id: ctx.tenantId,
        equipment_id: body.equipment_id,
        part_no: cleanStr(body.part_no),
        failed_at: failedAt,
        event_type: eventType,
        failure_mode: cleanStr(body.failure_mode),
        replaced_qty: intOrNull(body.replaced_qty),
        downtime_hours: nonNegOrNull(body.downtime_hours),
        notes: cleanStr(body.notes),
        created_by: ctx.user?.id || null,
      };
      const result = await svc.from("failure_events").insert(row).select("*").single();
      if (result.error) throw new Error(result.error.message);
      await recordAudit(ctx, {
        action: "failure_event_create",
        objectType: "failure_event",
        objectId: result.data.id,
        detail: eventType + (row.part_no ? " :: " + row.part_no : ""),
      });
      return json(res, 200, { event: result.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
