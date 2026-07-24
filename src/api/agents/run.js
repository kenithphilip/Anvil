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
import { safeFetch } from "../_lib/safe-fetch.js";
import { commsRow } from "../_lib/comms-row.js";

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
    // Bug fix May 2026: || was promoting legitimate 0 values to
    // null, so a step that genuinely consumed 0 tokens or had 0
    // cost was rendered as "no metric available." Use ?? so only
    // null/undefined collapse.
    model_used: opts.model_used ?? null,
    tokens_in: opts.tokens_in ?? null,
    tokens_out: opts.tokens_out ?? null,
    cost_usd_cents: opts.cost_usd_cents ?? null,
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
      detail: { goal_id: goal.id, goal_type: goal.goal_type, payload: step.action_payload, severity: "warn" },
    });
    return { result: "ok", result_detail: "escalation event recorded" };
  }
  if (step.action === "send_email") {
    // Draft the row at status=queued. The reaper at the end of the
    // run picks it up and fires it through the configured provider
    // (SendGrid first, generic webhook second). Drafting in the
    // queued state is intentional: if the reaper crashes, the row
    // remains in the database for manual flush from the UI.
    //
    // Audit P1.4 (May 2026): the body field used to fall back to
    // action_payload.hint, which was originally meant as a prompt
    // hint for an LLM drafter that never landed. Customers were
    // receiving emails whose body was literally a prompt directive
    // ("Polite, concise quote nudge..."). Now: handlers MUST
    // provide a real `body`. If absent, fail the step rather than
    // ship a prompt hint to a customer.
    const body = step.action_payload?.body;
    if (typeof body !== "string" || body.trim().length === 0) {
      return {
        result: "skipped",
        result_detail: "handler returned no body; action_payload.hint is not a fallback for body",
        error: "missing_body",
      };
    }
    const draft = {
      tenant_id: goal.tenant_id,
      object_type: step.action_payload?.object_type || goal.object_type,
      object_id: step.action_payload?.object_id || goal.object_id,
      kind: step.action_payload?.kind || "agent_message",
      to_addr: step.action_payload?.to || null,
      subject: step.action_payload?.subject || "Follow-up",
      body,
      status: "queued",
      sent_by: null,
      metadata: { agent_goal_id: goal.id, payload: step.action_payload },
    };
    const ins = await svc.from("communications").insert(commsRow(draft)).select("id").maybeSingle();
    if (ins.error) return { result: "error", result_detail: ins.error.message, error: ins.error.message };
    return { result: "ok", result_detail: "queued comm " + (ins.data?.id || "") };
  }
  if (step.action === "place_outbound_call") {
    // Dispatched by the voice_followup handler. The handler is pure;
    // it decides "we should call back" and emits a payload. The
    // runner does the HTTP via the same compliance gate the
    // /api/voice/outbound endpoint takes (DND list + prior consent +
    // recording disclosure attached to call metadata).
    //
    // P0 from the May 2026 critic audit: this case was missing,
    // every voice_followup goal stalled with result="skipped" +
    // detail="unknown action place_outbound_call". Re-applied here
    // because the original PR #58 fix did not make it through the
    // squash-merge.
    try {
      const { checkOutboundCompliance } = await import("../_lib/voice-compliance.js");
      const { voiceDecryptCreds, voicePlaceOutboundCall } = await import("../_lib/voice-client.js");
      const cfgQ = await svc.from("voice_configs")
        .select("id, tenant_id, provider, api_key, api_key_enc, creds_iv, phone_number, phone_number_id, assistant_id, region, recording_disclosure, recording_disclosure_locale, outbound_enabled, active")
        .eq("tenant_id", goal.tenant_id)
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cfgQ.error || !cfgQ.data) {
        return { result: "error", result_detail: "no voice_configs row", error: "no_voice_config" };
      }
      const cfg = voiceDecryptCreds(cfgQ.data);
      const verdict = await checkOutboundCompliance(svc, {
        tenantId: goal.tenant_id,
        config: cfg,
        toNumber: step.action_payload?.to,
      });
      if (!verdict.allowed) {
        return {
          result: "skipped",
          result_detail: "outbound refused: " + verdict.reason + " (" + (verdict.detail || "") + ")",
          error: verdict.reason,
        };
      }
      const placement = await voicePlaceOutboundCall(cfg, {
        to: step.action_payload.to,
        fromAssistantId: cfg.assistant_id,
        metadata: {
          tenant_id: goal.tenant_id,
          customer_id: step.action_payload?.customer_id || null,
          reason: step.action_payload?.reason || "agent_followup",
          recording_disclosure: verdict.disclosure,
          consent_id: verdict.consent_id,
          region: verdict.region,
          original_call_id: step.action_payload?.original_call_id || null,
          agent_goal_id: goal.id,
        },
      });
      const insCall = await svc.from("voice_calls").insert({
        tenant_id: goal.tenant_id,
        config_id: cfg.id,
        provider: cfg.provider,
        external_id: placement.external_id,
        direction: "outbound",
        customer_id: step.action_payload?.customer_id || null,
        caller_phone_number: cfg.phone_number || null,
        callee_phone_number: step.action_payload.to,
        status: "in_progress",
        raw: { initiated_by: "agent_runner", placement: placement.raw, agent_goal_id: goal.id },
      }).select("id").single();
      if (insCall.error) {
        // Bug fix May 2026: previously we returned ok without a
        // recoverable trail. Now write a processing_event so ops
        // sees the orphan call and can reconcile via the provider's
        // external_id. We do NOT bump result to "error" because the
        // call IS placed; the customer is on the line.
        await svc.from("processing_events").insert({
          tenant_id: goal.tenant_id,
          case_id: goal.id,
          event_type: "voice_call_persist_failed",
          object_type: "voice_call",
          object_id: null,
          detail: {
            external_id: placement.external_id,
            provider: cfg.provider,
            callee: step.action_payload.to,
            agent_goal_id: goal.id,
            db_error: insCall.error.message,
            severity: "warn",
          },
        });
        return {
          result: "ok",
          result_detail: "call placed (" + placement.external_id + ") but voice_calls insert failed; processing_event written: " + insCall.error.message,
        };
      }
      return { result: "ok", result_detail: "voice call " + insCall.data.id + " placed" };
    } catch (err) {
      return { result: "error", result_detail: err.message || String(err), error: "place_outbound_call_failed" };
    }
  }
  return { result: "skipped", result_detail: "unknown action " + step.action };
};

