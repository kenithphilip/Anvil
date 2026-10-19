// A cap on the addressed alert emails one dispatcher queues, per run and per
// day (logistics_alert, inventory_alert).
//
// The bell has backlog control (the logistics digest, notifyAdmins dedup).
// The alert email had none, which did not matter while the rows had no
// recipient and the reaper failed them all. Now that they are addressed,
// the reaper delivers them. Switching on a monitor with a backlog, or an
// inventory exception that re-opens each day (its fingerprint carries the
// day), would then email every member of the alert roles once per
// exception, without limit.
//
// check() answers one of:
//   "ok"         send it, then call spend()
//   "run_cap"    this run has sent its share, or today's count could not be
//                read; leave the exception for a later run (do not stamp it)
//   "daily_cap"  today's share is used up; stamp the exception
//                email_skipped "daily_cap" so it leaves the work query (the
//                bell still rang, and the screen still lists it)
//
// Today's count is read once per run, from the communications rows of that
// template created since 00:00 UTC.

const startOfUtcDay = (now = new Date()) => {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

// How many emails of `template` this tenant has had queued since `sinceIso`,
// or null when that cannot be read.
export const alertEmailsQueuedSince = async (svc, tenantId, template, sinceIso) => {
  try {
    const r = await svc.from("communications")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("template_code", template)
      .gte("created_at", sinceIso);
    if (!r || r.error) return null;
    if (typeof r.count === "number") return r.count;
    return Array.isArray(r.data) ? r.data.length : 0;
  } catch {
    return null;
  }
};

const nonNegativeInt = (v, fallback) => {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export const makeAlertEmailBudget = (svc, tenantId, template, { perRun, perDay } = {}) => {
  const runCap = nonNegativeInt(perRun, 10);
  const dayCap = nonNegativeInt(perDay, 30);
  let leftToday;          // undefined until read; null when unreadable
  let usedThisRun = 0;
  return {
    async check() {
      if (leftToday === undefined) {
        const n = await alertEmailsQueuedSince(svc, tenantId, template, startOfUtcDay());
        leftToday = n == null ? null : Math.max(0, dayCap - n);
      }
      if (leftToday === null) return "run_cap";
      if (leftToday <= 0) return "daily_cap";
      if (usedThisRun >= runCap) return "run_cap";
      return "ok";
    },
    spend() {
      usedThisRun += 1;
      if (typeof leftToday === "number") leftToday -= 1;
    },
  };
};
