// /api/orders/print_jobs
// GET                                          list queued + recent jobs
// PATCH /api/orders/print_jobs?id=...           { status, error? } -> updates one row
//                                               (used by the on-prem CUPS/IPP relay)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const RELAY_SECRET = process.env.PRINT_RELAY_SECRET;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const id = url.searchParams.get("id");

    // Relay path: bearer auth via PRINT_RELAY_SECRET. Lets the
    // on-prem agent pull queued jobs and report status.
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isRelay = !!RELAY_SECRET && auth === RELAY_SECRET;

    if (req.method === "GET" && isRelay) {
      const tenantId = url.searchParams.get("tenant_id");
      let q = svc.from("print_jobs").select("*").eq("status", "queued")
        .order("created_at", { ascending: true }).limit(20);
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      // Mark them printing so the relay doesn't re-claim while
      // it's working.
      const ids = (r.data || []).map((row) => row.id);
      if (ids.length) {
        await svc.from("print_jobs").update({
          status: "printing",
          last_attempt_at: new Date().toISOString(),
          attempt_count: undefined,
        }).in("id", ids);
      }
      return json(res, 200, { jobs: r.data || [] });
    }

    if (req.method === "PATCH" && id && isRelay) {
      const body = await readBody(req);
      if (!body?.status) return json(res, 400, { error: { message: "status required" } });
      if (!["printed", "failed", "queued"].includes(body.status)) {
        return json(res, 400, { error: { message: "invalid status" } });
      }
      await svc.from("print_jobs").update({
        status: body.status,
        error: body.error || null,
        last_attempt_at: new Date().toISOString(),
      }).eq("id", id);
      return json(res, 200, { ok: true });
    }

    // Admin path: list / cancel.
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method === "GET") {
      const status = url.searchParams.get("status");
      let q = svc.from("print_jobs").select("*").eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false }).limit(100);
      if (status) q = q.eq("status", status);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { jobs: r.data || [] });
    }
    if (req.method === "PATCH" && id) {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (body?.cancel) {
        await svc.from("print_jobs").update({ status: "cancelled" })
          .eq("tenant_id", ctx.tenantId).eq("id", id);
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: { message: "only cancel supported" } });
    }
    res.setHeader("Allow", "GET, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
