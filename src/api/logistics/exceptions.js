// /api/logistics/exceptions
//   GET                     : list logistics_exceptions (filter status, severity, kind)
//   POST <id>/ack           : acknowledge (captures first_response_at)
//   POST <id>/resolve       : mark resolved
//   POST <id>/suppress      : suppress (operator chose to ignore)
//
// The persistent, SLA-tracked output of the logistics monitor
// (src/api/_lib/logistics/monitor.js). Mirrors /api/inventory/exceptions.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const url = new URL(req.url, "http://_");
    // Under the Vercel rewrite, req.url is /api/dispatch?_p=logistics/exceptions/<id>/<action>,
    // so url.pathname is only "/api/dispatch". Resolve the route from the _p
    // splat (production) or the pathname (tests/local), and prefer the
    // router-injected req.query.id for the id. Anchor on the "exceptions"
    // segment so the id/action are found regardless of the /api prefix.
    const routePath = url.searchParams.get("_p") || url.pathname;
    const segs = routePath.split("/").filter(Boolean);
    const exIdx = segs.lastIndexOf("exceptions");
    const id = (req.query && req.query.id) || (exIdx >= 0 ? segs[exIdx + 1] : undefined);
    const action = exIdx >= 0 ? segs[exIdx + 2] : undefined;
    const svc = serviceClient();

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const status = url.searchParams.get("status") || "open";
      const severity = url.searchParams.get("severity");
      const kind = url.searchParams.get("kind");
      let q = svc.from("logistics_exceptions").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (status !== "all") q = q.eq("status", status);
      if (severity) q = q.eq("severity", severity);
      if (kind) q = q.eq("rule_kind", kind);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { exceptions: data || [] });
    }

    if (req.method === "POST" && id && action) {
      requirePermission(ctx, "write");
      const nowIso = new Date().toISOString();
      const transitions = {
        ack:      { status: "acknowledged", acknowledged_by: ctx.user?.id || null, acknowledged_at: nowIso },
        resolve:  { status: "resolved",     resolved_at: nowIso },
        suppress: { status: "suppressed" },
      };
      const patch = transitions[action];
      if (!patch) return json(res, 400, { error: { message: "Unknown action: " + action } });
      patch.updated_at = nowIso;

      // Capture first response the first time the row is acted on.
      const cur = await svc.from("logistics_exceptions")
        .select("first_response_at, detail, rule_kind, ref_label")
        .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "Exception not found" } });
      if (!cur.data.first_response_at) patch.first_response_at = nowIso;

      const body = action === "resolve" || action === "suppress" ? await readBody(req) : null;
      if (body?.note) patch.detail = { ...(cur.data.detail || {}), note: body.note };

      const upd = await svc.from("logistics_exceptions")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "logistics.exception." + action,
        objectType: "logistics_exception",
        objectId: id,
        after: { kind: upd.data?.rule_kind, status: upd.data?.status },
      });
      return json(res, 200, { exception: upd.data });
    }

    return json(res, 405, { error: { message: "Unsupported method or path" } });
  } catch (err) { sendError(res, err); }
}
