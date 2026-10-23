// The reminder and escalation policy, and the business calendar.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.7.
//
// Defaults live here; tenant_settings.email_policy (migration 270) overlays
// them, key by key, the logistics monitor's mergeRules pattern. Overrides
// match by priority, action type or mailbox and apply in order, so a tenant
// can, for example, give confirm_payment its own ladder. "Department" is a
// role here: Anvil has no department or manager table.
//
// All minutes are business minutes unless a key says otherwise.

export const DEFAULT_EMAIL_POLICY = Object.freeze({
  timezone: "Asia/Kolkata",
  business_hours: { start: "09:30", end: "17:30", weekend: ["Sat", "Sun"] },
  // Due time when the message states none.
  due_minutes: { critical: 240, high: 480, normal: 960 },
  // A notice to the owner the moment the action is made.
  notify_on_create: ["critical"],
  // Not started (still pending or detected) after this: remind the owner once.
  ack_minutes: { critical: 60, high: 240 },
  // Remind the owner this many business minutes before the due time.
  due_soon_minutes: { critical: 120, high: 120, normal: 240 },
  // After the due time. Each step is one escalation level; after_minutes is
  // calendar minutes past due. The owner is always told; backup adds the
  // backup owner; roles adds every approved member with that role.
  escalation: {
    critical: [
      { after_minutes: 0, backup: true, roles: ["sales_manager"] },
      { after_minutes: 1440, backup: true, roles: ["sales_manager"] },
      { after_minutes: 2880, backup: true, roles: ["admin"] },
    ],
    high: [
      { after_minutes: 0, backup: true, roles: [] },
      { after_minutes: 1440, backup: true, roles: ["sales_manager"] },
    ],
    normal: [
      { after_minutes: 0, backup: false, roles: [] },
    ],
  },
  // When the owner is no longer an approved member: tell these roles.
  unowned_roles: ["sales_manager"],
  // At most this many notices per tenant per sweep; the rest wait a sweep.
  max_notices_per_run: 25,
  // [{ match: { priority?, action_type?, mailbox_id? }, set: { ...keys above } }]
  overrides: [],
});

const PRIORITIES = ["critical", "high", "normal"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "design_engineer", "design_manager", "customer_support"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
// Objects merge key by key; arrays and scalars replace.
const merge = (base, over) => {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
};

export const tenantPolicy = (stored) => merge(DEFAULT_EMAIL_POLICY, stored || {});

// The policy for one action: the tenant policy plus every override that
// matches it, in order.
export const policyFor = (policy, { priority, action_type, mailbox_id }) => {
  let p = policy;
  for (const o of policy.overrides || []) {
    const m = o?.match || {};
    if (m.priority && m.priority !== priority) continue;
    if (m.action_type && m.action_type !== action_type) continue;
    if (m.mailbox_id && m.mailbox_id !== mailbox_id) continue;
    p = merge(p, o.set);
  }
  return p;
};

const minutesMap = (v, name, errs) => {
  if (v === undefined) return;
  if (!isObj(v)) { errs.push(name + " must be an object of minutes by priority"); return; }
  for (const [k, n] of Object.entries(v)) {
    if (!PRIORITIES.includes(k)) errs.push(name + "." + k + " is not a priority");
    else if (!(Number.isInteger(n) && n >= 0 && n <= 100_000)) errs.push(name + "." + k + " must be whole minutes from 0 to 100000");
  }
};

const ladder = (v, name, errs) => {
  if (v === undefined) return;
  if (!isObj(v)) { errs.push(name + " must be an object of steps by priority"); return; }
  for (const [k, steps] of Object.entries(v)) {
    if (!PRIORITIES.includes(k)) { errs.push(name + "." + k + " is not a priority"); continue; }
    if (!Array.isArray(steps) || steps.length > 6) { errs.push(name + "." + k + " must be a list of at most 6 steps"); continue; }
    let last = -1;
    steps.forEach((s, i) => {
      const at = name + "." + k + "[" + i + "]";
      if (!isObj(s) || !(Number.isInteger(s.after_minutes) && s.after_minutes >= 0 && s.after_minutes <= 100_000)) errs.push(at + ".after_minutes must be whole minutes");
      else if (s.after_minutes <= last) errs.push(at + ".after_minutes must grow step by step");
      else last = s.after_minutes;
      if (s?.roles !== undefined && !(Array.isArray(s.roles) && s.roles.every((r) => ROLES.includes(r)))) errs.push(at + ".roles must be known roles");
    });
  }
};

const checkKeys = (p, name, errs) => {
  if (p.timezone !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: p.timezone }); } catch { errs.push(name + "timezone is not a known timezone"); }
  }
  const bh = p.business_hours;
  if (bh !== undefined) {
    if (!isObj(bh)) errs.push(name + "business_hours must be an object");
    else {
      if (bh.start !== undefined && !HHMM.test(bh.start)) errs.push(name + "business_hours.start must be HH:MM");
      if (bh.end !== undefined && !HHMM.test(bh.end)) errs.push(name + "business_hours.end must be HH:MM");
      if (bh.start && bh.end && bh.start >= bh.end) errs.push(name + "business_hours.start must be before end");
      if (bh.weekend !== undefined && !(Array.isArray(bh.weekend) && bh.weekend.length < 7 && bh.weekend.every((d) => WEEKDAYS.includes(d)))) {
        errs.push(name + "business_hours.weekend must be a list of Mon..Sun with at least one work day");
      }
    }
  }
  minutesMap(p.due_minutes, name + "due_minutes", errs);
  minutesMap(p.ack_minutes, name + "ack_minutes", errs);
  minutesMap(p.due_soon_minutes, name + "due_soon_minutes", errs);
  ladder(p.escalation, name + "escalation", errs);
  if (p.notify_on_create !== undefined && !(Array.isArray(p.notify_on_create) && p.notify_on_create.every((x) => PRIORITIES.includes(x)))) {
    errs.push(name + "notify_on_create must be a list of priorities");
  }
  if (p.unowned_roles !== undefined && !(Array.isArray(p.unowned_roles) && p.unowned_roles.every((r) => ROLES.includes(r)))) {
    errs.push(name + "unowned_roles must be known roles");
  }
  if (p.max_notices_per_run !== undefined && !(Number.isInteger(p.max_notices_per_run) && p.max_notices_per_run >= 1 && p.max_notices_per_run <= 200)) {
    errs.push(name + "max_notices_per_run must be from 1 to 200");
  }
};

const KNOWN = new Set(Object.keys(DEFAULT_EMAIL_POLICY));

// The errors in a stored policy (an overlay). Empty means valid.
export const policyErrors = (p) => {
  const errs = [];
  if (!isObj(p)) return ["the policy must be an object"];
  for (const k of Object.keys(p)) if (!KNOWN.has(k)) errs.push(k + " is not a policy key");
  checkKeys(p, "", errs);
  if (p.overrides !== undefined) {
    if (!Array.isArray(p.overrides) || p.overrides.length > 20) errs.push("overrides must be a list of at most 20");
    else p.overrides.forEach((o, i) => {
      if (!isObj(o?.match) || !isObj(o?.set)) { errs.push("overrides[" + i + "] needs match and set"); return; }
      for (const k of Object.keys(o.match)) if (!["priority", "action_type", "mailbox_id"].includes(k)) errs.push("overrides[" + i + "].match." + k + " is not a match key");
      for (const k of Object.keys(o.set)) if (!KNOWN.has(k) || k === "overrides") errs.push("overrides[" + i + "].set." + k + " is not a policy key");
      checkKeys(o.set, "overrides[" + i + "].set.", errs);
    });
  }
  return errs;
};
