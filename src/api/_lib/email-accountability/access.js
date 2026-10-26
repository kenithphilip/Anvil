// Who may see an email action, and the row the screens read.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.8.
//
// A user sees an action when they own it, back it up, or own a mailbox that
// received the message, or when they hold email.view_all. Everyone else gets
// 404, so the existence of an action does not leak. The lists apply the same
// rule in the query.

import { hasAction } from "../auth.js";
import { userDisplayNames } from "../assignee.js";
import { OPEN_CATEGORIES } from "./store.js";

export const PRIORITY_LABEL = { 1: "critical", 2: "high", 3: "normal", 4: "informational" };
const LIST_CAP = 500;

const fail = (what, r) => { if (r.error) throw new Error(what + ": " + r.error.message); return r.data || []; };

export const myConnectionIds = async (svc, ctx) => fail("mailboxes", await svc.from("mailbox_connections")
  .select("id").eq("tenant_id", ctx.tenantId).eq("owner_user_id", ctx.user.id)).map((r) => r.id);

export const canSee = (ctx, ea, wi, mine) => hasAction(ctx, "email.view_all")
  || wi?.assignee_user_id === ctx.user.id
  || ea.backup_user_id === ctx.user.id
  || (ea.seen_connection_ids || []).some((id) => mine.includes(id))
  || mine.includes(ea.connection_id);

const derive = (ea, wi, now) => ({
  overdue: OPEN_CATEGORIES.includes(wi.status_category) && !!wi.due_at && Date.parse(wi.due_at) < now,
  escalated: (ea.escalation_level || 0) > 0,
});

// One row: the action as the screens show it. Names come from batch lookups.
export const shape = (ea, wi, look, now = Date.now()) => ({
  id: ea.id,
  work_item_id: wi.id,
  version: wi.version,
  title: wi.title,
  status: wi.status,
  status_category: wi.status_category,
  ...derive(ea, wi, now),
  priority: wi.priority,
  priority_label: PRIORITY_LABEL[wi.priority] || null,
  due_at: wi.due_at,
  due_source: wi.due_source,
  due_timezone: ea.due_timezone,
  assignee_user_id: wi.assignee_user_id,
  assignee_name: look.names.get(wi.assignee_user_id) || null,
  backup_user_id: ea.backup_user_id,
  backup_name: look.names.get(ea.backup_user_id) || null,
  account_id: wi.account_id,
  customer_name: look.customers.get(wi.account_id) || null,
  order_id: wi.order_id,
  po_number: look.orders.get(wi.order_id) || null,
  opportunity_id: wi.opportunity_id,
  action_type: ea.action_type,
  requirement: ea.requirement,
  business_status: ea.business_status,
  consequence: ea.consequence,
  reasons: ea.reasons || [],
  escalation_level: ea.escalation_level || 0,
  provider: ea.provider,
  mailbox_id: ea.connection_id,
  mailbox: look.mailboxes.get(ea.connection_id) || null,
  from_address: ea.from_address,
  from_name: ea.from_name,
  to_addresses: ea.to_addresses || [],
  cc_addresses: ea.cc_addresses || [],
  subject: ea.subject,
  preview: ea.preview,
  received_at: ea.received_at,
  web_link: ea.web_link,
  last_activity_at: ea.last_activity_at,
  completed_at: wi.completed_at || null,
  created_at: wi.created_at || ea.created_at,
});

const lookups = async (svc, ctx, pairs) => {
  const ids = (f) => [...new Set(pairs.map(f).filter(Boolean))];
  const [customers, orders, mailboxes, names] = await Promise.all([
    ids((p) => p.wi.account_id).length
      ? svc.from("customers").select("id, customer_name").eq("tenant_id", ctx.tenantId).in("id", ids((p) => p.wi.account_id))
      : { data: [] },
    ids((p) => p.wi.order_id).length
      ? svc.from("orders").select("id, po_number").eq("tenant_id", ctx.tenantId).in("id", ids((p) => p.wi.order_id))
      : { data: [] },
    ids((p) => p.ea.connection_id).length
      ? svc.from("mailbox_connections").select("id, address").eq("tenant_id", ctx.tenantId).in("id", ids((p) => p.ea.connection_id))
      : { data: [] },
    userDisplayNames(svc, [...ids((p) => p.wi.assignee_user_id), ...ids((p) => p.ea.backup_user_id)]),
  ]);
  return {
    customers: new Map(fail("customers", customers).map((r) => [r.id, r.customer_name])),
    orders: new Map(fail("orders", orders).map((r) => [r.id, r.po_number])),
    mailboxes: new Map(fail("mailboxes", mailboxes).map((r) => [r.id, r.address])),
    names,
  };
};

const pair = async (svc, ctx, eaRows) => {
  if (!eaRows.length) return [];
  const items = fail("work items", await svc.from("work_items").select("*")
    .eq("tenant_id", ctx.tenantId).in("id", eaRows.map((e) => e.work_item_id).filter(Boolean)));
  const byId = new Map(items.map((w) => [w.id, w]));
  return eaRows.filter((ea) => byId.has(ea.work_item_id)).map((ea) => ({ ea, wi: byId.get(ea.work_item_id) }));
};

