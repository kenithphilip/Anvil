// POST /api/supplier_rfq/sync_composition
// Body: { quote_id }
//
// Re-derives a quote's price composition from the awarded winners of every
// RFQ linked to it (source_quote_id). Idempotent; safe to run repeatedly.
// Drives the "Sync awarded vendors" button on the Composition screen, and
// repairs RFQs awarded before the on-award feed existed.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { syncQuoteCompositionFromAwards } from "../_lib/rfq-composition.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body?.quote_id) return json(res, 400, { error: { message: "quote_id required" } });
    const svc = serviceClient();
    const result = await syncQuoteCompositionFromAwards(svc, ctx, body.quote_id);
    await recordAudit(ctx, {
      action: "rfq_composition_synced",
      objectType: "quote",
      objectId: body.quote_id,
      detail: `${result.fed}/${result.eligible} lines from ${result.rfqs} rfq(s)`,
    });
    return json(res, 200, result);
  } catch (err) { sendError(res, err); }
}
