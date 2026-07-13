// ICP compute layer: resolve a customer's attribute map (generic registration
// fields + core columns + hierarchy), score it against the tenant's active
// rubric (or the built-in default), and persist onto customers.icp_*.
// The scoring itself is pure (src/api/_lib/icp.js); this is the I/O side.

import { scoreCustomer, DEFAULT_ICP_PROFILE } from "./icp.js";
import { isValidGstin } from "./gstin.js";

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

  // Derived attributes (P3). A checksum-valid GSTIN is a local proxy for "this
  // is a real, registered business" -- available with NO external call, so a
  // rubric can gate/score on it today. When the Sandbox GSTIN fetch (#186)
  // lands, it writes gst_status=Active/Cancelled into the registration fields;
  // that already flows through as an attribute and re-scores on save, so no
  // extra wiring here is needed for the live-registry gate.
  if (attrs.gstin != null && String(attrs.gstin).trim() !== "") {
    attrs.gstin_present = "yes";
    attrs.gstin_valid = isValidGstin(String(attrs.gstin)) ? "valid" : "invalid";
  } else {
    attrs.gstin_present = "no";
  }

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

// Batch re-score (P3). Editing the rubric, or a wave of GSTIN/registration data
// landing, should re-score the whole book. Resolves the active profile once,
// then scores each customer against it. Bounded by `limit` (default 1000) so a
// single call can't run unbounded; returns { scored, tiers } for the caller to
// report. Best-effort per row: a single bad row is counted in `errors`, not
// fatal.
export const scoreAllCustomers = async (svc, tenantId, { limit = 1000 } = {}) => {
  const list = await svc.from("customers").select("id")
    .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(limit);
  if (list.error) throw new Error(list.error.message);
  const ids = (list.data || []).map((r) => r.id);
  const tiers = {};
  let scored = 0;
  let errors = 0;
  for (const id of ids) {
    try {
      const r = await computeAndPersistIcp(svc, tenantId, id);
      if (r) { scored += 1; tiers[r.tier] = (tiers[r.tier] || 0) + 1; }
    } catch {
      errors += 1;
    }
  }
  return { scored, errors, tiers, total: ids.length };
};
