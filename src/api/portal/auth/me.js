// GET /api/portal/auth/me — the logged-in portal user's profile + their customer.
// Session-authenticated (Bearer). The frontend calls this after login to render
// the shell (who am I, which customer's data am I seeing).

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { resolveCustomerContext } from "../../_lib/portal-auth.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveCustomerContext(req);
    const svc = serviceClient();
    const cust = await svc.from("customers")
      .select("customer_name, contact_email")
      .eq("tenant_id", ctx.tenantId).eq("id", ctx.customerId).maybeSingle();
    return json(res, 200, {
      user: { id: ctx.portalUserId, email: ctx.email, role: ctx.role },
      customer: cust.data || null,
    });
  } catch (err) {
    sendError(res, err);
  }
}
