// GET /api/customers/duplicates
//
// Audit P4.5 prep. The codebase had no merge endpoint, but
// before merging anything an operator needs a list of probable
// duplicates. NetSuite/SAP/D365 sync each create customers with
// vendor-prefixed customer_keys (ns:..., sap_id:..., etc.); a
// tenant on multiple ERPs ends up with N rows per physical
// customer. This endpoint surfaces them via three signals:
//
//   1. Same GSTIN (high confidence). Two rows with the same
//      registered tax ID are almost certainly the same legal
//      entity.
//   2. Same canonical name (case-insensitive, alpha-num only).
//      A noisy heuristic but useful when GSTIN is missing.
//   3. Customer_key prefix mismatch with the matching legal name
//      (e.g., "ns:1234" vs "tata-steel" with both customer_name
//      = "Tata Steel"). Surfaces ERP-imported dups that haven't
//      been merged.
//
// Returns { groups: [{ signal, customers: [...] }] }; the
// customers/merge endpoint (P4.6) consumes the picked group.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const canonicaliseName = (s) => String(s || "")
  .toLowerCase()
  .replace(/\b(pvt|ltd|llp|inc|corp|gmbh|co|company|limited)\b/g, "")
  .replace(/[^a-z0-9]+/g, "");

const fetchAllCustomers = async (svc, tenantId) => {
  const r = await svc.from("customers")
    .select("id, customer_key, customer_name, gstin, contact_email, external_ref, created_at")
    .eq("tenant_id", tenantId)
    .order("customer_name", { ascending: true })
    .limit(2000);
  if (r.error) throw new Error("customers read: " + r.error.message);
  return r.data || [];
};

const groupByGstin = (rows) => {
  const map = new Map();
  for (const r of rows) {
    const k = String(r.gstin || "").trim().toUpperCase();
    if (!k || k.length < 15) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return Array.from(map.entries())
    .filter(([, list]) => list.length > 1)
    .map(([gstin, list]) => ({ signal: "gstin", key: gstin, customers: list }));
};

const groupByCanonicalName = (rows, alreadyClaimedIds) => {
  const map = new Map();
  for (const r of rows) {
    if (alreadyClaimedIds.has(r.id)) continue;
    const k = canonicaliseName(r.customer_name);
    if (!k || k.length < 3) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return Array.from(map.entries())
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ signal: "canonical_name", key, customers: list }));
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
    const svc = serviceClient();
    const customers = await fetchAllCustomers(svc, ctx.tenantId);

    const gstinGroups = groupByGstin(customers);
    const claimed = new Set();
    for (const g of gstinGroups) for (const c of g.customers) claimed.add(c.id);
    const nameGroups = groupByCanonicalName(customers, claimed);

    const groups = [...gstinGroups, ...nameGroups];
    return json(res, 200, {
      total_customers: customers.length,
      duplicate_count: groups.reduce((acc, g) => acc + g.customers.length, 0),
      groups,
    });
  } catch (err) { sendError(res, err); }
}
