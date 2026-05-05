// /api/sourcing/network/listings
//   GET                          list this tenant's published listings
//   POST   {sku, ...}            create or upsert a listing
//   DELETE ?id=                  remove a listing
//
// Phase 5.6: in-network back-to-back sourcing. The listings owned
// by this tenant are what gets exposed (anonymously) to peer
// tenants who have also opted in to network_share.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const url = new URL(req.url, "http://x");
      const includeInactive = url.searchParams.get("include_inactive") === "1";
      let q = svc.from("network_listings")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("refreshed_at", { ascending: false })
        .limit(500);
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { listings: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.sku) return json(res, 400, { error: { message: "sku required" } });
      const row = {
        tenant_id: ctx.tenantId,
        sku: String(body.sku).trim(),
        description: body.description || null,
        uom: body.uom || null,
        available_qty: body.available_qty != null ? Number(body.available_qty) : null,
        lead_time_days: body.lead_time_days != null ? Math.max(0, Number(body.lead_time_days)) : null,
        currency: body.currency || "USD",
        transfer_unit_price: body.transfer_unit_price != null ? Number(body.transfer_unit_price) : null,
        notes: body.notes || null,
        active: body.active !== false,
        source: body.source || "manual",
        source_ref: body.source_ref || null,
        refreshed_at: new Date().toISOString(),
      };
      // Upsert by (tenant_id, sku). The unique constraint on those
      // columns guarantees one row per SKU per tenant.
      const { data, error } = await svc.from("network_listings")
        .upsert(row, { onConflict: "tenant_id,sku" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, {
        action: "network_listing_upsert",
        objectType: "network_listing",
        objectId: data.id,
        after: { sku: row.sku, available_qty: row.available_qty, active: row.active },
      });
      return json(res, 200, { listing: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const url = new URL(req.url, "http://x");
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("network_listings")
        .delete()
        .eq("id", id)
        .eq("tenant_id", ctx.tenantId);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "network_listing_delete", objectType: "network_listing", objectId: id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
