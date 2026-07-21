// GenAI copilot P0a — the Metric Catalog HTTP surface.
//
//   GET  /api/metrics                         -> { metrics: [{id,label,unit,domain,...}] }
//   POST /api/metrics { metric_id, window_days? } -> the governed answer contract
//                        { metric_id, value, unit, provenance, as_of, breakdown? }
//
// A thin, read-permission wrapper over _lib/metrics/catalog.js so a future
// "Ask Anvil" UI (and direct callers) can list + compute governed metrics.
// The same catalog also powers the query_metric copilot tool, so chat / MCP /
// this endpoint all return the SAME trusted number.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { listMetrics, computeMetric } from "../_lib/metrics/catalog.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");

    if (req.method === "GET") {
      return json(res, 200, { metrics: listMetrics() });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const metricId = body?.metric_id ? String(body.metric_id).trim() : "";
      if (!metricId) return json(res, 400, { error: { message: "metric_id required", available: listMetrics().map((m) => m.id) } });
      const svc = serviceClient();
      let answer;
      try {
        answer = await computeMetric(svc, ctx.tenantId, metricId, { window_days: body?.window_days });
      } catch (e) {
        const status = e?.status === 404 ? 404 : 500;
        return json(res, status, { error: { message: e?.message || "metric error", available: e?.available } });
      }
      await recordAudit(ctx, {
        action: "metric_query",
        objectType: "metric",
        objectId: metricId,
        detail: metricId + "=" + answer.value + (answer.window_days ? " (" + answer.window_days + "d)" : ""),
      });
      return json(res, 200, answer);
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
