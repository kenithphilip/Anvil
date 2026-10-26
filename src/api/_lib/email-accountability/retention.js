// Content retention for email actions. docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.9.
//
// After tenant_settings.email_content_retention_days (default 30) the daily
// purge clears the preview text of an action and stamps content_purged_at.
// IDs, addresses, the subject and the reasons stay: they are the record of
// what was asked and why. Anvil stores no body and no attachment at any time.

const DEFAULT_DAYS = 30;
const BATCH = 500;

const fail = (what, r) => { if (r.error) throw new Error(what + ": " + r.error.message); return r.data || []; };

export const purgeContent = async (svc, { now = new Date() } = {}) => {
  const tenants = fail("tenants", await svc.from("tenant_settings") // audit-allow: cross-tenant (cron sweep)
    .select("*").eq("email_accountability_enabled", true));
  const results = [];
  for (const s of tenants) {
    const days = Number.isInteger(s.email_content_retention_days) ? s.email_content_retention_days : DEFAULT_DAYS;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const due = fail("due", await svc.from("email_actions").select("id")
      .eq("tenant_id", s.tenant_id).lt("created_at", cutoff).is("content_purged_at", null).limit(BATCH));
    if (due.length) {
      fail("purge", await svc.from("email_actions").update({ preview: null, content_purged_at: now.toISOString(), updated_at: now.toISOString() })
        .eq("tenant_id", s.tenant_id).in("id", due.map((r) => r.id)).is("content_purged_at", null));
    }
    results.push({ tenant_id: s.tenant_id, retention_days: days, purged: due.length, more: due.length === BATCH });
  }
  return { tenants: results.length, results };
};
