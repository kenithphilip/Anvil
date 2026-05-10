// GET  /api/brsr/period?fy=FY2025-26&cadence=annual
// POST /api/brsr/period   { fiscal_year, cadence, period_start, period_end }
//
// Read or create a supplier-disclosure period. Annual default; the
// 1-April auto-roll cron creates next FY's period.
//
// RBAC: read for everyone with read on brsr; write for admin only
// (period rows constrain the audit ledger).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const VALID_CADENCE = new Set(["annual", "quarterly"]);

// "FY2025-26" parses to { fy: 2025, start: 2025-04-01, end: 2026-03-31 }.
// Indian fiscal year runs Apr 1 to Mar 31.
const parseFy = (fy) => {
  const m = String(fy || "").match(/^FY(\d{4})-(\d{2})$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  return { fy: start, start, end: start + 1 };
};

const defaultPeriodFor = (fy, cadence) => {
  const parsed = parseFy(fy);
  if (!parsed) return null;
  if (cadence === "annual") {
    return {
      period_start: `${parsed.start}-04-01`,
      period_end: `${parsed.end}-03-31`,
    };
  }
  // Quarterly: caller supplies start/end explicitly; we leave
  // computing the four sub-periods to the caller.
  return null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const url = new URL(req.url, "http://_");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const fy = url.searchParams.get("fy");
      const cadence = url.searchParams.get("cadence") || "annual";
      let q = svc.from("supplier_disclosure_periods").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("period_start", { ascending: false });
      if (fy) q = q.eq("fiscal_year", fy);
      if (cadence) q = q.eq("cadence", cadence);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { periods: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const fy = String(body.fiscal_year || "");
      const cadence = body.cadence || "annual";
      if (!VALID_CADENCE.has(cadence)) {
        return json(res, 400, { error: { message: "cadence must be annual or quarterly" } });
      }
      const parsed = parseFy(fy);
      if (!parsed) {
        return json(res, 400, { error: { message: "fiscal_year must match FYYYYY-YY (e.g. FY2025-26)" } });
      }
      const defaults = defaultPeriodFor(fy, cadence);
      const row = {
        tenant_id: ctx.tenantId,
        fiscal_year: fy,
        cadence,
        period_start: body.period_start || defaults?.period_start,
        period_end: body.period_end || defaults?.period_end,
        status: "open",
      };
      if (!row.period_start || !row.period_end) {
        return json(res, 400, { error: { message: "period_start and period_end required for quarterly" } });
      }
      const up = await svc.from("supplier_disclosure_periods")
        .upsert(row, { onConflict: "tenant_id,fiscal_year,cadence,period_start" })
        .select("*").maybeSingle();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, {
        action: "brsr.period.created",
        objectType: "supplier_disclosure_period",
        objectId: up.data?.id,
        detail: { fiscal_year: fy, cadence },
      });
      return json(res, 200, { period: up.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}

// Exported for tests + cron.
export const __test = { parseFy, defaultPeriodFor };
