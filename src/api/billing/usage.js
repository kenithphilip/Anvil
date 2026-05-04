// GET /api/billing/usage
//
// Returns this tenant's outcome counts over a configurable window.
// Query params:
//   from   ISO date or "month-to-date" (default month-to-date)
//   to     ISO date (default now)
//
// Aggregates `audit_events` rows whose `action` maps to a known outcome
// (see _lib/outcomes.js). Rows for unmapped actions are ignored. The
// response is the per-outcome count plus a usd_cents subtotal computed
// from the public price card. Customer-facing.

import { applyCors, handlePreflight, json } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import {
  ACTION_TO_OUTCOME,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  OUTCOME_UNIT_PRICE_CENTS,
} from "../_lib/outcomes.js";

const startOfMonth = (d) => {
  const out = new Date(d);
  out.setUTCDate(1);
  out.setUTCHours(0, 0, 0, 0);
  return out;
};

const parseFrom = (raw) => {
  if (!raw || raw === "month-to-date") return startOfMonth(new Date());
  const d = new Date(raw);
  if (isNaN(d.getTime())) return startOfMonth(new Date());
  return d;
};

const parseTo = (raw) => {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (isNaN(d.getTime())) return new Date();
  return d;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const from = parseFrom(req.query?.from);
    const to = parseTo(req.query?.to);
    if (from.getTime() > to.getTime()) {
      return json(res, 400, { error: { message: "from must be on or before to" } });
    }
    const svc = serviceClient();

    const knownActions = Object.keys(ACTION_TO_OUTCOME);
    const { data, error } = await svc
      .from("audit_events")
      .select("action, created_at")
      .eq("tenant_id", ctx.tenantId)
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString())
      .in("action", knownActions);
    if (error) throw new Error("audit_events read: " + error.message);

    const counts = Object.fromEntries(OUTCOME_ORDER.map((k) => [k, 0]));
    for (const row of data || []) {
      const outcome = ACTION_TO_OUTCOME[row.action];
      if (outcome) counts[outcome] = (counts[outcome] || 0) + 1;
    }

    let totalCents = 0;
    const lines = OUTCOME_ORDER.map((id) => {
      const count = counts[id] || 0;
      const unitCents = OUTCOME_UNIT_PRICE_CENTS[id] || 0;
      const subtotalCents = count * unitCents;
      totalCents += subtotalCents;
      return {
        id,
        label: OUTCOME_LABELS[id] || id,
        count,
        unit_price_cents: unitCents,
        subtotal_cents: subtotalCents,
      };
    });

    return json(res, 200, {
      tenant_id: ctx.tenantId,
      from: from.toISOString(),
      to: to.toISOString(),
      lines,
      total_cents: totalCents,
      total_outcomes: lines.reduce((s, l) => s + l.count, 0),
      currency: "USD",
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
}
