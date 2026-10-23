// Where email actions are stored. This is the one module that knows an action
// is a work_items row plus an email_actions row (plan ED-1). If the owner
// chooses a standalone table instead, only this file changes.

export const OPEN_CATEGORIES = ["todo", "in_progress", "blocked"];

// Action state -> work_items.status_category (plan 6.5).
export const STATUS_CATEGORY = {
  detected: "todo",
  awaiting_review: "todo",
  pending: "todo",
  in_progress: "in_progress",
  awaiting_verification: "in_progress",
  performed: "done",
  cancelled: "cancelled",
};

// The moves a person may make (plan 6.5). "performed" needs evidence (EA-5)
// and "awaiting_verification" is set by the verifier, so neither is here.
// From performed or cancelled, "pending" is a reopen.
export const TRANSITIONS = {
  detected: ["pending", "cancelled"],
  awaiting_review: ["pending", "cancelled"],
  pending: ["in_progress", "cancelled"],
  in_progress: ["pending", "cancelled"],
  awaiting_verification: ["in_progress", "cancelled"],
  performed: ["pending"],
  cancelled: ["pending"],
};
export const isReopen = (from, to) => to === "pending" && (from === "performed" || from === "cancelled");

// Make the pair in one transaction, or return the existing one. Returns
// { actionId, itemId, created }.
export const ensureAction = async (svc, item, action) => {
  const { data, error } = await svc.rpc("email_action_ensure", { p_item: item, p_action: action });
  if (error) throw new Error("email_action_ensure: " + error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.out_action_id) throw new Error("email_action_ensure returned no row");
  return { actionId: row.out_action_id, itemId: row.out_item_id, created: !!row.out_created };
};

// The open actions in the message's thread: those whose message the new one
// answers (In-Reply-To or References), and those in the same conversation.
// The message's own action, if it was seen before, is left out.
export const openActionsInThread = async (svc, tenantId, m, ownKey) => {
  const ids = [...new Set([m.inReplyTo, ...(m.references || [])].filter(Boolean))];
  const reads = [];
  if (ids.length) {
    reads.push(svc.from("email_actions").select("id, action_type, work_item_id, message_key")
      .eq("tenant_id", tenantId).in("internet_message_id", ids).limit(50));
  }
  if (m.conversationId) {
    reads.push(svc.from("email_actions").select("id, action_type, work_item_id, message_key")
      .eq("tenant_id", tenantId).eq("conversation_id", m.conversationId).limit(50));
  }
  const rows = [];
  for (const r of await Promise.all(reads)) {
    if (r.error) throw new Error("thread lookup: " + r.error.message);
    rows.push(...(r.data || []));
  }
  const byId = new Map(rows.filter((r) => r.message_key !== ownKey && r.work_item_id).map((r) => [r.id, r]));
  if (!byId.size) return [];
  const items = await svc.from("work_items").select("id, status_category, priority")
    .eq("tenant_id", tenantId).in("id", [...byId.values()].map((r) => r.work_item_id))
    .in("status_category", OPEN_CATEGORIES);
  if (items.error) throw new Error("thread items: " + items.error.message);
  const open = new Map((items.data || []).map((i) => [i.id, i]));
  return [...byId.values()].filter((r) => open.has(r.work_item_id))
    .map((r) => ({ ...r, priority: open.get(r.work_item_id).priority }));
};

// A follow-up in the thread: note the activity, and raise the priority when
// the follow-up is more urgent. It never changes the state.
export const touchFollowUp = async (svc, tenantId, action, priorityRank, now) => {
  const nowIso = now.toISOString();
  const a = await svc.from("email_actions").update({ last_activity_at: nowIso, updated_at: nowIso })
    .eq("tenant_id", tenantId).eq("id", action.id);
  if (a.error) throw new Error("follow-up touch: " + a.error.message);
  if (priorityRank < action.priority) {
    const w = await svc.from("work_items").update({ priority: priorityRank, updated_at: nowIso })
      .eq("tenant_id", tenantId).eq("id", action.work_item_id);
    if (w.error) throw new Error("follow-up priority: " + w.error.message);
    return true;
  }
  return false;
};
