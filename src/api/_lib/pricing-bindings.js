// Resolve the pricing-profile binding for a composition context
// (P3 account/supplier-aware pricing).
//
// Precedence: a customer binding wins over a supplier binding; when
// neither exists the caller falls back to the explicit / tenant-default
// profile as before. Returns { profile_code, margin_floor_pct } or null.
//
// Pure I/O helper — the caller supplies the supabase service client.

export const resolvePricingBinding = async (svc, tenantId, { customerId = null, supplierId = null } = {}) => {
  if (!svc || !tenantId) return null;
  const tryScope = async (scopeType, scopeId) => {
    if (!scopeId) return null;
    const r = await svc.from("pricing_profile_bindings")
      .select("profile_code, margin_floor_pct")
      .eq("tenant_id", tenantId)
      .eq("scope_type", scopeType)
      .eq("scope_id", scopeId)
      .eq("is_active", true)
      .maybeSingle();
    if (!r || r.error || !r.data) return null;
    // A binding with neither a profile nor a floor override is inert.
    if (r.data.profile_code == null && r.data.margin_floor_pct == null) return null;
    return r.data;
  };
  return (await tryScope("customer", customerId)) || (await tryScope("supplier", supplierId)) || null;
};
