// POST /api/spare_matrix/<id>/share
//
// Shares a spare matrix with its customer via the customer portal: provisions
// (or reuses) a portal_tokens row for the matrix's customer, ensures it carries
// the 'spares' scope, and returns the shareable link + token. The customer then
// views the matrix read-only via /api/portal/view?token=...&kind=spare_matrix.
//
// Server gate is 'write' (any internal writer); the frontend shows the Share
// button only to roles in ACTIONS['spare_matrix.share'] (sales, design,
// customer_support, admin).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import crypto from "node:crypto";

const PORTAL_BASE = process.env.PORTAL_BASE_URL || "";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const matrixId = req.query.id;
    if (!matrixId) return json(res, 400, { error: { message: "matrix id required" } });

    const svc = serviceClient();
    const m = await svc.from("spare_matrix").select("id, customer_id, name")
      .eq("tenant_id", ctx.tenantId).eq("id", matrixId).maybeSingle();
    if (m.error) throw new Error(m.error.message);
    if (!m.data) return json(res, 404, { error: { message: "matrix not found" } });
    if (!m.data.customer_id) {
      return json(res, 400, { error: { message: "Assign a customer to this matrix before sharing it." } });
    }
    const customerId = m.data.customer_id;

    // Reuse the customer's most recent active portal token (so they keep one
    // link); ensure it carries the 'spares' scope. Otherwise create a new one.
    const existing = await svc.from("portal_tokens").select("*")
      .eq("tenant_id", ctx.tenantId).eq("customer_id", customerId).is("revoked_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    let tok = null;
    const stillValid = existing.data && (!existing.data.expires_at || new Date(existing.data.expires_at) > new Date());
    if (stillValid) {
      tok = existing.data;
      if (!(tok.scopes || []).includes("spares")) {
        const upd = await svc.from("portal_tokens")
          .update({ scopes: [...(tok.scopes || []), "spares"] })
          .eq("tenant_id", ctx.tenantId).eq("id", tok.id).select("*").single();
        if (upd.error) throw new Error(upd.error.message);
        tok = upd.data;
      }
    } else {
      const ins = await svc.from("portal_tokens").insert({
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        token: crypto.randomBytes(24).toString("hex"),
        scopes: ["spares"],
        created_by: (ctx.user && ctx.user.id) || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      tok = ins.data;
    }

    await recordAudit(ctx, {
      action: "spare_matrix_shared",
      objectType: "spare_matrix",
      objectId: matrixId,
      detail: { customer_id: customerId },
    });

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const base = PORTAL_BASE || (host ? `${proto}://${host}` : "");
    const url = base ? `${base}/portal?token=${tok.token}&kind=spares` : null;

    return json(res, 200, { token: tok.token, url, scopes: tok.scopes, matrix_id: matrixId, customer_id: customerId });
  } catch (err) {
    sendError(res, err);
  }
}
