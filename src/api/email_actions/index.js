// GET /api/email_actions: the email actions the caller may see.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.8 and 6.10.
//
// Query: mailbox, owner ("none" = unassigned), priority (1-4 or a label),
// customer, order, state (a status, "open" (default), "closed", "overdue",
// "escalated"), due_before, due_after, scope ("mine").
// Writers only: viewer and customer_support have no access, because the rows
// carry mail subjects and senders.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { listActions } from "../_lib/email-accountability/access.js";

const FILTERS = ["mailbox", "owner", "priority", "customer", "order", "state", "due_before", "due_after", "scope"];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") return json(res, 405, { error: { message: "method not allowed" } });
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const q = req.query || {};
    const filters = Object.fromEntries(FILTERS.filter((k) => q[k]).map((k) => [k, String(q[k])]));
    const actions = await listActions(serviceClient(), ctx, filters);
    return json(res, 200, { ok: true, actions });
  } catch (err) {
    return sendError(res, err);
  }
}
