// Cached Stripe client. The Stripe SDK is heavy enough that we want to
// instantiate it once per cold start rather than per request. Reads
// STRIPE_SECRET_KEY at first use; throws a clear error if it is unset.
//
// Also exports tenantSettings(svc, tenantId) which upserts the row if
// missing, so every Stripe-touching endpoint has a stable place to
// read/write per-tenant Connect state.

import Stripe from "stripe";

let _stripe = null;

export const stripeClient = () => {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  _stripe = new Stripe(key, { apiVersion: "2024-12-18.acacia" });
  return _stripe;
};

export const stripeIsConfigured = () => !!process.env.STRIPE_SECRET_KEY;

export const tenantSettings = async (svc, tenantId) => {
  const existing = await svc
    .from("tenant_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (existing.error && existing.error.code !== "PGRST116") {
    throw new Error("tenant_settings read: " + existing.error.message);
  }
  if (existing.data) return existing.data;
  const created = await svc
    .from("tenant_settings")
    .insert({ tenant_id: tenantId })
    .select("*")
    .single();
  if (created.error) {
    // Race with a concurrent caller; retry the read.
    const retry = await svc.from("tenant_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
    if (retry.data) return retry.data;
    throw new Error("tenant_settings init: " + created.error.message);
  }
  return created.data;
};

export const updateTenantSettings = async (svc, tenantId, patch) => {
  const upd = await svc
    .from("tenant_settings")
    .update(patch)
    .eq("tenant_id", tenantId)
    .select("*")
    .maybeSingle();
  if (upd.error) throw new Error("tenant_settings update: " + upd.error.message);
  return upd.data;
};
