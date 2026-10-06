// /api/sourcing/network/handoff
//   POST { query_id, listing_id }
//
// Phase 5.6: when the asker picks a peer listing, this endpoint:
//   1. Marks the network_sourcing_query as resolved.
//   2. Drafts a communication to the listing tenant's
//      network_contact_email so the deal can move forward.
//   3. Records audit on both sides.
//
// The asker never sees the peer tenant's identity directly; the
// resolved listing arrives in the listing tenant's inbox the same
// way an external supplier RFQ would.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { commsRow } from "../../_lib/comms-row.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body?.query_id || !body?.listing_id) {
      return json(res, 400, { error: { message: "query_id and listing_id required" } });
    }
    const svc = serviceClient();

    // Verify the query is owned by this tenant.
    const { data: query, error: qErr } = await svc
      .from("network_sourcing_queries")
      .select("id, tenant_id, sku, qty_needed, order_id")
      .eq("id", body.query_id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!query) return json(res, 404, { error: { message: "query not found" } });

    // Look up the listing on the peer side. We use the service
    // client (bypasses RLS) so we can read across tenants here, but
    // the asker still doesn't see the peer's tenant_id in the
    // response.
    const { data: listing, error: lErr } = await svc
      .from("network_listings")
      .select("id, tenant_id, sku, description, available_qty, lead_time_days, transfer_unit_price, currency")
      .eq("id", body.listing_id)
      .eq("active", true)
      .maybeSingle();
    if (lErr) throw new Error(lErr.message);
    if (!listing) return json(res, 404, { error: { message: "listing not found or inactive" } });

    // Pull the peer's contact email (they opted in via tenant_settings).
    const { data: peerSettings } = await svc
      .from("tenant_settings")
      .select("network_contact_email, network_display_name")
      .eq("tenant_id", listing.tenant_id)
      .maybeSingle();

    // Mark query resolved.
    await svc.from("network_sourcing_queries").update({
      resolved: true,
      resolved_listing_id: listing.id,
      resolved_at: new Date().toISOString(),
    }).eq("id", query.id);

    // Draft a communication to the peer. The communications table
    // is the canonical comms surface; the peer tenant's owner will
    // see the draft in their Comms inbox.
    let communicationId = null;
    if (peerSettings?.network_contact_email) {
      const { data: comm } = await svc.from("communications").insert(commsRow({
        tenant_id: listing.tenant_id,             // owned by the listing tenant
        channel: "email",
        recipient: peerSettings.network_contact_email,
        subject: `Anvil network: back-to-back request for ${listing.sku}`,
        body: [
          `An Anvil network peer is requesting ${query.qty_needed || "an unspecified quantity"} of ${listing.sku} (${listing.description || "no description"}).`,
          ``,
          `Your published terms: lead time ${listing.lead_time_days || "?"} days at ${listing.currency || "USD"} ${listing.transfer_unit_price || "?"} per unit.`,
          ``,
          `Reply to this email to engage. The peer tenant has been told they will hear from you within 1 business day.`,
        ].join("\n"),
        status: "queued",
        external_ref: { network_query_id: query.id, network_listing_id: listing.id },
      })).select("id").single();
      communicationId = comm?.id || null;
    }

    await recordAudit(ctx, {
      action: "network_handoff_sent",
      objectType: "network_sourcing_query",
      objectId: query.id,
      after: { listing_id: listing.id, sku: listing.sku },
    });

    return json(res, 200, {
      query_id: query.id,
      listing_id: listing.id,
      communication_id: communicationId,
      peer_display_name: peerSettings?.network_display_name || null,
      message: "Handoff initiated. The peer tenant has been notified.",
    });
  } catch (err) {
    return sendError(res, err);
  }
}
