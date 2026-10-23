// The engine the mailbox sync runs on each page (syncConnection onPage):
// inbound messages are excluded, classified, linked, and become actions.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md sections 4 and 6.2 to 6.4.
//
// Rules:
//   - Nothing is written for an excluded or irrelevant message.
//   - In 'observe' mode (tenant_settings.email_actions_mode, the default)
//     nothing is written at all; the counts say what 'create' would make.
//   - A follow-up in a thread with an open action of the same type updates
//     that action and makes no new one.
//   - The same message from two mailboxes is one action (email_action_ensure).
//     The owner is the person in To before the person in Cc.
//   - Nothing here reads isRead or any read state.
//   - A database error throws, so the page is not marked done and the next
//     run tries again.
//
// EA-5 adds the outbound side (reply and forward verification).

import { classify, exclusionOf, PRIORITY_RANK } from "./rules.js";
import { linkSender, linkOrder, FREE_MAIL_DOMAINS } from "./link.js";
import { ensureAction, openActionsInThread, touchFollowUp, STATUS_CATEGORY } from "./store.js";
import { resolveAssignee } from "../assignee.js";
import { recordAudit } from "../audit.js";

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export const messageKey = (m) => m.internetMessageId || m.provider + ":" + m.providerId;

const domainOf = (a) => String(a || "").split("@")[1] || "";
const systemCtx = (tenantId) => ({ tenantId, user: null, role: "system" });

