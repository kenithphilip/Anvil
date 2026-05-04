// GET /api/billing/stripe/connect_status
//
// Returns the connected-account state: account_id (if any),
// charges_enabled, payouts_enabled, requirements summary. The admin
// UI pulls this on mount to decide whether to show "Connect" or
// "Open dashboard".

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { stripeClient, stripeIsConfigured, tenantSettings, updateTenantSettings } from "../../_lib/stripe-client.js";

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
    if (!stripeIsConfigured()) {
      return json(res, 200, { configured: false, account_id: null, charges_enabled: false, payouts_enabled: false });
    }
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    if (!settings.stripe_account_id) {
      return json(res, 200, {
        configured: true,
        account_id: null,
        charges_enabled: false,
        payouts_enabled: false,
      });
    }
    const stripe = stripeClient();
    const acct = await stripe.accounts.retrieve(settings.stripe_account_id);
    // Mirror the live state into tenant_settings so other callers
    // don't have to round-trip Stripe.
    if (
      acct.charges_enabled !== settings.stripe_charges_enabled ||
      acct.payouts_enabled !== settings.stripe_payouts_enabled
    ) {
      await updateTenantSettings(svc, ctx.tenantId, {
        stripe_charges_enabled: !!acct.charges_enabled,
        stripe_payouts_enabled: !!acct.payouts_enabled,
        stripe_onboarded_at: acct.charges_enabled && !settings.stripe_onboarded_at
          ? new Date().toISOString()
          : settings.stripe_onboarded_at,
      });
    }
    return json(res, 200, {
      configured: true,
      account_id: acct.id,
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
      details_submitted: !!acct.details_submitted,
      requirements_currently_due: acct.requirements?.currently_due || [],
      requirements_past_due:      acct.requirements?.past_due || [],
      country: acct.country || null,
      default_currency: acct.default_currency || "usd",
    });
  } catch (err) {
    sendError(res, err);
  }
}
