// /api/cron/drift-meter
//
// Bet 5: drains tally_drift_billing_meter rows that haven't been
// reported to either Stripe or Razorpay yet, calls the metered-
// billing API on the right provider, and stamps reported_at on
// success.
//
// Cadence: every 60 min via /api/cron/tick. Idempotent: a meter
// row is only ever drained once per provider (uniqueness enforced
// by the partial index in migration 097).
//
// Authentication: standard CRON_SECRET pattern; admin users can
// trigger manually for debugging.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordStripeMeterEvent } from "../_lib/stripe-client.js";
import { recordRazorpayUsage, razorpayDecryptCreds } from "../_lib/razorpay-client.js";

const CRON_SECRET = process.env.CRON_SECRET;
const DRAIN_BATCH = 200;

// Stripe meter primitive: one event per voucher reconciled.
const STRIPE_METER_NAME = process.env.STRIPE_DRIFT_METER_NAME
  || "tally_drift_so_overage";

const drainOnce = async (svc) => {
  // Pull the oldest unreported rows. Partial index makes this fast.
  const meterResp = await svc.from("tally_drift_billing_meter")
    .select("*")
    .is("reported_to_stripe_at", null)
    .is("reported_to_razorpay_at", null)
    .order("created_at", { ascending: true })
    .limit(DRAIN_BATCH);
  if (meterResp.error) throw new Error(meterResp.error.message);
  const rows = meterResp.data || [];
  if (rows.length === 0) return { drained: 0, by_provider: {} };

  // Group by tenant so we can settle the per-tenant subscription
  // provider in one call where possible.
  const byTenant = new Map();
  for (const r of rows) {
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r);
  }

  const tenantIds = Array.from(byTenant.keys());
  // Pull the full settings row so razorpayDecryptCreds works.
  const settingsResp = await svc.from("tenant_settings")
    .select("*")
    .in("tenant_id", tenantIds);
  const settingsByTenant = new Map();
  for (const s of (settingsResp.data || [])) settingsByTenant.set(s.tenant_id, s);

  const counts = { stripe: 0, razorpay: 0, skipped: 0, errors: 0 };
  const errors = [];

  for (const [tenantId, tenantRows] of byTenant.entries()) {
    const s = settingsByTenant.get(tenantId) || {};
    const stripeSub = s.tally_drift_addon_stripe_subscription_id || s.stripe_account_id || null;
    const razorpaySub = s.tally_drift_addon_razorpay_subscription_id || s.razorpay_subscription_id || null;

    for (const row of tenantRows) {
      // Stripe path takes precedence for tenants with a stripe sub.
      // Tenants on the Growth-tier free trial (`tally_drift_addon_billing_plan='trial'`)
      // and Enterprise (bundled) skip metered billing entirely; we
      // still stamp the report timestamp so the partial index drops
      // them out of the unreported set.
      const plan = s.tally_drift_addon_billing_plan;
      if (plan === "enterprise" || plan === "trial") {
        const upd = await svc.from("tally_drift_billing_meter")
          .update({
            reported_to_stripe_at: stripeSub ? new Date().toISOString() : row.reported_to_stripe_at,
            reported_to_razorpay_at: razorpaySub ? new Date().toISOString() : row.reported_to_razorpay_at,
          })
          .eq("id", row.id);
        if (upd.error) {
          errors.push({ tenant_id: tenantId, row_id: row.id, error: upd.error.message });
          counts.errors++;
        } else {
          counts.skipped++;
        }
        continue;
      }

      // Stripe meter event.
      if (stripeSub && row.vouchers_reconciled > 0) {
        try {
          const event = await recordStripeMeterEvent({
            meter: STRIPE_METER_NAME,
            stripeCustomerId: stripeSub,
            value: row.vouchers_reconciled,
            identifier: "drift_meter_" + row.id,
          });
          await svc.from("tally_drift_billing_meter")
            .update({
              reported_to_stripe_at: new Date().toISOString(),
              stripe_meter_event_id: event?.identifier || null,
            })
            .eq("id", row.id);
          counts.stripe++;
        } catch (err) {
          errors.push({ tenant_id: tenantId, row_id: row.id, provider: "stripe", error: err?.message || String(err) });
          counts.errors++;
        }
        continue;
      }

      // Razorpay usage billing.
      if (razorpaySub && row.vouchers_reconciled > 0) {
        try {
          // Decrypt the per-tenant razorpay credentials and merge
          // into the settings shape razorpayFetch expects.
          const decrypted = razorpayDecryptCreds(s);
          const settingsForRz = { ...s, ...decrypted };
          const result = await recordRazorpayUsage(settingsForRz, {
            subscriptionId: razorpaySub,
            quantity: row.vouchers_reconciled,
            identifier: "drift_meter_" + row.id,
          });
          await svc.from("tally_drift_billing_meter")
            .update({
              reported_to_razorpay_at: new Date().toISOString(),
              razorpay_addon_id: result?.addon_id || null,
            })
            .eq("id", row.id);
          counts.razorpay++;
        } catch (err) {
          errors.push({ tenant_id: tenantId, row_id: row.id, provider: "razorpay", error: err?.message || String(err) });
          counts.errors++;
        }
        continue;
      }

      // No provider configured: log + skip. The row will sit
      // unreported until the operator wires Stripe / Razorpay.
      counts.skipped++;
    }
  }

  return { drained: rows.length, by_provider: counts, errors };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (!isCron) {
      const ctx = await resolveContext(req);
      requirePermission(ctx, "admin");
    }
    const out = await drainOnce(svc);
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
