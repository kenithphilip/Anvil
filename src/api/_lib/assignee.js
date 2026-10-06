// Who work, or an account, may be given to.
//
// Moved here from service/visits.js so the visit dispatcher and the customer
// account-owner endpoint share one definition of "assignable". Two copies of
// a membership check drift, and the drift is always the one that forgot the
// status filter.

// Who a visit (or an account) may be assigned to.
//
// The assignee must be an APPROVED member of this tenant. A raw user id off the
// request body would otherwise let a record be assigned to a member of another
// tenant, which is the same class of hole as any caller-supplied FK; and an
// unapproved / removed member cannot be given work. Returns the id when it is
// assignable, otherwise null.
export const resolveAssignee = async (svc, tenantId, userId) => {
  if (!userId) return null;
  const { data, error } = await svc.from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .maybeSingle();
  // A read failure is not "not a member": say so, so the caller reports a
  // transient fault instead of accusing a real colleague of not existing.
  if (error) throw new Error("could not verify the assignee: " + error.message);
  if (!data) return null;
  return data.user_id;
};

// Display names for a handful of auth users, keyed by id.
//
// Auth users live in the auth schema, which PostgREST does not expose, so the
// only working lookup is getUserById per id (the pattern admin/members.js and
// analytics/winloss.js use). Bounded by the number of DISTINCT ids passed in,
// which for owners is the size of the sales team, not the size of the list.
// A failed lookup is not fatal: that id simply has no name, and the caller
// renders whatever fallback it already has.
export const userDisplayNames = async (svc, userIds) => {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  await Promise.all(ids.map(async (uid) => {
    try {
      const { data } = await svc.auth.admin.getUserById(uid);
      const u = data && data.user;
      if (!u) return;
      const meta = u.user_metadata || {};
      out.set(uid, meta.name || meta.full_name || u.email || null);
    } catch { /* name stays unknown; the row still renders */ }
  }));
  return out;
};
