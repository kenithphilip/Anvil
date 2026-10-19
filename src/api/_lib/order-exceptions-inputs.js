// The inputs of one order's exceptions list, read in one place for both of
// its readers:
//   GET /api/orders/exceptions   the list the SO workspace shows
//   PATCH /api/orders/:id        the move gate (order-move-gate.js)
// One reader means the gate refuses on the rows the workspace shows. A new
// source of rows is read here, and both see it; nobody has to remember to
// add it to the gate as well.
//
// Every query names ctx.tenantId. The caller has already read the order,
// tenant-scoped.

import { readTermsSettings, readTermsView } from "./terms/check.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_COLUMNS = "id, status, confidence_overall, adapter_used, anomalies, validator_issues";

// The extraction run the order was read by. Advisory: a run that cannot be
// read (an older database without validator_issues, a run since deleted)
// leaves the extraction rows to what the order itself says.
const readRun = async (svc, tenantId, runId) => {
  if (!runId || !UUID_RE.test(String(runId))) return null;
  const r = await svc.from("extraction_runs").select(RUN_COLUMNS)
    .eq("tenant_id", tenantId).eq("id", runId).maybeSingle();
  return r.error ? null : r.data || null;
};

// The customer's master record and the vendor codes it uses for us, for the
// match basis. The vendor codes are advisory in the same way.
const readCustomer = async (svc, tenantId, customerId) => {
  if (!customerId) return { customer: null, vendorCodes: [] };
  const c = await svc.from("customers").select("id, customer_name, gstin, state_code")
    .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  if (c.error) throw new Error("customers read: " + c.error.message);
  const v = await svc.from("customer_vendor_codes").select("vendor_code")
    .eq("tenant_id", tenantId).eq("customer_id", customerId);
  return { customer: c.data || null, vendorCodes: v.error ? [] : (v.data || []).map((r) => r.vendor_code) };
};

// The terms view this caller may see, and the tenant's effective terms
// policy (a clause whose accept_requires names the manager action is
// reserved for a manager, owner decision 2). Before migration 250 there is
// no terms check, so no terms rows. Any other read error is thrown.
const readTerms = async (svc, ctx, orderId, includeShadow) => {
  try {
    const settings = await readTermsSettings(svc, ctx.tenantId);
    const out = await readTermsView(svc, ctx, orderId, { includeShadow, settings });
    return { view: out.status === "ok" ? out.view : null, policy: settings.policy || null };
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return { view: null, policy: null };
    throw err;
  }
};

// The argument buildOrderExceptions takes, for `order`. includeShadow is for
// an admin reading the list; the gate never asks for shadow rows (they never
// block).
export const readExceptionInputs = async (svc, ctx, order, { includeShadow = false } = {}) => {
  const [{ customer, vendorCodes }, extractionRun, terms] = await Promise.all([
    readCustomer(svc, ctx.tenantId, order.customer_id),
    readRun(svc, ctx.tenantId, order.preflight_payload?.extraction_run_id),
    readTerms(svc, ctx, order.id, includeShadow),
  ]);
  return { order, customer, vendorCodes, extractionRun, terms: terms.view, termsPolicy: terms.policy };
};
