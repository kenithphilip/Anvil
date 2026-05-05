// /api/sourcing/network/search?sku=...&qty=...&order_id=...
//
// Phase 5.6: search peer tenants' published network_listings for a
// matching SKU and sufficient available quantity.
//
// Privacy guard: this endpoint is gated by the calling tenant's
// own `network_share` flag in tenant_settings. If you don't share,
// you can't browse. This is enforced both via the SELECT RLS
// policy on network_listings AND a redundant explicit check here
// (defence in depth: the RLS policy reads the JWT claim, this
// check reads the resolved context).
//
// Response shape intentionally anonymises the listing tenant. The
// caller sees a `peer_id` (a stable hash) and the buyer-relevant
// fields; they do NOT see the listing tenant's name, customer
// list, or pricing history. To make a real deal, the operator
// clicks "Initiate handoff" which writes a network_sourcing_query
// row and a notification flows to the listing tenant's owner.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import crypto from "crypto";

// Stable per-tenant hash so the asking tenant gets a consistent
// reference across multiple searches (useful for deduplication on
// the client) without ever learning the listing tenant's id. Salt
// is the calling tenant's id so peers are pseudonymous PER asker
// (a tenant can't correlate IDs across different Anvil customers).
const peerHash = (askerTenantId, listingTenantId) => {
  return crypto.createHash("sha256")
    .update(askerTenantId + ":" + listingTenantId)
    .digest("hex")
    .slice(0, 16);
};

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
    const url = new URL(req.url, "http://x");
    const sku = (url.searchParams.get("sku") || "").trim();
    const qtyNeeded = url.searchParams.get("qty") ? Number(url.searchParams.get("qty")) : null;
    const orderId = url.searchParams.get("order_id") || null;
    if (!sku) return json(res, 400, { error: { message: "sku required" } });

    const svc = serviceClient();

    // Defence-in-depth opt-in check.
    const { data: settings, error: settingsErr } = await svc
      .from("tenant_settings")
      .select("network_share")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (settingsErr) throw new Error(settingsErr.message);
    if (!settings?.network_share) {
      return json(res, 403, { error: { message: "Tenant has not opted in to network sharing. Enable network_share in tenant_settings to browse the network." } });
    }

    // Fetch all matching active listings from peer tenants. Match
    // by exact SKU first; if nothing, retry with case-insensitive
    // ilike (handles slight format mismatch). We exclude this
    // tenant's own listings from peer results.
    let { data: hits, error: hitsErr } = await svc.from("network_listings")
      .select("*")
      .eq("active", true)
      .eq("sku", sku)
      .neq("tenant_id", ctx.tenantId)
      .limit(50);
    if (hitsErr) throw new Error(hitsErr.message);
    if (!hits?.length) {
      const ilikeRes = await svc.from("network_listings")
        .select("*")
        .eq("active", true)
        .ilike("sku", sku)
        .neq("tenant_id", ctx.tenantId)
        .limit(50);
      if (ilikeRes.error) throw new Error(ilikeRes.error.message);
      hits = ilikeRes.data || [];
    }

    // Score: lead time + transfer price + available qty fit.
    const scored = (hits || []).map((row) => {
      const fits = qtyNeeded == null
        ? true
        : (Number(row.available_qty || 0) >= qtyNeeded);
      const score = (fits ? 100 : 50)
        - (Number(row.lead_time_days || 14))
        - (Number(row.transfer_unit_price || 0) * 0.01);
      return {
        peer_id: peerHash(ctx.tenantId, row.tenant_id),
        sku: row.sku,
        description: row.description,
        uom: row.uom,
        available_qty: row.available_qty,
        fits_demand: fits,
        lead_time_days: row.lead_time_days,
        currency: row.currency,
        transfer_unit_price: row.transfer_unit_price,
        notes: row.notes,
        refreshed_at: row.refreshed_at,
        listing_id: row.id,
        score,
      };
    }).sort((a, b) => b.score - a.score);

    // Audit row so we can analyse network usage and bill the
    // matching tenants. We only persist `matched_tenant_ids` (the
    // listing tenants), not the full row, so the asker's audit log
    // doesn't leak peer pricing forever.
    const matchedTenantIds = Array.from(new Set((hits || []).map((h) => h.tenant_id)));
    const { data: queryRow } = await svc.from("network_sourcing_queries").insert({
      tenant_id: ctx.tenantId,
      order_id: orderId,
      sku,
      qty_needed: qtyNeeded,
      match_count: scored.length,
      matched_tenant_ids: matchedTenantIds,
    }).select("id").single();

    return json(res, 200, {
      sku,
      qty_needed: qtyNeeded,
      query_id: queryRow?.id || null,
      matches: scored,
      match_count: scored.length,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
