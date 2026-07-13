// ICP compute layer: resolve a customer's attribute map (generic registration
// fields + core columns + hierarchy), score it against the tenant's active
// rubric (or the built-in default), and persist onto customers.icp_*.
// The scoring itself is pure (src/api/_lib/icp.js); this is the I/O side.

import { scoreCustomer, DEFAULT_ICP_PROFILE } from "./icp.js";

// The tenant's most-recent active ICP profile, or null (caller uses the default).
export const getActiveProfile = async (svc, tenantId) => {
  const r = await svc.from("icp_profiles").select("*")
    .eq("tenant_id", tenantId).eq("active", true)
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!r.error && r.data) return r.data;
  return null;
};

// Build the generic attribute map. Registration fields win (they are the
// authored source); core customer columns backfill keys the fields don't carry.
export const resolveCustomerAttributes = async (svc, tenantId, customerId) => {
  const cust = await svc.from("customers").select("*")
    .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  if (cust.error) throw new Error(cust.error.message);
  if (!cust.data) return null;

  const fields = await svc.from("customer_registration_fields")
    .select("field_key, value").eq("tenant_id", tenantId).eq("customer_id", customerId);
  const attrs = {};
  for (const row of (fields.data || [])) {
    if (row.value != null && String(row.value).trim() !== "") attrs[row.field_key] = row.value;
  }
  const c = cust.data;
  const fill = (k, v) => { if (attrs[k] == null && v != null && String(v).trim() !== "") attrs[k] = v; };
  fill("gstin", c.gstin);
  fill("state_code", c.state_code);
  fill("country", c.country);          // present only if the column exists
  fill("customer_type", c.customer_type);
  // Hierarchy: parent affiliation is a strong ICP signal (best-effort in P1 --
  // only if the column exists on the customer row).
  if (c.parent_customer_id != null) attrs.parent_customer_id = c.parent_customer_id;

  return { attrs, customer: c };
};

// Resolve -> score -> persist. Returns { score, tier, signals, profile_id,
// profile_name } or null when the customer doesn't exist. Never throws on the
// persist path caller-side beyond a genuine DB error.
export const computeAndPersistIcp = async (svc, tenantId, customerId) => {
  const resolved = await resolveCustomerAttributes(svc, tenantId, customerId);
  if (!resolved) return null;
  const profile = (await getActiveProfile(svc, tenantId)) || DEFAULT_ICP_PROFILE;
  const result = scoreCustomer(resolved.attrs, profile);
  const upd = await svc.from("customers").update({
    icp_score: result.score,
    icp_tier: result.tier,
    icp_profile_id: profile.id || null,
    icp_signals: result.signals,
    icp_scored_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId).eq("id", customerId);
  if (upd.error) throw new Error(upd.error.message);
  return { ...result, profile_id: profile.id || null, profile_name: profile.name || "Default ICP" };
};
