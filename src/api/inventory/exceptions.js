// /api/inventory/exceptions
// GET                    : list exceptions (filter by status, severity)
// POST <id>/ack          : acknowledge
// POST <id>/resolve      : mark resolved
// POST <id>/suppress     : suppress (operator chose to ignore)

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
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments[3];
    const action = segments[4];
    const svc = serviceClient();

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const status = url.searchParams.get("status") || "open";
      const severity = url.searchParams.get("severity");
      let q = svc.from("inventory_exceptions").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (status !== "all") q = q.eq("status", status);
      if (severity) q = q.eq("severity", severity);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { exceptions: data || [] });
    }

    if (req.method === "POST" && id && action) {
      requirePermission(ctx, "write");
      const transitions = {
        ack:      { status: "acknowledged", acknowledged_by: ctx.user?.id || null, acknowledged_at: new Date().toISOString() },
        resolve:  { status: "resolved",     resolved_at: new Date().toISOString() },
        suppress: { status: "suppressed" },
      };
      const patch = transitions[action];
      if (!patch) return json(res, 400, { error: { message: "Unknown action: " + action } });
      const body = action === "resolve" || action === "suppress" ? await readBody(req) : null;
      if (body?.note) patch.detail = { note: body.note };
      const upd = await svc.from("inventory_exceptions")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "inventory.exception." + action,
        objectType: "inventory_exception",
        objectId: id,
        detail: { kind: upd.data?.exception_kind, part_no: upd.data?.part_no },
      });
      return json(res, 200, { exception: upd.data });
    }

    return json(res, 405, { error: { message: "Unsupported method or path" } });
  } catch (err) { sendError(res, err); }
}
