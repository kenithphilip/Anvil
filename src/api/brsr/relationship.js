// /api/brsr/relationship
//   GET                       my relationships (both sides)
//   POST  /invite             buyer invites a supplier
//   POST  /accept   { id }    supplier accepts the invite
//   POST  /reject   { id }    supplier rejects the invite
//   POST  /revoke   { id }    either side revokes a previously-active link
//
// The supplier-buyer link governs BRSR data sharing. Disclosure
// rows have a buyer-read RLS policy that fires only when the
// matching row in value_chain_relationships has
// consent_status='accepted'. So this endpoint IS the data-sharing
// gate; treat it carefully.
//
// RBAC: admin / finance / sales_manager. The buyer can invite;
// only the supplier can accept/reject. Either side can revoke.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const validShare = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    // /api/brsr/relationship[/<action>]
    const action = segments[3];

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      // Two-sided read: rows where we are the buyer OR the supplier.
      const r = await svc.from("value_chain_relationships").select("*")
        .or(`buyer_tenant_id.eq.${ctx.tenantId},supplier_tenant_id.eq.${ctx.tenantId}`)
        .order("created_at", { ascending: false });
      if (r.error) throw new Error(r.error.message);
      const buyer = (r.data || []).filter((row) => row.buyer_tenant_id === ctx.tenantId);
      const supplier = (r.data || []).filter((row) => row.supplier_tenant_id === ctx.tenantId);
      return json(res, 200, { buyer, supplier });
    }

    if (req.method === "POST" && action === "invite") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.supplier_tenant_id) {
        return json(res, 400, { error: { message: "supplier_tenant_id required" } });
      }
      if (body.supplier_tenant_id === ctx.tenantId) {
        return json(res, 400, { error: { message: "cannot invite yourself" } });
      }
      const row = {
        buyer_tenant_id: ctx.tenantId,
        supplier_tenant_id: body.supplier_tenant_id,
        relationship_type: body.relationship_type === "downstream" ? "downstream" : "upstream",
        buyer_purchase_share_pct: validShare(body.buyer_purchase_share_pct),
        consent_status: "pending",
        invited_by_user_id: ctx.user?.id || null,
        invited_at: new Date().toISOString(),
      };
      const up = await svc.from("value_chain_relationships")
        .upsert(row, { onConflict: "supplier_tenant_id,buyer_tenant_id,relationship_type" })
        .select("*").maybeSingle();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, {
        action: "brsr.relationship.invited",
        objectType: "value_chain_relationship",
        objectId: up.data?.id,
        detail: { supplier_tenant_id: body.supplier_tenant_id },
      });
      return json(res, 200, { relationship: up.data });
    }

    if (req.method === "POST" && (action === "accept" || action === "reject" || action === "revoke")) {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.id) {
        return json(res, 400, { error: { message: "id required" } });
      }
      // Validate the action against the row's current state and
      // the requesting tenant.
      const existing = await svc.from("value_chain_relationships")
        .select("*").eq("id", body.id).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) return json(res, 404, { error: { message: "relationship not found" } });
      const r = existing.data;

      if ((action === "accept" || action === "reject") && r.supplier_tenant_id !== ctx.tenantId) {
        return json(res, 403, { error: { message: "only the supplier can accept/reject" } });
      }
      if (action === "revoke" && r.supplier_tenant_id !== ctx.tenantId && r.buyer_tenant_id !== ctx.tenantId) {
        return json(res, 403, { error: { message: "only a party to the relationship can revoke" } });
      }
      const now = new Date().toISOString();
      const patch = {};
      if (action === "accept") {
        patch.consent_status = "accepted";
        patch.consent_at = now;
      } else if (action === "reject") {
        patch.consent_status = "rejected";
      } else {
        patch.consent_status = "revoked";
        patch.revoked_at = now;
      }
      const upd = await svc.from("value_chain_relationships")
        .update(patch).eq("id", body.id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "brsr.relationship." + action,
        objectType: "value_chain_relationship",
        objectId: body.id,
        detail: { from: r.consent_status, to: patch.consent_status },
      });
      return json(res, 200, { relationship: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}

export const __test = { validShare };
