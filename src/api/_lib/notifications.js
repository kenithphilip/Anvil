// Shared notification helpers for the bell (admin_notifications).
//
// Two writers:
//   - notify(svc, tenantId, payload, { users, roles }) writes ONE row per
//     recipient, with recipient_user_id set (migration 253). Roles expand to
//     the approved members of this tenant at the moment of the call. Only the
//     recipient sees the row and only the recipient can mark it read.
//   - notifyAdmins(svc, tenantId, payload, { roles }) writes ONE broadcast row
//     (recipient_user_id null). Its roles only decide whether to insert (at
//     least one approved member must hold one); they do not travel with the
//     row. The bell shows a broadcast row to admin and operator. Read state is
//     per user on the `read_by` array.
//
// Both are best-effort: they never throw on the upstream caller's happy path.
// Failures are console.warned and the API call that triggered the notice
// continues.
//
// Existing callers (signup, access-request approve/deny) write rows directly.
// New callers should funnel through these helpers so we have one place to add
// e.g. push, email, or web-push fan-out later.

const safeArr = (v) => Array.isArray(v) ? v : [];

// True only when the error says admin_notifications.recipient_user_id is
// missing, i.e. migration 253 is not applied. A filter on the absent column
// returns 42703; an insert returns PGRST204 ("Could not find the
// 'recipient_user_id' column ... in the schema cache").
export const isMissingRecipientColumn = (err) => {
  if (!err) return false;
  const msg = String(err.message || "");
  if (!/recipient_user_id/.test(msg)) return false;
  return err.code === "42703" || err.code === "PGRST204" || /does not exist|schema cache/i.test(msg);
};

// Optional dedup: an unresolved row with the same kind + dedupKey created in
// the last 5 minutes. Cheap and catches most flap loops.
//
// This never fired before. The lookup was a head:true count, which returns a
// count and no rows, and the guard read the rows, so it always saw none. It
// also matched on kind alone and never compared the key. The key now rides on
// the row in link_params.dedup_key (the table's one jsonb column, so no
// migration), and the guard reads the count. Different keys of one kind still
// each notify.
const isDuplicate = async (svc, tenantId, kind, dedupKey) => {
  if (!dedupKey) return false;
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { count: prior } = await svc.from("admin_notifications")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("kind", kind)
    .eq("resolved", false)
    .eq("link_params->>dedup_key", dedupKey)
    .gte("created_at", since);
  return (prior || 0) > 0;
};

const buildRow = (tenantId, payload, dedupKey) => ({
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
});

/**
 * One row per recipient.
 *
 * @param {*} svc        service-role supabase client
 * @param {string} tenantId
 * @param {object} payload  same shape as notifyAdmins
 * @param {object} opts
 *   users      array of user ids
 *   roles      array of roles; each expands to its approved members
 *   dedupKey   as notifyAdmins; suppresses the whole fan-out
 * A user id that is not an approved member of THIS tenant gets no row.
 * Returns { notified: <rows written> }.
 */
export const notify = async (svc, tenantId, payload, opts = {}) => {
  if (!svc || !tenantId || !payload?.kind || !payload?.title) return { notified: 0 };
  const users = new Set(safeArr(opts.users).filter(Boolean));
  const roles = new Set(safeArr(opts.roles).filter(Boolean));
  if (!users.size && !roles.size) return { notified: 0 };
  const dedupKey = opts.dedupKey ? String(opts.dedupKey) : null;

  try {
    if (await isDuplicate(svc, tenantId, payload.kind, dedupKey)) return { notified: 0, deduped: true };

    // shortcut: reads every approved member of the tenant and filters here, fine for tens of members; filter in the query once a tenant has thousands.
    const { data: members, error } = await svc.from("tenant_members")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .eq("status", "approved");
    if (error) throw new Error("notify list members: " + error.message);
    const recipients = [...new Set(safeArr(members)
      .filter((m) => m?.user_id && (users.has(m.user_id) || roles.has(m.role)))
      .map((m) => m.user_id))];
    if (!recipients.length) return { notified: 0 };

    const base = buildRow(tenantId, payload, dedupKey);
    const rows = recipients.map((recipient_user_id) => ({ ...base, recipient_user_id }));
    const { error: insErr } = await svc.from("admin_notifications").insert(rows);
    // The column decides who sees the row. Without it a row would be a
    // broadcast row, so skip the notice; never retry without the column.
    if (insErr && isMissingRecipientColumn(insErr)) {
      console.warn("[notify]", payload.kind, "skipped: migration 253 (admin_notifications.recipient_user_id) is not applied");
      return { notified: 0, skipped: "migration_253_not_applied" };
    }
    if (insErr) throw new Error("notify insert: " + insErr.message);
    return { notified: rows.length };
  } catch (err) {
    console.warn("[notify]", payload?.kind, "failed:", err?.message || err);
    return { notified: 0, error: err?.message || String(err) };
  }
};

/**
 * One broadcast row.
 *
 * @param {*} svc        service-role supabase client
 * @param {string} tenantId
 * @param {object} payload
 *   kind, title, body, link_route?, link_params?, actor_user_id?,
 *   actor_email?, object_type?, object_id?
 * @param {object} opts
 *   roles      array of roles; defaults to ['admin']. The row is written
 *               only when one of them has an approved member. The roles
 *               are not stored: the bell shows the row to admin and operator.
 *   dedupKey   string used to suppress duplicate rows in the same
 *               5-minute window (avoids one push failure spamming the
 *               bell every retry tick).
 */
export const notifyAdmins = async (svc, tenantId, payload, opts = {}) => {
  if (!svc || !tenantId || !payload?.kind || !payload?.title) return { notified: 0 };
  const roles = safeArr(opts.roles).length ? opts.roles : ["admin"];
  const dedupKey = opts.dedupKey ? String(opts.dedupKey) : null;

  try {
    if (await isDuplicate(svc, tenantId, payload.kind, dedupKey)) return { notified: 0, deduped: true };

    // Write only when someone with one of the roles exists. The row itself
    // is a broadcast row; use notify() to reach each person.
    const { data: members, error } = await svc.from("tenant_members")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .eq("status", "approved")
      .in("role", roles);
    if (error) throw new Error("notify list members: " + error.message);
    if (!members?.length) return { notified: 0 };

    const { error: insErr } = await svc.from("admin_notifications").insert(buildRow(tenantId, payload, dedupKey));
    if (insErr) throw new Error("notify insert: " + insErr.message);
    return { notified: 1 };
  } catch (err) {
    console.warn("[notifyAdmins]", payload?.kind, "failed:", err?.message || err);
    return { notified: 0, error: err?.message || String(err) };
  }
};
