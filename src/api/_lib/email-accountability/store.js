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

// States the verifier may move from. It never revives a performed or
// cancelled action.
const VERIFY_FROM = {
  performed: ["detected", "awaiting_review", "pending", "in_progress", "awaiting_verification"],
  awaiting_verification: ["detected", "awaiting_review", "pending", "in_progress"],
};

// The not-closed actions a sent message may answer: named in its In-Reply-To
// or References, or in its conversation. With their work item state.
export const candidatesForSent = async (svc, tenantId, m) => {
  const ids = [...new Set([m.inReplyTo, ...(m.references || [])].filter(Boolean))];
  const reads = [];
  if (ids.length) reads.push(svc.from("email_actions").select("*").eq("tenant_id", tenantId).in("internet_message_id", ids).limit(50));
  if (m.conversationId) reads.push(svc.from("email_actions").select("*").eq("tenant_id", tenantId).eq("conversation_id", m.conversationId).limit(50));
  const byId = new Map();
  for (const r of await Promise.all(reads)) {
    if (r.error) throw new Error("sent candidates: " + r.error.message);
    for (const row of r.data || []) if (row.work_item_id) byId.set(row.id, row);
  }
  if (!byId.size) return [];
  const items = await svc.from("work_items").select("id, status, status_category, version, assignee_user_id")
    .eq("tenant_id", tenantId).in("id", [...byId.values()].map((a) => a.work_item_id))
    .in("status_category", OPEN_CATEGORIES);
  if (items.error) throw new Error("sent candidates: " + items.error.message);
  const open = new Map((items.data || []).map((w) => [w.id, w]));
  return [...byId.values()].filter((a) => open.has(a.work_item_id)).map((a) => ({ ...a, item: open.get(a.work_item_id) }));
};

// One evidence row per action and outgoing message. Returns { inserted, id }.
export const recordOutgoingEvidence = async (svc, tenantId, action, m, conn, j) => {
  let q = svc.from("email_action_evidence").select("id").eq("tenant_id", tenantId)
    .eq("email_action_id", action.id).eq("kind", "outgoing");
  q = m.internetMessageId ? q.eq("internet_message_id", m.internetMessageId) : q.eq("provider_message_id", m.providerId);
  const prior = await q.limit(1);
  if (prior.error) throw new Error("evidence read: " + prior.error.message);
  if ((prior.data || []).length) return { inserted: false, id: prior.data[0].id };
  const ins = await svc.from("email_action_evidence").insert({
    tenant_id: tenantId, email_action_id: action.id, kind: "outgoing", connection_id: conn.id,
    provider: m.provider, provider_message_id: m.providerId, internet_message_id: m.internetMessageId || null,
    sent_at: m.sentAt, sender: m.from, recipients: [...(m.to || []), ...(m.cc || [])],
    has_attachments: !!m.hasAttachments, web_link: m.webLink || null,
    method: j.method, status: j.status, confidence: j.confidence, reasons: j.reasons,
  }).select("id");
  if (ins.error) {
    if (ins.error.code === "23505") return { inserted: false, id: null };
    throw new Error("evidence insert: " + ins.error.message);
  }
  return { inserted: true, id: ins.data?.[0]?.id || null };
};

// Move the work item to performed or awaiting_verification, guarded by its
// version and by the states it may move from. Performed also moves the
// business outcome from awaiting_internal to awaiting_external: the reply is
// done, the matter is not resolved. Returns true when the state changed.
export const applyVerification = async (svc, tenantId, action, to, { at, by, resolution }) => {
  let item = action.item;
  let patch = null;
  // A person may edit the item between the read and this write; read it
  // again and try once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      const r = await svc.from("work_items").select("id, status, version").eq("tenant_id", tenantId).eq("id", item.id).maybeSingle();
      if (r.error) throw new Error("verify state: " + r.error.message);
      if (!r.data) return false;
      item = r.data;
    }
    if (!VERIFY_FROM[to]?.includes(item.status)) return false;
    patch = { status: to, status_category: STATUS_CATEGORY[to], version: item.version + 1, updated_at: new Date().toISOString() };
    if (to === "performed") Object.assign(patch, { completed_at: at, completed_by: by || null, resolution });
    const w = await svc.from("work_items").update(patch)
      .eq("tenant_id", tenantId).eq("id", item.id).eq("version", item.version).select("id");
    if (w.error) throw new Error("verify state: " + w.error.message);
    if (w.data?.length) break;
    if (attempt) return false;
  }
  if (to === "performed" && ["awaiting_internal", "not_assessed"].includes(action.business_status)) {
    const e = await svc.from("email_actions").update({ business_status: "awaiting_external", updated_at: patch.updated_at })
      .eq("tenant_id", tenantId).eq("id", action.id);
    if (e.error) throw new Error("business status: " + e.error.message);
  }
  return true;
};
