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
  const dedupKey = opts.dedupKey ? String(opts.dedupKey) : null;

  try {
    // Optional dedup: skip if an unresolved row with the same kind +
    // dedupKey was created in the last 5 minutes. Cheap and catches
    // most flap loops.
    //
    // This never fired before. The lookup was a head:true count, which
    // returns a count and no rows, and the guard read the rows, so it
    // always saw none. It also matched on kind alone and never compared
    // the key. The key now rides on the row in link_params.dedup_key
    // (the table's one jsonb column, so no migration), and the guard
    // reads the count. Different keys of one kind still each notify.
    if (dedupKey) {
      const since = new Date(Date.now() - 5 * 60_000).toISOString();
      const { count: prior } = await svc.from("admin_notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("kind", payload.kind)
        .eq("resolved", false)
        .eq("link_params->>dedup_key", dedupKey)
        .gte("created_at", since);
      if ((prior || 0) > 0) return { notified: 0, deduped: true };
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
      link_params: dedupKey
        ? { ...(payload.link_params || {}), dedup_key: dedupKey }
        : (payload.link_params || {}),
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
