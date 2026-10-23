// A stand-in for the SQL function email_action_ensure (migration 268), for
// tests on the memory fake, which has no SQL functions. Same semantics as the
// function, which the EA-3 PR checked on a real Postgres engine: unique for
// life on (tenant, message key, action type); a second mailbox is recorded in
// seen_connection_ids; one work item per new action.
//
//   H.svc = withEnsure(H.db);   // then use H.svc() as the service client
export const withEnsure = (db) => () => {
  const svc = db.svc();
  svc.rpc = async (name, { p_item, p_action }) => {
    if (name !== "email_action_ensure") return { data: null, error: { message: "unknown function " + name } };
    db.tables.email_actions = db.tables.email_actions || [];
    db.tables.work_items = db.tables.work_items || [];
    const key = p_action.internet_message_id || p_action.provider + ":" + p_action.provider_message_id;
    const rows = db.tables.email_actions;
    const hit = rows.find((r) => r.tenant_id === p_action.tenant_id && r.message_key === key && r.action_type === p_action.action_type);
    if (hit) {
      if (p_action.connection_id && !hit.seen_connection_ids.includes(p_action.connection_id)) hit.seen_connection_ids.push(p_action.connection_id);
      return { data: [{ out_action_id: hit.id, out_item_id: hit.work_item_id, out_created: false }], error: null };
    }
    const id = "ea-" + (rows.length + 1);
    const itemId = "wi-" + (db.tables.work_items.length + 1);
    rows.push({
      business_status: "not_assessed", escalation_level: 0, reopen_count: 0, forward_to: [], ...p_action,
      id, message_key: key, work_item_id: itemId,
      seen_connection_ids: p_action.connection_id ? [p_action.connection_id] : [],
    });
    db.tables.work_items.push({
      ...p_item, id: itemId, tenant_id: p_action.tenant_id, type: "task", subject_type: "email_action",
      subject_id: id, source: "event", source_key: "email_action:" + id, priority: p_item.priority ?? 3, version: 1,
    });
    return { data: [{ out_action_id: id, out_item_id: itemId, out_created: true }], error: null };
  };
  return svc;
};
