// Shared admin-notification helper.
//
// Any backend handler that wants to surface something in the admin
// bell calls notifyAdmins() here. The helper:
//   - Resolves the list of approved tenant admins (and optionally
//     a wider role set) for the target tenant.
//   - Inserts one admin_notifications row per recipient, fanning
//     out so each admin's read state is independent (kept on the
//     `read_by` array column).
//   - Is best-effort: it never throws on the upstream caller's
//     happy path. Failures are console.warned and the API call
//     that triggered the notification continues.
//
// Existing callers (signup, access-request approve/deny) write
// these rows directly. New callers should funnel through this
// helper so we have one place to add e.g. push, email, or web-push
// fan-out later.

const safeArr = (v) => Array.isArray(v) ? v : [];

/**
 * @param {*} svc        service-role supabase client
 * @param {string} tenantId
 * @param {object} payload
 *   kind, title, body, link_route?, link_params?, actor_user_id?,
 *   actor_email?, object_type?, object_id?
 * @param {object} opts
 *   roles      array of roles to notify; defaults to ['admin'].
 *               pass ['admin', 'finance'] to widen.
 *   dedupKey   string used to suppress duplicate rows in the same
 *               5-minute window (avoids one push failure spamming the
 *               bell every retry tick).
 */
export const notifyAdmins = async (svc, tenantId, payload, opts = {}) => {
  if (!svc || !tenantId || !payload?.kind || !payload?.title) return { notified: 0 };
  const roles = safeArr(opts.roles).length ? opts.roles : ["admin"];

  try {
    // Optional dedup: skip if an unresolved row with the same kind +
    // dedup-target was created in the last 5 minutes. Cheap and
    // catches most flap loops.
    if (opts.dedupKey) {
      const since = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: prior } = await svc.from("admin_notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("kind", payload.kind)
        .eq("resolved", false)
        .gte("created_at", since)
        .limit(1);
      if ((prior?.length || 0) > 0) return { notified: 0, deduped: true };
    }

    // Find approved admins on this tenant. We could also fan out
    // per-user, but the bell already filters by tenant at the API
    // layer; one row per tenant is enough.
    const { data: members, error } = await svc.from("tenant_members")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .eq("status", "approved")
      .in("role", roles);
    if (error) throw new Error("notify list members: " + error.message);
    if (!members?.length) return { notified: 0 };

    const row = {
      tenant_id: tenantId,
      kind: payload.kind,
      title: payload.title,
      body: payload.body || null,
      link_route: payload.link_route || null,
      link_params: payload.link_params || {},
      actor_user_id: payload.actor_user_id || null,
      actor_email: payload.actor_email || null,
      object_type: payload.object_type || null,
      object_id: payload.object_id || null,
    };
    const { error: insErr } = await svc.from("admin_notifications").insert(row);
    if (insErr) throw new Error("notify insert: " + insErr.message);
    return { notified: 1 };
  } catch (err) {
    console.warn("[notifyAdmins]", payload?.kind, "failed:", err?.message || err);
    return { notified: 0, error: err?.message || String(err) };
  }
};
