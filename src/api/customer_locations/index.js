// GET /api/customer_locations
//
// Lists every customer_locations row for the tenant, joined with
// customer_name so the so-intake dialog's address picker can show:
//   "Tata Steel, Pune (default_ship)"
//
// The intake "new customer" dialog uses this to let the operator
// pick an existing address (e.g. another customer ships to the
// same plant) instead of re-typing it. The user's spec calls
// addresses a "relational object from other existing addresses
// of other customers in the database"; this endpoint is the read
// side of that.
//
// Optional query params:
//   ?customer_id=...  scope to a single customer
//   ?q=...            substring filter against city + plant_name
//                     + customer_name

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

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
    const svc = serviceClient();

    let q = svc.from("customer_locations")
      .select("id, customer_id, location_code, plant_name, gstin, state_code, address_line1, address_line2, city, pincode, is_default, created_at")
      .eq("tenant_id", ctx.tenantId)
      .order("is_default", { ascending: false })
      .order("city", { ascending: true })
      .limit(500);
    if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
    const { data: locations, error } = await q;
    if (error) throw new Error(error.message);

    // Join with customer_name so the picker shows useful labels. We
    // do this client-side rather than via Supabase's foreign-table
    // syntax so the response stays stable when an FK relationship
    // isn't visible to PostgREST.
    const ids = [...new Set((locations || []).map((l) => l.customer_id).filter(Boolean))];
    const customerById = {};
    if (ids.length) {
      const { data: customers } = await svc.from("customers")
        .select("id, customer_name, customer_key")
        .eq("tenant_id", ctx.tenantId)
        .in("id", ids);
      (customers || []).forEach((c) => { customerById[c.id] = c; });
    }
    let rows = (locations || []).map((l) => ({
      ...l,
      customer_name: customerById[l.customer_id]?.customer_name || null,
      customer_key:  customerById[l.customer_id]?.customer_key || null,
    }));

    // Substring filter (post-fetch; Supabase ilike across multiple
    // columns + a join would need a view).
    const qstr = (req.query.q || "").toString().trim().toLowerCase();
    if (qstr) {
      rows = rows.filter((l) => {
        const blob = [
          l.customer_name, l.plant_name, l.city, l.address_line1, l.pincode, l.location_code,
        ].filter(Boolean).join(" ").toLowerCase();
        return blob.includes(qstr);
      });
    }

    return json(res, 200, { locations: rows });
  } catch (err) { sendError(res, err); }
}