// The candidate actions the caller may see. view_all reads the tenant's
// email items; anyone else reads the four ways an action can be theirs.
// shortcut: at most 500 candidates each way, filtered after the read. Move the
// filters into the query when a tenant has more open actions than that.
const candidates = async (svc, ctx, { closed, scope }) => {
  const cats = closed ? ["done", "cancelled"] : OPEN_CATEGORIES;
  if (hasAction(ctx, "email.view_all") && scope !== "mine") {
    const items = fail("work items", await svc.from("work_items").select("id")
      .eq("tenant_id", ctx.tenantId).eq("subject_type", "email_action").in("status_category", cats)
      .order("updated_at", { ascending: false }).limit(LIST_CAP));
    if (!items.length) return [];
    return fail("actions", await svc.from("email_actions").select("*")
      .eq("tenant_id", ctx.tenantId).in("work_item_id", items.map((i) => i.id)));
  }
  const mine = await myConnectionIds(svc, ctx);
  const owned = fail("owned", await svc.from("work_items").select("id")
    .eq("tenant_id", ctx.tenantId).eq("subject_type", "email_action").eq("assignee_user_id", ctx.user.id)
    .in("status_category", cats).limit(LIST_CAP)).map((r) => r.id);
  const reads = [svc.from("email_actions").select("*").eq("tenant_id", ctx.tenantId).eq("backup_user_id", ctx.user.id).limit(LIST_CAP)];
  if (owned.length) reads.push(svc.from("email_actions").select("*").eq("tenant_id", ctx.tenantId).in("work_item_id", owned));
  if (mine.length) {
    reads.push(svc.from("email_actions").select("*").eq("tenant_id", ctx.tenantId).overlaps("seen_connection_ids", mine).limit(LIST_CAP));
    reads.push(svc.from("email_actions").select("*").eq("tenant_id", ctx.tenantId).in("connection_id", mine).limit(LIST_CAP));
  }
  const byId = new Map();
  for (const r of await Promise.all(reads)) for (const row of fail("actions", r)) byId.set(row.id, row);
  return [...byId.values()];
};

const RANK = { critical: 1, high: 2, normal: 3, informational: 4 };

// filters: mailbox, owner ("none" = unassigned), priority (1-4 or a label),
// customer, order, state (a status, "open", "closed", "overdue", "escalated"),
// due_before, due_after, scope ("mine" for a view_all user's own queue).
export const listActions = async (svc, ctx, f = {}) => {
  const closed = f.state === "closed" || f.state === "performed" || f.state === "cancelled";
  const rows = (await pair(svc, ctx, await candidates(svc, ctx, { closed, scope: f.scope })))
    .filter(({ wi }) => (closed ? ["done", "cancelled"] : OPEN_CATEGORIES).includes(wi.status_category));
  const now = Date.now();
  const prio = f.priority ? Number(RANK[f.priority] || f.priority) : null;
  const meOnly = f.scope === "mine";
  const out = rows.filter(({ ea, wi }) => {
    const d = derive(ea, wi, now);
    if (meOnly && wi.assignee_user_id !== ctx.user.id && ea.backup_user_id !== ctx.user.id) return false;
    if (f.mailbox && ea.connection_id !== f.mailbox && !(ea.seen_connection_ids || []).includes(f.mailbox)) return false;
    if (f.owner === "none" ? wi.assignee_user_id : f.owner && wi.assignee_user_id !== f.owner) return false;
    if (prio && wi.priority !== prio) return false;
    if (f.customer && wi.account_id !== f.customer) return false;
    if (f.order && wi.order_id !== f.order) return false;
    if (f.due_before && !(wi.due_at && wi.due_at <= f.due_before)) return false;
    if (f.due_after && !(wi.due_at && wi.due_at >= f.due_after)) return false;
    if (f.state === "overdue" && !d.overdue) return false;
    if (f.state === "escalated" && !d.escalated) return false;
    if (f.state && !["open", "closed", "overdue", "escalated"].includes(f.state) && wi.status !== f.state) return false;
    return true;
  });
  // Open: most urgent first, then the earliest due. Closed: the latest first.
  out.sort(closed
    ? (a, b) => String(b.wi.completed_at || b.wi.updated_at || "").localeCompare(String(a.wi.completed_at || a.wi.updated_at || ""))
    : (a, b) => (a.wi.priority - b.wi.priority) || String(a.wi.due_at || "~").localeCompare(String(b.wi.due_at || "~")));
  const look = await lookups(svc, ctx, out);
  return out.map(({ ea, wi }) => shape(ea, wi, look, now));
};

// One action the caller may see, with the raw rows for an update; null when
// it does not exist or the caller may not see it.
export const loadAction = async (svc, ctx, id) => {
  const ea = await svc.from("email_actions").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (ea.error) throw new Error("action: " + ea.error.message);
  if (!ea.data?.work_item_id) return null;
  const wi = await svc.from("work_items").select("*").eq("tenant_id", ctx.tenantId).eq("id", ea.data.work_item_id).maybeSingle();
  if (wi.error) throw new Error("work item: " + wi.error.message);
  if (!wi.data) return null;
  const mine = await myConnectionIds(svc, ctx);
  if (!canSee(ctx, ea.data, wi.data, mine)) return null;
  const look = await lookups(svc, ctx, [{ ea: ea.data, wi: wi.data }]);
  return { ea: ea.data, wi: wi.data, mine, row: shape(ea.data, wi.data, look) };
};
