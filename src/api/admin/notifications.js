// /api/admin/notifications
//
//   GET                       list unresolved notifications for the
//                             calling tenant + an unread_count for the
//                             calling user.
//   POST { id, action }       action="mark_read":      add caller to read_by
//                             action="mark_all_read":  add caller to read_by for every unresolved row
//                             action="resolve":        resolved=true
//
// Used by the shell bell + dropdown. Read state is per-user (the
// `read_by` jsonb array on the row); resolution is global (every
// admin sees the same row disappear once any of them clicks resolve
// or completes the underlying action).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const ACTIONS = new Set(["mark_read", "mark_all_read", "resolve"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();

    if (req.method === "GET") {
      const { data, error } = await svc.from("admin_notifications")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("resolved", false)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error("notifications list: " + error.message);
      const userId = ctx.user?.id;
      const unread_count = (data || []).filter((n) => !((n.read_by || []).includes(userId))).length;
      return json(res, 200, { notifications: data || [], unread_count });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!ACTIONS.has(body?.action)) {
        return json(res, 400, { error: { message: "action must be one of: " + [...ACTIONS].join(", ") } });
      }
      const userId = ctx.user.id;

      if (body.action === "mark_all_read") {
        // Pull unresolved rows where the user isn't already in read_by,
        // then array_append the user_id and update.
        const { data: rows } = await svc.from("admin_notifications")
          .select("id, read_by")
          .eq("tenant_id", ctx.tenantId)
          .eq("resolved", false);
        for (const r of rows || []) {
          if ((r.read_by || []).includes(userId)) continue;
          await svc.from("admin_notifications")
            .update({ read_by: [...(r.read_by || []), userId] })
            .eq("id", r.id);
        }
        return json(res, 200, { ok: true, marked: (rows || []).length });
      }

      if (!body.id) return json(res, 400, { error: { message: "id required" } });

      if (body.action === "resolve") {
        const { error } = await svc.from("admin_notifications")
          .update({
            resolved: true,
            resolved_by: userId,
            resolved_at: new Date().toISOString(),
            resolution_note: body.note || null,
          })
          .eq("id", body.id)
          .eq("tenant_id", ctx.tenantId);
        if (error) throw new Error(error.message);
        return json(res, 200, { ok: true });
      }

      // mark_read on a single row.
      const { data: row } = await svc.from("admin_notifications")
        .select("read_by")
        .eq("id", body.id)
        .eq("tenant_id", ctx.tenantId)
        .maybeSingle();
      if (!row) return json(res, 404, { error: { message: "notification not found" } });
      if (!(row.read_by || []).includes(userId)) {
        await svc.from("admin_notifications")
          .update({ read_by: [...(row.read_by || []), userId] })
          .eq("id", body.id);
      }
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
