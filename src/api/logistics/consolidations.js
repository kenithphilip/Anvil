// /api/logistics/consolidations
//   GET   ?status=                 list consolidations
//   POST  { action: "build", arrival_from?, arrival_to?, statuses?, destination? }
//                                   aggregate procurement_plans into
//                                   origin-lane / week consolidations
//   POST  { id, status }           update a consolidation's status
//
// P4: turns the planner's procurement_plans (P2) into freight
// consolidations — grouped by origin lane + arrival week with an
// estimated ocean container fill — ready for LCL/FCL bidding.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { consolidatePlans } from "../_lib/freight-consolidation.js";

const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const handleBuild = async (svc, ctx, body, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = body.arrival_from || today;
  const to = body.arrival_to || addDays(today, 84); // ~12 weeks
  const statuses = Array.isArray(body.statuses) && body.statuses.length ? body.statuses : ["draft", "approved", "released"];

  const plansRes = await svc.from("procurement_plans")
    .select("id, part_no, for_week, recommended_qty, status")
    .eq("tenant_id", ctx.tenantId)
    .in("status", statuses)
    .gte("for_week", from)
    .lte("for_week", to);
  if (plansRes.error) throw new Error("plans: " + plansRes.error.message);
  const plans = plansRes.data || [];
  if (!plans.length) return json(res, 200, { consolidations: [], built: 0, note: "no procurement plans in window" });

  const parts = [...new Set(plans.map((p) => p.part_no).filter(Boolean))];
  const itemsRes = parts.length
    ? await svc.from("item_master").select("part_no, source_country, weight_kg, volume_cbm").eq("tenant_id", ctx.tenantId).in("part_no", parts)
    : { data: [] };
  const itemMap = new Map((itemsRes.data || []).map((i) => [i.part_no, i]));

  const annotated = plans.map((p) => {
    const it = itemMap.get(p.part_no) || {};
    return {
      id: p.id, part_no: p.part_no, qty: Number(p.recommended_qty) || 0,
      window_week: p.for_week, origin: it.source_country || null,
      weight_kg: it.weight_kg, volume_cbm: it.volume_cbm,
    };
  });
  const cands = consolidatePlans(annotated, { destination: body.destination || "IN" });

  const out = [];
  for (const c of cands) {
    // Partial upsert (no status) so an existing consolidation keeps its
    // bidding/awarded state while its tonnage is refreshed.
    const up = await svc.from("freight_consolidations").upsert({
      tenant_id: ctx.tenantId, mode: "ocean",
      origin: c.origin, destination: c.destination, window_week: c.window_week,
      weight_kg: c.weight_kg, volume_cbm: c.volume_cbm,
      containers: c.containers, plan_ids: c.plan_ids, parts: c.parts,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,mode,origin,destination,window_week" }).select("*").single();
    if (up.error) throw new Error("consolidation upsert: " + up.error.message);
    out.push({ ...up.data, missing_dims: c.missing_dims });
  }
  await recordAudit(ctx, { action: "freight_consolidations_built", objectType: "logistics", objectId: null, after: { built: out.length } });
  return json(res, 200, { consolidations: out, built: out.length });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("freight_consolidations").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.status) q = q.eq("status", req.query.status);
      const { data, error } = await q.order("window_week", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { consolidations: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (body.action === "build") return await handleBuild(svc, ctx, body, res);
      if (!body.id || !body.status) return json(res, 400, { error: { message: "id and status required (or action=build)" } });
      const up = await svc.from("freight_consolidations")
        .update({ status: body.status, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (up.error) throw new Error(up.error.message);
      return json(res, 200, { consolidation: up.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
