// POST /api/billing/stripe/connect_onboard
// Body: { return_url? }
//
// Creates a Stripe Connect Express account for the tenant if one
// doesn't exist, then returns a fresh AccountLink onboarding URL the
// admin redirects to. Idempotent: re-onboarding the same tenant
// reuses the existing account_id.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { stripeClient, stripeIsConfigured, tenantSettings, updateTenantSettings } from "../../_lib/stripe-client.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    if (!stripeIsConfigured()) {
      return json(res, 503, { error: { code: "STRIPE_NOT_CONFIGURED", message: "STRIPE_SECRET_KEY is not set on the platform." } });
    }
    const body = await readBody(req);
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);
    const stripe = stripeClient();

    let accountId = settings.stripe_account_id;
    if (!accountId) {
      const acct = await stripe.accounts.create({
        type: "express",
        metadata: { anvil_tenant_id: ctx.tenantId },
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
      });
      accountId = acct.id;
      await updateTenantSettings(svc, ctx.tenantId, { stripe_account_id: accountId });
      await recordAudit(ctx, {
        action: "stripe_account_created",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: accountId,
      });
    }

    const baseUrl = process.env.PUBLIC_APP_URL || (req.headers.origin || "");
    const returnUrl = body?.return_url || (baseUrl ? baseUrl + "/#/admin?tab=billing" : null);
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: returnUrl || "https://example.com/refresh",
      return_url:  returnUrl || "https://example.com/return",
      type: "account_onboarding",
    });

    return json(res, 200, {
      account_id: accountId,
      onboarding_url: link.url,
      expires_at: link.expires_at ? new Date(link.expires_at * 1000).toISOString() : null,
    });
  } catch (err) {
    sendError(res, err);
  }
}
