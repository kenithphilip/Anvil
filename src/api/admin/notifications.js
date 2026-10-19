// /api/admin/notifications
//
//   GET                       list the caller's unresolved notifications + an
//                             unread_count for the calling user.
//   POST { id, action }       action="mark_read":      add caller to read_by
//                             action="mark_all_read":  add caller to read_by on every unresolved row they see
//                             action="resolve":        resolved=true (admin only)
//
// Used by the shell bell + dropdown, for every role. A caller sees the rows
// addressed to them (recipient_user_id, migration 253), plus the broadcast
// rows (recipient_user_id null, from notifyAdmins) when the caller is admin or
// operator. Every read and every write below goes through that one rule, so
// nobody can read or mark another person's row. Read state is per-user (the
// `read_by` array on the row); resolution is global (every admin sees a
// broadcast row disappear once any of them clicks resolve or completes the
// underlying action).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { isMissingRecipientColumn } from "../_lib/notifications.js";

const ACTIONS = new Set(["mark_read", "mark_all_read", "resolve"]);

// The roles that see broadcast rows: the bell's audience before migration 253.
const BROADCAST_ROLES = new Set(["admin", "operator"]);

// Run the query from build() on only the rows the caller may see. Before
// migration 253 the column is missing and every row is a broadcast row, so a
// broadcast role gets the old query and any other role gets nothing. Nobody
// sees or marks another person's row on either path.
const visible = async (ctx, build) => {
  const me = ctx.user?.id;
  if (!me) return { data: [], error: null };
  const broadcast = BROADCAST_ROLES.has(ctx.role);
  const r = await (broadcast
    ? build().or(`recipient_user_id.eq.${me},recipient_user_id.is.null`)
    : build().eq("recipient_user_id", me));
  if (!isMissingRecipientColumn(r.error)) return r;
  console.warn("[admin/notifications] migration 253 is not applied: admin_notifications.recipient_user_id is missing");
  return broadcast ? build() : { data: [], error: null };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const userId = ctx.user?.id;

    if (req.method === "GET") {
      const { data, error } = await visible(ctx, () => svc.from("admin_notifications")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("resolved", false)
        .order("created_at", { ascending: false })
        .limit(50));
      if (error) throw new Error("notifications list: " + error.message);
      const unread_count = (data || []).filter((n) => !((n.read_by || []).includes(userId))).length;
      return json(res, 200, { notifications: data || [], unread_count });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!ACTIONS.has(body?.action)) {
        return json(res, 400, { error: { message: "action must be one of: " + [...ACTIONS].join(", ") } });
      }
      // Reading your own notices is open to every role; resolving stays admin.
      if (body.action === "resolve") requirePermission(ctx, "admin");

      if (body.action === "mark_all_read") {
        // Pull the unresolved rows the caller sees, then append the caller
        // to read_by where they are not in it yet.
        const { data: rows, error } = await visible(ctx, () => svc.from("admin_notifications")
          .select("id, read_by")
          .eq("tenant_id", ctx.tenantId)
          .eq("resolved", false));
        if (error) throw new Error("notifications list: " + error.message);
        for (const r of rows || []) {
          if ((r.read_by || []).includes(userId)) continue;
          await svc.from("admin_notifications")
            .update({ read_by: [...(r.read_by || []), userId] })
            .eq("id", r.id)
            .eq("tenant_id", ctx.tenantId);
        }
        return json(res, 200, { ok: true, marked: (rows || []).length });
      }

      if (!body.id) return json(res, 400, { error: { message: "id required" } });

      if (body.action === "resolve") {
        const { error } = await visible(ctx, () => svc.from("admin_notifications")
          .update({
            resolved: true,
            resolved_by: userId,
            resolved_at: new Date().toISOString(),
            resolution_note: body.note || null,
          })
          .eq("id", body.id)
          .eq("tenant_id", ctx.tenantId));
        if (error) throw new Error(error.message);
        return json(res, 200, { ok: true });
      }

      // mark_read on a single row. Another person's row reads as not found.
      const { data: rows, error } = await visible(ctx, () => svc.from("admin_notifications")
        .select("read_by")
        .eq("id", body.id)
        .eq("tenant_id", ctx.tenantId));
      if (error) throw new Error("notification read: " + error.message);
      const row = (rows || [])[0];
      if (!row) return json(res, 404, { error: { message: "notification not found" } });
      if (!(row.read_by || []).includes(userId)) {
        await svc.from("admin_notifications")
          .update({ read_by: [...(row.read_by || []), userId] })
          .eq("id", body.id)
          .eq("tenant_id", ctx.tenantId);
      }
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
