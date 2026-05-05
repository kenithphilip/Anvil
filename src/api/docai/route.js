// /api/docai/route
//
// Per-customer model router. Decides between the prompt-overrides
// path (small N corrections) and a fine-tuned per-customer model
// endpoint (large N corrections). The fine-tuning worker runs
// out-of-process (Modal / EC2) and registers the model URL on the
// `customers.docai_fine_tune_url` column when it has enough data.
//
//   GET  ?customer_id=...   returns the chosen route + reason.
//   POST body: {              // run an extraction through the chosen route
//     customer_id, document_id,
//     payload: { ... }        // pass-through to the underlying call
//   }
//
// Phase 6 (C.4) routing only — the heavy fine-tuning lives in a
// separate worker not packaged with this repo.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";

// Decide which model surface to use. Returns { route, reason,
// fine_tune_url? }.
const decideRoute = async (svc, tenantId, customerId, settings) => {
  if (!customerId) return { route: "default_prompt", reason: "no_customer_id" };

  const cust = await svc.from("customers").select("id, docai_fine_tune_url, docai_correction_count")
    .eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  if (cust.error || !cust.data) return { route: "default_prompt", reason: "customer_not_found" };

  const threshold = Number(settings?.docai_fine_tune_threshold ?? 200);
  const corrections = Number(cust.data.docai_correction_count ?? 0);
  const fineUrl = cust.data.docai_fine_tune_url;

  if (fineUrl && corrections >= threshold) {
    return { route: "fine_tuned", reason: "above_threshold", fine_tune_url: fineUrl, corrections };
  }
  if (corrections > 0) {
    return { route: "prompt_overrides", reason: "below_threshold", corrections, threshold };
  }
  return { route: "default_prompt", reason: "no_corrections" };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settings = await tenantSettings(svc, ctx.tenantId);

    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://x");
      const customerId = url.searchParams.get("customer_id");
      const decision = await decideRoute(svc, ctx.tenantId, customerId, settings);
      return json(res, 200, decision);
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body?.customer_id) return json(res, 400, { error: { message: "customer_id required" } });
      const decision = await decideRoute(svc, ctx.tenantId, body.customer_id, settings);
      await recordAudit(ctx, {
        action: "docai_route_decision",
        objectType: "customer",
        objectId: body.customer_id,
        detail: decision.route + "::" + decision.reason,
      });
      // We don't perform the actual call here — that stays inside the
      // existing /api/docai/extract handler. We surface the routing
      // decision so the caller can pass `route` + `fine_tune_url`
      // into the extract call.
      return json(res, 200, { ok: true, decision, hint: "Pass `route` + `fine_tune_url` (if present) into /api/docai/extract." });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
