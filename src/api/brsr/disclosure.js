// /api/brsr/disclosure
//   GET    ?period_id=...           read the supplier's row
//   POST   { period_id, ...fields } upsert (draft)
//   POST   /submit { period_id }    lock the period
//
// All writes recompute Scope 1 + Scope 2 server-side using
// india_emission_factors so the client cannot send fabricated
// tCO2e values. Submit transitions the period to status='submitted'
// and stamps attestation metadata.
//
// RBAC: read for any user with read on brsr; write for admin only.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  buildFactorMap, computeAllScopes,
} from "../_lib/brsr/emission_factors.js";

// Whitelist of fields the client may set directly. Anything not
// in this list is silently ignored. Scope1/Scope2 are NOT in this
// list because we compute them server-side.
const CLIENT_WRITABLE = new Set([
  "electricity_kwh", "electricity_renewable_pct",
  "diesel_litres", "petrol_litres", "natural_gas_scm",
  "water_withdrawal_kl", "water_consumption_kl", "water_discharge_kl",
  "waste_total_mt", "waste_recycled_mt", "waste_disposed_mt",
  "women_pct_workforce", "women_pct_kmp", "women_pct_board",
  "posh_complaints", "ehs_lost_time_injuries", "ehs_fatalities",
  "gross_wages_inr", "wages_paid_to_women_inr", "wages_paid_smaller_towns_inr",
  "return_to_work_after_parental_pct",
  "msme_input_pct", "india_sourcing_pct", "related_party_purchases_pct",
  "anti_competitive_complaints", "privacy_breaches", "supplier_deductions_pct",
  "pollution_consent_valid", "factory_act_compliant", "cyber_security_breaches",
  "revenue_inr", "extra",
]);

const pickWritable = (body) => {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (CLIENT_WRITABLE.has(k)) out[k] = body[k];
  }
  return out;
};

// Pulls the current india_emission_factors set for the period's
// fiscal year. Caches at module scope per (process, fy) so we
// don't requery on every disclosure write. Refresh on
// re-import (vitest) is automatic.
const factorCache = new Map();
const loadFactors = async (svc, fy) => {
  if (factorCache.has(fy)) return factorCache.get(fy);
  const r = await svc.from("india_emission_factors")
    .select("fuel_type, factor, unit, source, effective_fy");
  if (r.error) throw new Error("emission_factors: " + r.error.message);
  const map = buildFactorMap(r.data || [], fy);
  factorCache.set(fy, map);
  return map;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    // /api/brsr/disclosure[/submit]
    const action = segments[3];

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const periodId = url.searchParams.get("period_id");
      if (!periodId) {
        return json(res, 400, { error: { message: "period_id required" } });
      }
      const r = await svc.from("supplier_disclosures").select("*")
        .eq("tenant_id", ctx.tenantId).eq("period_id", periodId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { disclosure: r.data || null });
    }

    if (req.method === "POST" && action === "submit") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const periodId = body.period_id;
      if (!periodId) {
        return json(res, 400, { error: { message: "period_id required" } });
      }
      // Snapshot of the period; must not already be locked.
      const period = await svc.from("supplier_disclosure_periods")
        .select("*").eq("tenant_id", ctx.tenantId).eq("id", periodId).maybeSingle();
      if (period.error) throw new Error(period.error.message);
      if (!period.data) return json(res, 404, { error: { message: "period not found" } });
      if (period.data.status === "locked" || period.data.status === "assured") {
        return json(res, 409, {
          error: { message: "period " + period.data.status + " already" },
        });
      }
      // Pull the disclosure to make sure something was filled.
      const disc = await svc.from("supplier_disclosures")
        .select("id").eq("tenant_id", ctx.tenantId).eq("period_id", periodId).maybeSingle();
      if (!disc.data) {
        return json(res, 409, { error: { message: "no disclosure row for this period; save before submit" } });
      }
      const now = new Date().toISOString();
      const upd = await svc.from("supplier_disclosure_periods")
        .update({
          status: "submitted",
          submitted_at: now,
          attestation_user_id: ctx.user?.id || null,
          attestation_text: body.attestation_text || null,
          attestation_role: body.attestation_role || null,
        })
        .eq("tenant_id", ctx.tenantId).eq("id", periodId)
        .select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "brsr.disclosure.submitted",
        objectType: "supplier_disclosure_period",
        objectId: periodId,
        detail: { fiscal_year: period.data.fiscal_year, cadence: period.data.cadence },
      });
      return json(res, 200, { period: upd.data });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const periodId = body.period_id;
      if (!periodId) {
        return json(res, 400, { error: { message: "period_id required" } });
      }
      // Guard: must not be locked or assured.
      const period = await svc.from("supplier_disclosure_periods")
        .select("id, fiscal_year, status").eq("tenant_id", ctx.tenantId)
        .eq("id", periodId).maybeSingle();
      if (period.error) throw new Error(period.error.message);
      if (!period.data) return json(res, 404, { error: { message: "period not found" } });
      if (period.data.status === "locked" || period.data.status === "assured") {
        return json(res, 409, {
          error: { message: "period " + period.data.status + " already; cannot edit" },
        });
      }
      // Compute Scope 1 + Scope 2 server-side from the volumes
      // before persisting. Frontend may have shown its own
      // preview; the DB row is the system of record.
      const factors = await loadFactors(svc, period.data.fiscal_year);
      const writable = pickWritable(body);
      const scopes = computeAllScopes({
        electricity_kwh: writable.electricity_kwh,
        electricity_renewable_pct: writable.electricity_renewable_pct,
        diesel_litres: writable.diesel_litres,
        petrol_litres: writable.petrol_litres,
        natural_gas_scm: writable.natural_gas_scm,
        revenue_inr: writable.revenue_inr,
      }, factors);
      const row = {
        tenant_id: ctx.tenantId,
        period_id: periodId,
        ...writable,
        scope1_tco2e: scopes.scope1_tco2e,
        scope2_tco2e: scopes.scope2_tco2e,
        updated_at: new Date().toISOString(),
      };
      const up = await svc.from("supplier_disclosures")
        .upsert(row, { onConflict: "tenant_id,period_id" })
        .select("*").maybeSingle();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, {
        action: "brsr.disclosure.saved",
        objectType: "supplier_disclosure",
        objectId: up.data?.id,
        detail: {
          period_id: periodId,
          scope1: scopes.scope1_tco2e,
          scope2: scopes.scope2_tco2e,
        },
      });
      return json(res, 200, {
        disclosure: up.data,
        computed: scopes,
      });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}

export const __test = { CLIENT_WRITABLE, pickWritable };
