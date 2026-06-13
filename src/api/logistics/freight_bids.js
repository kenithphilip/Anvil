// /api/logistics/freight_bids
//   GET   ?consolidation_id=        bids for a consolidation
//   POST  { consolidation_id, carrier, service?, unit?, rate_per_unit?,
//           total_cost?, currency?, transit_days?, valid_until?, notes? }
//                                    record a carrier/forwarder quote
//   POST  { action: "award", id }   award one bid (others -> rejected;
//                                    consolidation -> awarded)
//   DELETE ?id=...
//
// P4: the bidding side of freight consolidation.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const handleAward = async (svc, ctx, body, res) => {
  if (!body.id) return json(res, 400, { error: { message: "id required" } });
  const bidRes = await svc.from("freight_bids").select("*")
    .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
  if (bidRes.error) throw new Error(bidRes.error.message);
  if (!bidRes.data) return json(res, 404, { error: { message: "Bid not found" } });
  const bid = bidRes.data;

  // Award this bid; reject the others on the same consolidation.
  const awarded = await svc.from("freight_bids")
    .update({ status: "awarded", updated_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("id", bid.id).select("*").single();
  if (awarded.error) throw new Error(awarded.error.message);
  await svc.from("freight_bids")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("consolidation_id", bid.consolidation_id).neq("id", bid.id).eq("status", "pending");
  await svc.from("freight_consolidations")
    .update({ status: "awarded", updated_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("id", bid.consolidation_id);
  await recordAudit(ctx, { action: "freight_bid_awarded", objectType: "freight_consolidation", objectId: bid.consolidation_id, after: { bid_id: bid.id, carrier: bid.carrier } });
  return json(res, 200, { bid: awarded.data });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (!req.query.consolidation_id) return json(res, 400, { error: { message: "consolidation_id required" } });
      const { data, error } = await svc.from("freight_bids").select("*")
        .eq("tenant_id", ctx.tenantId).eq("consolidation_id", req.query.consolidation_id)
        .order("total_cost", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { bids: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (body.action === "award") return await handleAward(svc, ctx, body, res);
      if (!body.consolidation_id || !body.carrier) {
        return json(res, 400, { error: { message: "consolidation_id and carrier required" } });
      }
      const num = (v) => (v == null || v === "" ? null : Number(v));
      const row = {
        tenant_id: ctx.tenantId,
        consolidation_id: body.consolidation_id,
        carrier: String(body.carrier),
        service: body.service || null,
        unit: body.unit || null,
        rate_per_unit: num(body.rate_per_unit),
        total_cost: num(body.total_cost),
        currency: body.currency || "USD",
        transit_days: body.transit_days != null ? Number(body.transit_days) : null,
        valid_until: body.valid_until || null,
        notes: body.notes || null,
        status: "pending",
        updated_at: new Date().toISOString(),
      };
      const ins = await svc.from("freight_bids").insert(row).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      // Nudge the consolidation into 'bidding' once it has quotes.
      await svc.from("freight_consolidations")
        .update({ status: "bidding", updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", body.consolidation_id).eq("status", "open");
      return json(res, 200, { bid: ins.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("freight_bids").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
