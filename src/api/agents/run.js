// POST /api/agents/run
//
// Cron-invoked runner for the autonomous agent. Walks every active
// goal whose next_run_at is in the past, dispatches it to the right
// handler, executes the chosen action, and persists a step row.
//
// Auth: gated by the CRON_SECRET. Vercel cron sets the
// `Authorization: Bearer ${CRON_SECRET}` header automatically when
// vercel.json crons declare the path. Direct calls without the
// secret return 401 so the runner cannot be triggered from the
// outside world.
//
// We deliberately keep the runner small. Handlers do the thinking;
// the runner only orchestrates: read N goals, ask handler for next
// action, execute, write step, advance bookkeeping.

import { applyCors, handlePreflight, json } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { dispatch, KNOWN_GOAL_TYPES } from "./_handlers/index.js";

const CRON_SECRET = process.env.CRON_SECRET;
const HOURS = 60 * 60 * 1000;

const recordStepAndAdvance = async (svc, goal, step, opts) => {
  const stepRow = {
    tenant_id: goal.tenant_id,
    goal_id: goal.id,
    step_no: (goal.step_count || 0) + 1,
    thought: step.thought || null,
    action: step.action,
    action_payload: step.action_payload || {},
    result: opts.result || "ok",
    result_detail: opts.result_detail || null,
    model_used: opts.model_used || null,
    tokens_in: opts.tokens_in || null,
    tokens_out: opts.tokens_out || null,
    cost_usd_cents: opts.cost_usd_cents || null,
  };
  await svc.from("agent_steps").insert(stepRow);

  // Update goal bookkeeping. The runner is the only writer for
  // step_count + last_action_at + last_action; a handler that needs
  // to mark the goal terminal returns mark_complete / give_up.
  const next = {
    step_count: (goal.step_count || 0) + 1,
    last_action_at: new Date().toISOString(),
    last_action: step.action,
    updated_at: new Date().toISOString(),
  };
  if (step.action === "mark_complete") next.status = "completed";
  else if (step.action === "give_up") next.status = "failed";
  else if (step.action === "escalate") {
    // Stay active; let the operator decide. Escalation is a side
    // effect, not a state transition.
    next.status = "active";
  }
  if (step.action !== "noop" && step.action !== "mark_complete" && step.action !== "give_up") {
    next.next_run_at = new Date(Date.now() + (goal.config?.cooldown_hours || 24) * HOURS).toISOString();
  } else if (step.action === "noop") {
    // Honor the handler's nudge if it suggested how long to sleep,
    // otherwise default to 1 hour.
    const sleepHours = step.action_payload?.sleep_hours || 1;
    next.next_run_at = new Date(Date.now() + sleepHours * HOURS).toISOString();
  }
  if (opts.error) next.last_error = String(opts.error);
  await svc.from("agent_goals").update(next).eq("id", goal.id);

  // Audit so the outcome meter (Phase A) sees the work. Two flavours:
  // any non-noop step is an agent_action_taken; mark_complete + give_up
  // also emit agent_goal_completed/agent_goal_failed so we can graph
  // outcomes vs failures separately.
  const auditAction = step.action === "mark_complete"
    ? "agent_goal_completed"
    : step.action === "give_up"
      ? "agent_goal_failed"
      : step.action === "noop"
        ? null
        : "agent_action_taken";
  if (auditAction) {
    await svc.from("audit_events").insert({
      tenant_id: goal.tenant_id,
      action: auditAction,
      object_type: "agent_goals",
      object_id: goal.id,
      detail: JSON.stringify({ goal_type: goal.goal_type, action: step.action }),
    });
  }
};

const executeAction = async (svc, goal, step) => {
  if (step.action === "noop" || step.action === "mark_complete" || step.action === "give_up") {
    return { result: "ok" };
  }
  if (step.action === "escalate") {
    // Escalation surface today: write a processing_event tagged for the
    // owner. UIs can subscribe / poll. Real notification (email + Slack)
    // arrives once the comms-provider work in Phase A+ ships.
    await svc.from("processing_events").insert({
      tenant_id: goal.tenant_id,
      case_id: goal.object_id,
      event_type: "agent_escalation",
      object_type: goal.object_type,
      object_id: goal.object_id,
      detail: { goal_id: goal.id, goal_type: goal.goal_type, payload: step.action_payload },
      severity: "warn",
    });
    return { result: "ok", result_detail: "escalation event recorded" };
  }
  if (step.action === "send_email") {
    // The runner does not call communications.send directly: those
    // endpoints require an authenticated context and we run as the
    // service role. Instead we draft the row directly into the
    // communications table with status 'queued' so the existing
    // UI + cron + provider plumbing picks it up. The send.js endpoint
    // already polls / fires by id.
    const draft = {
      tenant_id: goal.tenant_id,
      object_type: goal.object_type,
      object_id: goal.object_id,
      kind: step.action_payload?.kind || "agent_message",
      to_address: step.action_payload?.to || null,
      subject: step.action_payload?.subject || "Follow-up",
      body: step.action_payload?.hint || "(agent-generated; body filled at send time)",
      status: "queued",
      sent_by: null,
      meta: { agent_goal_id: goal.id, payload: step.action_payload },
    };
    const ins = await svc.from("communications").insert(draft).select("id").maybeSingle();
    if (ins.error) return { result: "error", result_detail: ins.error.message, error: ins.error.message };
    return { result: "ok", result_detail: "queued comm " + (ins.data?.id || "") };
  }
  return { result: "skipped", result_detail: "unknown action " + step.action };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "POST, GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return json(res, 401, { error: { message: "agent runner is cron-only" } });
  }
  try {
    const svc = serviceClient();
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    const { data: goals, error } = await svc
      .from("agent_goals")
      .select("*")
      .eq("status", "active")
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error("agent_goals fetch: " + error.message);

    const results = [];
    for (const g of goals || []) {
      if (!KNOWN_GOAL_TYPES.includes(g.goal_type)) {
        results.push({ id: g.id, action: "skipped", detail: "unknown goal_type" });
        continue;
      }
      try {
        const step = await dispatch(g, { svc });
        const exec = await executeAction(svc, g, step);
        await recordStepAndAdvance(svc, g, step, exec);
        results.push({ id: g.id, action: step.action, result: exec.result });
      } catch (err) {
        results.push({ id: g.id, action: "error", detail: err.message });
        await svc.from("agent_goals").update({
          last_error: err.message,
          updated_at: new Date().toISOString(),
        }).eq("id", g.id);
      }
    }
    return json(res, 200, { ran_at: new Date().toISOString(), considered: (goals || []).length, results });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
}
