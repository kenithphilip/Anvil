// The server runs the anomaly rules (plan PR 8, audit F7).
//
// The rule library (/api/anomaly/compute: rate, margin, GST, credit, alias and
// hygiene) ran only when someone clicked "run validation". When nobody did,
// the approver saw no anomaly at all, and #600's exceptions list carried an
// "Anomaly check not run" row. autoReconcileOrder now runs it at its end, on
// the server, through the same runAnomalyRules the button's endpoint calls,
// and stores the result where the button stores it:
//   rule_findings                      the flags, one per rule hit
//   preflight_payload.last_validated_at  when, which the exceptions list and
//                                        the workspace stepper read
//   preflight_payload.rules_evaluated    how many rules the library holds
// plus preflight_payload.anomaly_check, the record that makes it run once
// per payload hash and customer.
//
// The rules:
//   - Before approval only: DRAFT, PENDING_REVIEW, BLOCKED. An approved
//     order is what the approver signed off.
//   - Once per payload: the payload hash and the customer it ran for are
//     recorded, and a re-run on the same pair does nothing.
//   - It replaces only the rule library's own findings. Blockers, the -MOD
//     finding and anything resolved are kept as they are.
//   - Compare-and-set on updated_at: a save that lands while it runs is not
//     overwritten, and that newer save runs its own check.
//   - Never blocking, never throwing: autoAnomalyCheck has a time budget,
//     and a failure is an event on the order, not a failed save.
//   - The cost rules run only when the person whose save triggered it may see
//     cost (cost.view), as for the button. A background job has no person,
//     so it runs without them.

import { recordEvent } from "./audit.js";
import { hasAction } from "./auth.js";
import { computeOrderPayloadHash } from "./payload-hash.js";
import { runAnomalyRules } from "../anomaly/compute.js";

// The same statuses as the reconcile's server trigger (order-reconcile.js
// AUTO_RECONCILE_STATUSES). Kept here: order-reconcile.js imports this file.
export const ANOMALY_CHECK_STATUSES = new Set(["DRAFT", "PENDING_REVIEW", "BLOCKED"]);

// Upper bound on how long a save waits for the check. The rule library reads
// the customer's last 40 orders and the tenant's last 200.
export const ANOMALY_CHECK_BUDGET_MS = 4000;

// A finding the rule library wrote: { key, label, severity, detail,
// lineIndex }. Findings with a code (blockers, the -MOD finding, extraction
// findings) come from elsewhere and are never the library's to replace.
export const isAnomalyRuleFinding = (f) =>
  !!f && typeof f === "object" && !f.code && !f.rule_id && typeof f.key === "string" && f.key.length > 0;

const linesOf = (order) => (Array.isArray(order?.result?.salesOrder?.lineItems) ? order.result.salesOrder.lineItems : []);

// One run. Returns { status, flags? }:
//   checked     the rules ran and the result was stored
//   unchanged   they already ran for this payload hash and customer
//   superseded  a newer write landed meanwhile; nothing was stored
//   skipped     the order is past approval (or not in a reviewable status)
//   not_found / no_customer / no_lines
// Throws on a database error. Every query is scoped to ctx.tenantId.
export const runOrderAnomalyCheck = async (svc, ctx, orderId, opts = {}) => {
  if (!ctx || !ctx.tenantId) throw new Error("anomaly check: tenant required");
  if (!orderId) return { status: "not_found" };
  const q = await svc.from("orders")
    .select("id, status, updated_at, customer_id, po_number, result, rule_findings, preflight_payload")
    .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
  if (q.error) throw new Error("orders read: " + q.error.message);
  const order = q.data;
  if (!order) return { status: "not_found" };
  if (!ANOMALY_CHECK_STATUSES.has(order.status)) return { status: "skipped", reason: "status " + order.status };
  if (!order.customer_id) return { status: "no_customer" };
  const lines = linesOf(order);
  if (!lines.length) return { status: "no_lines" };

  const pf = order.preflight_payload && typeof order.preflight_payload === "object" ? order.preflight_payload : {};
  const hash = computeOrderPayloadHash(order);
  const prior = pf.anomaly_check || null;
  if (!opts.force && prior && prior.payload_hash === hash && String(prior.customer_id || "") === String(order.customer_id)) {
    return { status: "unchanged" };
  }

  // The candidate the button scores: the sales order with its lines.
  const candidate = { ...(order.result?.salesOrder || {}), lineItems: lines };
  const seesCost = hasAction(ctx, "cost.view");
  const out = await runAnomalyRules(svc, ctx.tenantId, order.customer_id, candidate, { seesCost });
  const flags = Array.isArray(out.flags) ? out.flags : [];

  const now = new Date().toISOString();
  const kept = (Array.isArray(order.rule_findings) ? order.rule_findings : []).filter((f) => !isAnomalyRuleFinding(f));
  const nextPreflight = {
    ...pf,
    last_validated_at: now,
    rules_evaluated: out.rulesEvaluated || null,
    anomaly_check: {
      payload_hash: hash,
      customer_id: order.customer_id,
      at: now,
      trigger: opts.trigger || "server",
      flags: flags.length,
      cost_rules: seesCost,
    },
  };
  let write = svc.from("orders")
    .update({ rule_findings: [...kept, ...flags], preflight_payload: nextPreflight })
    .eq("tenant_id", ctx.tenantId).eq("id", orderId);
  if (order.updated_at) write = write.eq("updated_at", order.updated_at);
  const upd = await write.select("id");
  if (upd.error) throw new Error("orders update: " + upd.error.message);
  if (Array.isArray(upd.data) && upd.data.length === 0) return { status: "superseded" };
  return { status: "checked", flags };
};

// The server trigger. Call it after the order's write (autoReconcileOrder does,
// at its end). It never throws and never fails the caller: an error or a run
// past the budget is recorded as an event on the order.
export const autoAnomalyCheck = async (svc, ctx, orderId, opts = {}) => {
  const trigger = opts.trigger || "server";
  if (!ctx || !ctx.tenantId || !orderId) return { status: "skipped", reason: "no tenant or order" };
  const budgetMs = opts.budgetMs != null ? opts.budgetMs : ANOMALY_CHECK_BUDGET_MS;
  const started = Date.now();
  let timer = null;
  let out;
  try {
    const run = runOrderAnomalyCheck(svc, ctx, orderId, { trigger });
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "timeout" }), budgetMs); });
    // A rejection after the budget is still handled: race subscribed to it.
    out = await Promise.race([run, late]);
  } catch (err) {
    out = { status: "failed", error: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (out.status === "failed" || out.status === "timeout") {
    console.warn("[order-anomaly-check] " + trigger + " " + out.status + " for order " + orderId + (out.error ? ": " + out.error : ""));
    try {
      await recordEvent(ctx, {
        caseId: orderId, eventType: "anomaly_check_" + out.status, objectType: "order", objectId: orderId,
        detail: { trigger, error: out.error || null, budget_ms: budgetMs, severity: "warn" },
        durationMs: Date.now() - started,
      });
    } catch { /* the console line above is the fallback record */ }
  }
  return out;
};