// Send any communications row currently in status=queued. The
// agent's send_email action drops rows here; this reaper actually
// fires them. We resolve the provider the same way
// /api/communications/send does (SendGrid first, generic webhook
// second, manual fallback). Failures are persisted on the row's
// metadata so the UI shows what happened.
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "Anvil";
const PROVIDER_URL = process.env.COMMS_PROVIDER_URL;
const PROVIDER_TOKEN = process.env.COMMS_PROVIDER_TOKEN;

const sendViaSendGrid = async ({ to, subject, body, from }) => {
  if (!SENDGRID_KEY || !SENDGRID_FROM) return null;
  const fromAddress = from || SENDGRID_FROM;
  try {
    const resp = await safeFetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + SENDGRID_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromAddress, name: SENDGRID_FROM_NAME },
        subject: subject || "(no subject)",
        content: [
          { type: "text/plain", value: body || "" },
          { type: "text/html",  value: (body || "").replace(/\n/g, "<br/>") },
        ],
      }),
    });
    return { provider: "sendgrid", status: resp.status, ok: resp.ok };
  } catch (err) {
    return { provider: "sendgrid", status: 0, ok: false, detail: err.message };
  }
};

const sendViaGenericWebhook = async ({ to, subject, body, from }) => {
  if (!PROVIDER_URL) return null;
  try {
    const headers = { "Content-Type": "application/json" };
    if (PROVIDER_TOKEN) headers["Authorization"] = "Bearer " + PROVIDER_TOKEN;
    const resp = await safeFetch(PROVIDER_URL, {
      method: "POST", headers, body: JSON.stringify({ to, subject, body, from }),
    });
    return { provider: "generic", status: resp.status, ok: resp.ok };
  } catch (err) {
    return { provider: "generic", status: 0, ok: false, detail: err.message };
  }
};

const reapQueuedCommsForTenant = async (svc, tenantId) => {
  const queued = await svc
    .from("communications")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(100);
  if (queued.error) return { fired: 0, errors: 1 };
  let fired = 0;
  let errors = 0;
  for (const row of queued.data || []) {
    if (!row.to_addr) {
      // Cannot send without a recipient; flip to failed so the
      // operator can fix it.
      await svc.from("communications").update({
        status: "failed",
        metadata: { ...(row.metadata || {}), error: "no recipient" },
      }).eq("id", row.id);
      errors++;
      continue;
    }
    let result = null;
    let lastError = null;
    try { result = await sendViaSendGrid({ to: row.to_addr, subject: row.subject, body: row.body, from: row.from_addr }); }
    catch (e) { lastError = e; }
    if (!result) {
      try { result = await sendViaGenericWebhook({ to: row.to_addr, subject: row.subject, body: row.body, from: row.from_addr }); }
      catch (e) { lastError = e; }
    }

    // Audit fix (May 2026): when no provider is configured AND no
    // attempt was made, do not flip the row to "sent". The previous
    // code marked the comm sent regardless, so operators thought
    // emails went out when nothing did. New semantics:
    //   - provider returned ok=true       -> sent
    //   - provider returned ok=false      -> failed
    //   - no provider configured          -> queued (waiting for ops
    //                                       to wire SendGrid or webhook)
    //   - provider threw                  -> failed
    const configured = !!result;
    const newStatus = !configured
      ? "queued"
      : (result.ok ? "sent" : "failed");
    await svc.from("communications").update({
      status: newStatus,
      sent_at: newStatus === "sent" ? new Date().toISOString() : row.sent_at || null,
      metadata: {
        ...(row.metadata || {}),
        provider: result?.provider || (configured ? "manual" : "none"),
        provider_status: result?.status || null,
        last_error: lastError ? String(lastError.message || lastError).slice(0, 240) : null,
        reaped_by: "agents/run",
      },
    }).eq("id", row.id);
    if (newStatus === "sent") fired++;
    else if (newStatus === "failed") errors++;
    // queued doesn't count as fired or errored, the next reap retries.
    // Audit so the meter sees it.
    await svc.from("audit_events").insert({
      tenant_id: tenantId,
      action: "comm_send",
      object_type: "communication",
      object_id: row.id,
      detail: (result?.provider || "manual") + "::" + newStatus,
    });
  }
  return { fired, errors };
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
    // Reap queued comms across every tenant we just touched. The
    // agent's send_email actions enqueue them; this fires them. We
    // dedupe tenants so a tenant with N agents triggers one reap.
    const touchedTenants = Array.from(new Set((goals || []).map((g) => g.tenant_id)));
    const reaped = [];
    for (const tid of touchedTenants) {
      const r = await reapQueuedCommsForTenant(svc, tid);
      reaped.push({ tenant_id: tid, fired: r.fired, errors: r.errors });
    }

    return json(res, 200, {
      ran_at: new Date().toISOString(),
      considered: (goals || []).length,
      results,
      reaped,
    });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
}