// Per run and tenant: the company's own mail domains (the connected
// mailboxes, never a free-mail domain) and the active rules.
const loadTenant = async (svc, tenantId) => {
  const [mailboxes, rules, settings] = await Promise.all([
    svc.from("mailbox_connections").select("address").eq("tenant_id", tenantId),
    svc.from("email_rules").select("id, scope_user_id, kind, pattern, effect")
      .eq("tenant_id", tenantId).eq("active", true),
    svc.from("tenant_settings").select("email_actions_mode").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  for (const r of [mailboxes, rules, settings]) if (r.error) throw new Error("engine tenant: " + r.error.message);
  const tenantDomains = new Set((mailboxes.data || []).map((m) => domainOf(m.address).toLowerCase())
    .filter((d) => d && !FREE_MAIL_DOMAINS.has(d)));
  return {
    tenantDomains,
    rules: rules.data || [],
    mode: settings.data?.email_actions_mode === "create" ? "create" : "observe",
    members: new Map(),
  };
};

const memberOrNull = async (svc, t, tenantId, userId) => {
  if (!userId) return null;
  if (!t.members.has(userId)) t.members.set(userId, await resolveAssignee(svc, tenantId, userId));
  return t.members.get(userId);
};

const customerOwner = async (svc, tenantId, customerId) => {
  if (!customerId) return null;
  const r = await svc.from("customers").select("owner_user_id").eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
  if (r.error) throw new Error("customer owner: " + r.error.message);
  return r.data?.owner_user_id || null;
};

// The message reached an existing action through a second mailbox. When this
// mailbox is in To and the current owner's mailbox is not, and nobody has
// started the work, this mailbox's owner takes it.
const preferToRecipient = async (svc, tenantId, actionId, m, conn) => {
  if (!conn.owner_user_id || !m.to.includes(String(conn.address).toLowerCase())) return false;
  const a = await svc.from("email_actions").select("id, connection_id, work_item_id")
    .eq("tenant_id", tenantId).eq("id", actionId).maybeSingle();
  if (a.error) throw new Error("action read: " + a.error.message);
  if (!a.data || a.data.connection_id === conn.id) return false;
  const [prev, item] = await Promise.all([
    a.data.connection_id
      ? svc.from("mailbox_connections").select("address").eq("tenant_id", tenantId).eq("id", a.data.connection_id).maybeSingle()
      : Promise.resolve({ data: null }),
    svc.from("work_items").select("id, status, assignee_user_id").eq("tenant_id", tenantId).eq("id", a.data.work_item_id).maybeSingle(),
  ]);
  if (prev.error || item.error) throw new Error("owner check: " + (prev.error || item.error).message);
  if (prev.data && m.to.includes(String(prev.data.address).toLowerCase())) return false;
  if (!item.data || item.data.assignee_user_id === conn.owner_user_id) return false;
  const nowIso = new Date().toISOString();
  // Only while nobody has started: the status filter makes it one atomic check.
  const w = await svc.from("work_items").update({ assignee_user_id: conn.owner_user_id, updated_at: nowIso })
    .eq("tenant_id", tenantId).eq("id", item.data.id).eq("status", "pending").select("id");
  if (w.error) throw new Error("owner switch: " + w.error.message);
  if (!w.data?.length) return false;
  const e = await svc.from("email_actions").update({ connection_id: conn.id, updated_at: nowIso })
    .eq("tenant_id", tenantId).eq("id", actionId);
  if (e.error) throw new Error("owner switch: " + e.error.message);
  await recordAudit(systemCtx(tenantId), {
    action: "email_action_reassigned", objectType: "email_action", objectId: actionId,
    before: { assignee_user_id: item.data.assignee_user_id }, after: { assignee_user_id: conn.owner_user_id },
    reason: "The message was addressed To this mailbox and only copied to the previous owner.",
  });
  return true;
};

const processInbound = async (svc, m, conn, t, { now, timezone }, counts) => {
  const tenantId = conn.tenant_id;
  const rules = t.rules.filter((r) => !r.scope_user_id || r.scope_user_id === conn.owner_user_id);
  if (exclusionOf(m, { tenantDomains: t.tenantDomains, rules })) { counts.excluded += 1; return; }

  const text = (m.subject || "") + "\n" + (m.preview || "");
  const link = await linkSender(svc, tenantId, m.from);
  const order = link.reliable ? await linkOrder(svc, tenantId, link.customer_id, text) : null;
  const key = messageKey(m);
  const open = await openActionsInThread(svc, tenantId, m, key);
  const result = classify(m, {
    now, timezone, tenantDomains: t.tenantDomains, rules, link, order,
    openTypesInThread: new Set(open.map((a) => a.action_type)),
  });
  if (!result.relevant) { counts.irrelevant += 1; return; }

  const rank = PRIORITY_RANK[result.priority];
  if (t.mode !== "create") {
    counts.would_create += result.actions.length;
    counts.follow_ups += result.followUpTypes.length;
    return;
  }
  for (const type of result.followUpTypes) {
    for (const a of open.filter((x) => x.action_type === type)) {
      await touchFollowUp(svc, tenantId, a, rank, now);
      counts.follow_ups += 1;
    }
  }
  if (!result.actions.length) return;

  const owner = await memberOrNull(svc, t, tenantId, conn.owner_user_id);
  const custOwner = link.reliable ? await customerOwner(svc, tenantId, link.customer_id) : null;
  const backup = custOwner && custOwner !== owner ? await memberOrNull(svc, t, tenantId, custOwner) : null;
  const status = result.review ? "awaiting_review" : owner ? "pending" : "detected";
  const refs = [...new Set([...(m.references || []), m.inReplyTo].filter(Boolean))];

  for (const a of result.actions) {
    const item = {
      title: a.title,
      detail: "From " + (m.from || "an unknown sender"),
      category: "email_" + a.type,
      account_id: link.reliable ? link.customer_id : null,
      opportunity_id: order?.opportunity_id || null,
      order_id: order?.order_id || null,
      status, status_category: STATUS_CATEGORY[status],
      assignee_user_id: owner,
      due_at: a.due.at.toISOString(), due_source: a.due.source, due_basis: a.due.basis,
      priority: rank,
    };
    const action = {
      tenant_id: tenantId, connection_id: conn.id, provider: m.provider,
      provider_message_id: m.providerId, internet_message_id: m.internetMessageId || null,
      conversation_id: m.conversationId, conversation_index: m.conversationIndex, thread_refs: refs,
      from_address: m.from, from_name: m.fromName, to_addresses: m.to, cc_addresses: m.cc,
      subject: m.subject, preview: m.preview, received_at: m.receivedAt, web_link: m.webLink,
      customer_contact_id: link.reliable ? link.contact_id : null,
      action_type: a.type, requirement: a.requirement, forward_to: [],
      business_status: result.review ? "not_assessed" : "awaiting_internal",
      reasons: result.reasons, consequence: a.consequence,
      backup_user_id: backup, due_timezone: timezone,
    };
    const r = await ensureAction(svc, item, action);
    if (r.created) {
      counts.created += 1;
      await recordAudit(systemCtx(tenantId), {
        action: "email_action_detected", objectType: "email_action", objectId: r.actionId,
        after: { type: a.type, priority: result.priority, status, work_item_id: r.itemId },
      });
    } else {
      counts.seen_again += 1;
      if (await preferToRecipient(svc, tenantId, r.actionId, m, conn)) counts.reassigned += 1;
    }
  }
};

// onPage for syncConnection. One engine per sync run; it caches per tenant.
export const makeEngine = (svc, { now = () => new Date(), timezone = DEFAULT_TIMEZONE } = {}) => {
  const tenants = new Map();
  return async (messages, { connection }) => {
    if (!tenants.has(connection.tenant_id)) tenants.set(connection.tenant_id, await loadTenant(svc, connection.tenant_id));
    const t = tenants.get(connection.tenant_id);
    const counts = { created: 0, would_create: 0, excluded: 0, irrelevant: 0, follow_ups: 0, seen_again: 0, reassigned: 0 };
    for (const m of messages) {
      if (m.direction === "in") await processInbound(svc, m, connection, t, { now: now(), timezone }, counts);
    }
    return counts;
  };
};
