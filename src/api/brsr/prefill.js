// GET /api/brsr/prefill?from_fy=FY2024-25
//
// Returns the prior-period disclosure values for the operator so
// the supplier-side form can "Copy from FY 2024-25". SMEs hate
// re-entering invariant data (factory address, attestation signer,
// pollution-consent status), so prefill is the make-or-break UX
// step for adoption.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://_");
    const fromFy = url.searchParams.get("from_fy");
    if (!fromFy) {
      return json(res, 400, { error: { message: "from_fy required" } });
    }
    const svc = serviceClient();
    // Find the period matching from_fy, then the disclosure for it.
    const period = await svc.from("supplier_disclosure_periods").select("id")
      .eq("tenant_id", ctx.tenantId).eq("fiscal_year", fromFy)
      .order("period_start", { ascending: false })
      .limit(1).maybeSingle();
    if (period.error) throw new Error(period.error.message);
    if (!period.data) {
      return json(res, 200, { disclosure: null, source_period_id: null });
    }
    const disc = await svc.from("supplier_disclosures").select("*")
      .eq("tenant_id", ctx.tenantId).eq("period_id", period.data.id).maybeSingle();
    if (disc.error) throw new Error(disc.error.message);
    // Strip identity / timestamp fields so the caller can paste
    // the body directly into a new POST /api/brsr/disclosure.
    const out = { ...(disc.data || {}) };
    delete out.id;
    delete out.tenant_id;
    delete out.period_id;
    delete out.created_at;
    delete out.updated_at;
    // Reset scope numbers; the new period must recompute from its
    // own volumes (which may differ).
    delete out.scope1_tco2e;
    delete out.scope2_tco2e;
    return json(res, 200, {
      disclosure: disc.data ? out : null,
      source_period_id: period.data.id,
      source_fy: fromFy,
    });
  } catch (err) { sendError(res, err); }
}
