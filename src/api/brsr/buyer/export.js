// GET /api/brsr/buyer/export?fy=FY2025-26&format=csv|xbrl
//
// Buyer-side export for the listed-company tier. Two formats:
//
//   csv  : SEBI BRSR Core Annexure I shaped CSV. Column order is
//          fixed (Sr.No. | Attribute | Parameter | Unit | FY current
//          | FY previous | Approach). One row per supplier per
//          attribute, with a buyer-summary row at the foot.
//
//   xbrl : Stub XBRL instance using a placeholder namespace
//          (urn:sebi:brsr-core:2025-stub) until SEBI publishes the
//          official taxonomy. The HTTP response carries an
//          X-BRSR-Schema-Status header so consumers can detect
//          stub responses. Header docs the limitation.
//
// CSV is the P0 deliverable; the listed buyer can upload it
// through NSE/BSE's existing portal flow. XBRL is forward-
// compatible scaffolding.
//
// RBAC: admin / finance only (export is the buyer's monetised
// path).

import { applyCors, handlePreflight, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";

// SEBI BRSR Core Annexure I attribute / parameter / unit
// tuples. Column ordering matches the PDF Annexure: each row is
// (attribute_no, attribute_label, parameter, unit, source_field).
// `source_field` names the column on supplier_disclosures that
// holds the value. Some rows are derived (intensity per Rs revenue
// = scope/revenue), marked with `derived`.
const ANNEXURE_I = [
  // 1. GHG footprint
  { sr: 1.1, attr: "Greenhouse gas footprint",  param: "Total Scope 1 emissions",                 unit: "tCO2e",          field: "scope1_tco2e" },
  { sr: 1.2, attr: "Greenhouse gas footprint",  param: "Total Scope 2 emissions",                 unit: "tCO2e",          field: "scope2_tco2e" },
  { sr: 1.3, attr: "Greenhouse gas footprint",  param: "Total Scope 1+2 intensity per Rs revenue", unit: "tCO2e/Rs",      field: null, derived: "intensity_total" },
  // 2. Water footprint
  { sr: 2.1, attr: "Water footprint",           param: "Water withdrawal",                        unit: "kilolitres",     field: "water_withdrawal_kl" },
  { sr: 2.2, attr: "Water footprint",           param: "Water consumption",                       unit: "kilolitres",     field: "water_consumption_kl" },
  { sr: 2.3, attr: "Water footprint",           param: "Water discharge",                         unit: "kilolitres",     field: "water_discharge_kl" },
  // 3. Energy footprint
  { sr: 3.1, attr: "Energy footprint",          param: "Total electricity consumption",           unit: "kWh",            field: "electricity_kwh" },
  { sr: 3.2, attr: "Energy footprint",          param: "Renewable share",                         unit: "%",              field: "electricity_renewable_pct" },
  // 4. Embracing circularity
  { sr: 4.1, attr: "Embracing circularity",     param: "Total waste generated",                   unit: "metric tonnes",  field: "waste_total_mt" },
  { sr: 4.2, attr: "Embracing circularity",     param: "Waste recycled / reused",                 unit: "metric tonnes",  field: "waste_recycled_mt" },
  { sr: 4.3, attr: "Embracing circularity",     param: "Waste sent to disposal",                  unit: "metric tonnes",  field: "waste_disposed_mt" },
  // 5. Enabling gender diversity
  { sr: 5.1, attr: "Enabling gender diversity", param: "Women in workforce",                      unit: "%",              field: "women_pct_workforce" },
  { sr: 5.2, attr: "Enabling gender diversity", param: "Women in KMP",                            unit: "%",              field: "women_pct_kmp" },
  { sr: 5.3, attr: "Enabling gender diversity", param: "POSH complaints filed",                   unit: "count",          field: "posh_complaints" },
  // 6. Inclusive development
  { sr: 6.1, attr: "Inclusive development",     param: "Input material from MSMEs",               unit: "%",              field: "msme_input_pct" },
  { sr: 6.2, attr: "Inclusive development",     param: "Input material sourced within India",     unit: "%",              field: "india_sourcing_pct" },
  // 7. Fairness in engagement
  { sr: 7.1, attr: "Fairness in engagement",    param: "Anti-competitive complaints",             unit: "count",          field: "anti_competitive_complaints" },
  { sr: 7.2, attr: "Fairness in engagement",    param: "Privacy / cybersecurity breaches",        unit: "count",          field: "privacy_breaches" },
  { sr: 7.3, attr: "Fairness in engagement",    param: "Deductions / penalties on suppliers",     unit: "%",              field: "supplier_deductions_pct" },
  // 8. Openness of business
  { sr: 8.1, attr: "Openness of business",      param: "Related-party share of purchases",        unit: "%",              field: "related_party_purchases_pct" },
  // 9. Wages + smaller-town jobs
  { sr: 9.1, attr: "Wages + smaller-town jobs", param: "Wages paid to women",                     unit: "Rs",             field: "wages_paid_to_women_inr" },
  { sr: 9.2, attr: "Wages + smaller-town jobs", param: "Wages paid in tier 3-6 cities",           unit: "Rs",             field: "wages_paid_smaller_towns_inr" },
];

const csvEscape = (s) => {
  if (s == null) return "";
  const v = String(s);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

const valueAt = (disc, row, intensityCache) => {
  if (!disc) return null;
  if (row.derived === "intensity_total") {
    if (intensityCache != null) return intensityCache;
    const s1 = Number(disc.scope1_tco2e) || 0;
    const s2 = Number(disc.scope2_tco2e) || 0;
    const rev = Number(disc.revenue_inr) || 0;
    return rev > 0 ? ((s1 + s2) / rev).toFixed(9) : null;
  }
  if (!row.field) return null;
  return disc[row.field];
};

const buildCsv = ({ suppliers, fy, prevFy, buyerTenantId }) => {
  const header = [
    "Sr.No.",
    "Attribute",
    "Parameter",
    "Unit",
    "FY " + (fy || "current"),
    "FY " + (prevFy || "previous"),
    "Approach",
    "Supplier",
    "Supplier share % of buyer purchases",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const s of suppliers) {
    const cur = s.current_disclosure;
    const prev = s.prev_disclosure;
    for (const row of ANNEXURE_I) {
      lines.push([
        row.sr,
        row.attr,
        row.param,
        row.unit,
        valueAt(cur, row),
        valueAt(prev, row),
        cur ? "self-disclosed via Anvil" : "no submission",
        s.supplier_tenant_id,
        s.share_pct,
      ].map(csvEscape).join(","));
    }
  }
  // Buyer-summary row.
  lines.push(["", "Buyer summary", "Reporting suppliers", "count",
              suppliers.filter((s) => s.current_disclosure).length,
              null, "computed", buyerTenantId, null].map(csvEscape).join(","));
  return lines.join("\n") + "\n";
};

// XBRL stub. Uses a placeholder namespace that will be swapped
// when SEBI publishes the real taxonomy. The shape is intentionally
// flat (one Fact per (supplier, parameter)) so the swap is a
// namespace rename, not a structural rewrite.
const buildXbrlStub = ({ suppliers, fy, buyerTenantId }) => {
  const xmlEscape = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const facts = [];
  for (const s of suppliers) {
    if (!s.current_disclosure) continue;
    const cur = s.current_disclosure;
    for (const row of ANNEXURE_I) {
      const v = valueAt(cur, row);
      if (v == null || v === "") continue;
      facts.push(
        `  <brsr:Fact supplierTenantId="${xmlEscape(s.supplier_tenant_id)}" sr="${row.sr}" attribute="${xmlEscape(row.attr)}" parameter="${xmlEscape(row.param)}" unit="${xmlEscape(row.unit)}">${xmlEscape(v)}</brsr:Fact>`,
      );
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Stub instance: SEBI BRSR Core XBRL taxonomy not yet published. -->',
    '<!-- Namespace urn:sebi:brsr-core:2025-stub is a placeholder. -->',
    `<brsr:Instance xmlns:brsr="urn:sebi:brsr-core:2025-stub" fy="${xmlEscape(fy || "")}" buyerTenantId="${xmlEscape(buyerTenantId)}">`,
    ...facts,
    "</brsr:Instance>",
  ].join("\n") + "\n";
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    return;
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const url = new URL(req.url, "http://_");
    const fy = url.searchParams.get("fy") || null;
    const format = (url.searchParams.get("format") || "csv").toLowerCase();
    if (format !== "csv" && format !== "xbrl") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "format must be csv or xbrl" } }));
      return;
    }
    const svc = serviceClient();

    // Suppliers we have an accepted relationship with.
    const rels = await svc.from("value_chain_relationships").select("*")
      .eq("buyer_tenant_id", ctx.tenantId)
      .eq("consent_status", "accepted");
    if (rels.error) throw new Error(rels.error.message);
    const supplierIds = (rels.data || []).map((r) => r.supplier_tenant_id);
    const supplierShare = Object.fromEntries(
      (rels.data || []).map((r) => [r.supplier_tenant_id, Number(r.buyer_purchase_share_pct) || 0]),
    );

    // Current + previous FY periods for each supplier.
    let curPeriodsQ = svc.from("supplier_disclosure_periods")
      .select("id, tenant_id, fiscal_year")
      .in("tenant_id", supplierIds.length ? supplierIds : ["00000000-0000-0000-0000-000000000000"]);
    if (fy) curPeriodsQ = curPeriodsQ.eq("fiscal_year", fy);
    const curPeriods = await curPeriodsQ;
    if (curPeriods.error) throw new Error(curPeriods.error.message);
    const curPeriodIdByTenant = new Map();
    for (const p of (curPeriods.data || [])) curPeriodIdByTenant.set(p.tenant_id, p.id);

    const curDisc = curPeriodIdByTenant.size
      ? await svc.from("supplier_disclosures").select("*")
          .in("period_id", Array.from(curPeriodIdByTenant.values()))
      : { data: [] };
    if (curDisc.error) throw new Error(curDisc.error.message);
    const curDiscByTenant = new Map();
    for (const d of (curDisc.data || [])) curDiscByTenant.set(d.tenant_id, d);

    // Previous FY: pick the lexically next FY string down.
    // "FY2025-26" -> "FY2024-25".
    let prevFy = null;
    if (fy) {
      const m = fy.match(/^FY(\d{4})-(\d{2})$/);
      if (m) {
        const a = parseInt(m[1], 10) - 1;
        const b = parseInt(m[2], 10) - 1;
        prevFy = "FY" + a + "-" + String(b).padStart(2, "0");
      }
    }
    let prevDiscByTenant = new Map();
    if (prevFy) {
      const prevPeriods = await svc.from("supplier_disclosure_periods")
        .select("id, tenant_id")
        .eq("fiscal_year", prevFy)
        .in("tenant_id", supplierIds.length ? supplierIds : ["00000000-0000-0000-0000-000000000000"]);
      if (!prevPeriods.error && prevPeriods.data?.length) {
        const ids = prevPeriods.data.map((p) => p.id);
        const prevDisc = await svc.from("supplier_disclosures").select("*").in("period_id", ids);
        if (!prevDisc.error) {
          for (const d of (prevDisc.data || [])) prevDiscByTenant.set(d.tenant_id, d);
        }
      }
    }

    const suppliers = supplierIds.map((sid) => ({
      supplier_tenant_id: sid,
      share_pct: supplierShare[sid] ?? 0,
      current_disclosure: curDiscByTenant.get(sid) || null,
      prev_disclosure: prevDiscByTenant.get(sid) || null,
    }));

    await recordAudit(ctx, {
      action: "brsr.export." + format,
      objectType: "buyer_export",
      objectId: null,
      detail: { fiscal_year: fy, suppliers: suppliers.length },
    });

    if (format === "csv") {
      const body = buildCsv({ suppliers, fy, prevFy, buyerTenantId: ctx.tenantId });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("X-BRSR-Schema-Status", "annexure-i-row-shape");
      res.setHeader("Content-Disposition",
        `attachment; filename="brsr-core-${fy || "all"}.csv"`);
      res.end(body);
      return;
    }
    const body = buildXbrlStub({ suppliers, fy, buyerTenantId: ctx.tenantId });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("X-BRSR-Schema-Status", "stub-namespace-pending-sebi-taxonomy");
    res.setHeader("Content-Disposition",
      `attachment; filename="brsr-core-${fy || "all"}.xbrl"`);
    res.end(body);
  } catch (err) { sendError(res, err); }
}

export const __test = { ANNEXURE_I, buildCsv, buildXbrlStub, valueAt };
