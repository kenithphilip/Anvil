// GET /api/logistics/freight_allocation?consolidation_id=...
//
// What does the awarded freight bid cost, per part, per unit?
//
// Anvil awards a real ocean bid against a consolidation (migration 145) and
// then prices customer quotes with a hand-typed shipping figure, because the
// awarded number was never carried across. freight_bids is referenced nowhere
// outside its own module. This is the read that carries it.
//
// The per-unit figure it returns is exactly what the price composition's
// `shipping` component consumes — a per_unit adder in base currency
// (migration 135) — so a quote line's freight can be traced to a named
// carrier's awarded rate instead of a number somebody typed.
//
// READ-ONLY. It computes and reports; it writes nothing and changes no price.
// Wiring it into the composition is the next step and deliberately separate,
// so the figures can be checked against real awarded bids before any quote
// starts moving.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { allocateFreight } from "../_lib/freight-allocate.js";

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
    const consolidationId = req.query?.consolidation_id;
    if (!consolidationId) return json(res, 400, { error: { message: "consolidation_id required" } });
    const svc = serviceClient();

    const conQ = await svc.from("freight_consolidations")
      .select("id, mode, origin, destination, window_week, weight_kg, volume_cbm, containers, parts, status")
      .eq("tenant_id", ctx.tenantId).eq("id", consolidationId).maybeSingle();
    if (conQ.error) throw new Error("freight_consolidations read: " + conQ.error.message);
    if (!conQ.data) return json(res, 404, { error: { message: "Consolidation not found" } });
    const con = conQ.data;

    const bidQ = await svc.from("freight_bids")
      .select("id, carrier, service, unit, rate_per_unit, total_cost, currency, transit_days, valid_until, status")
      .eq("tenant_id", ctx.tenantId).eq("consolidation_id", consolidationId).eq("status", "awarded")
      .order("updated_at", { ascending: false }).limit(1);
    if (bidQ.error) throw new Error("freight_bids read: " + bidQ.error.message);
    const bid = (bidQ.data || [])[0] || null;

    if (!bid) {
      // Not an error — most consolidations are open or still bidding. The
      // caller needs to tell "no award yet" from "awarded but unallocatable".
      return json(res, 200, {
        consolidation_id: consolidationId, awarded: false,
        reason: "no_awarded_bid", lane: { origin: con.origin, destination: con.destination, window_week: con.window_week },
        allocation: null,
      });
    }

    // The consolidation's own parts, enriched with whatever dimensions the item
    // master happens to hold. Today that is nothing — 1,000 items sampled live,
    // zero with weight or volume, and no screen or importer can write them — so
    // the allocator drops to line value. It picks weight the moment weights
    // appear, with no change here.
    const parts = Array.isArray(con.parts) ? con.parts : [];
    const partNos = [...new Set(parts.map((p) => p?.part_no).filter(Boolean))];
    let master = new Map();
    if (partNos.length) {
      const imQ = await svc.from("item_master")
        .select("part_no, weight_kg, volume_cbm, standard_cost, last_purchase_price")
        .eq("tenant_id", ctx.tenantId).in("part_no", partNos);
      if (!imQ.error) master = new Map((imQ.data || []).map((r) => [r.part_no, r]));
    }

    const lines = parts.map((p) => {
      const m = master.get(p?.part_no) || {};
      return {
        part_no: p?.part_no || null,
        qty: p?.qty ?? null,
        weight_kg: m.weight_kg ?? null,
        volume_cbm: m.volume_cbm ?? null,
        // A value basis needs a price. The plan carries none, so fall back to
        // the master's cost — and when that is absent too the allocator drops
        // to quantity rather than inventing one.
        unit_price: p?.unit_price ?? m.last_purchase_price ?? m.standard_cost ?? null,
      };
    });

    const allocation = allocateFreight(bid.total_cost, lines, { currency: bid.currency || null });

    return json(res, 200, {
      consolidation_id: consolidationId,
      awarded: true,
      lane: { origin: con.origin, destination: con.destination, window_week: con.window_week, mode: con.mode },
      bid: {
        id: bid.id, carrier: bid.carrier, service: bid.service,
        total_cost: bid.total_cost, currency: bid.currency,
        unit: bid.unit, rate_per_unit: bid.rate_per_unit,
        transit_days: bid.transit_days,
        valid_until: bid.valid_until,
        // The cost basis has a shelf life. A quote priced from an expired bid
        // is a guess wearing a carrier's name.
        expired: bid.valid_until ? new Date(bid.valid_until) < new Date() : null,
      },
      allocation,
      // How much of the consolidation the item master could describe. Reported
      // so "we allocated by value" is visibly a consequence of missing data
      // rather than a preference.
      dimension_coverage: {
        parts: partNos.length,
        with_weight: lines.filter((l) => Number(l.weight_kg) > 0).length,
        with_volume: lines.filter((l) => Number(l.volume_cbm) > 0).length,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
}
