// POST /api/delivery/promise
// Body: {
//   customerId?,
//   sourcePos: [{ country, supplier?, productCategory?, baseDate? }],
//   requestedDate?,
//   internalLeadDays?
// }
// Returns: predicted ship date, risk class, and per-source breakdown.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { addBusinessDays, buildHolidaySet, parseISODate, todayUTC } from "../_lib/datemath.js";

const COUNTRY_NORMALIZE = {
  india: "IN", in: "IN", "o-india": "IN",
  china: "CN", cn: "CN", "o-china": "CN",
  japan: "JP", jp: "JP", "o-japan": "JP",
  korea: "KR", "south korea": "KR", kr: "KR", "o-korea": "KR",
  external: "US", us: "US", usa: "US", external_supplier: "US",
};

const normalizeCountry = (raw) => {
  const key = String(raw || "").trim().toLowerCase();
  return COUNTRY_NORMALIZE[key] || (key.length === 2 ? key.toUpperCase() : "US");
};

const riskClass = (gapDays) => {
  if (gapDays == null) return "amber";
  if (gapDays >= 5) return "green";
  if (gapDays >= 0) return "amber";
  return "red";
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const sources = Array.isArray(body.sourcePos) ? body.sourcePos : [];
    if (!sources.length) return json(res, 400, { error: { message: "sourcePos array required" } });
    const requestedDate = parseISODate(body.requestedDate) || null;
    const svc = serviceClient();

    // Customer lead time (could be product-category specific later).
    const customerId = body.customerId || null;
    let customerLeadDays = null;
    if (customerId) {
      const cust = await svc.from("customer_lead_times").select("lead_days").eq("tenant_id", ctx.tenantId).eq("customer_id", customerId).maybeSingle();
      if (cust.data && cust.data.lead_days != null) customerLeadDays = Number(cust.data.lead_days);
    }
    const internalLead = Number(body.internalLeadDays != null ? body.internalLeadDays : (customerLeadDays != null ? customerLeadDays : 3));

    // Pull supplier defaults and holiday calendar in one round trip.
    const countryCodes = Array.from(new Set(sources.map((s) => normalizeCountry(s.country))));
    const supplierLookup = await svc.from("supplier_lead_times").select("country, supplier, product_category, lead_days").eq("tenant_id", ctx.tenantId).in("country", countryCodes);
    const tenantHolidays = await svc.from("holiday_calendar").select("country, date, name").or("tenant_id.is.null,tenant_id.eq." + ctx.tenantId).in("country", countryCodes.concat(["IN"]));
    const supplierMap = new Map();
    (supplierLookup.data || []).forEach((row) => {
      const key = (row.country || "").toUpperCase() + "|" + (row.supplier || "*") + "|" + (row.product_category || "*");
      supplierMap.set(key, Number(row.lead_days) || 0);
    });
    const holidaySet = buildHolidaySet(tenantHolidays.data || []);

    const breakdown = [];
    for (const src of sources) {
      const country = normalizeCountry(src.country);
      const supplier = src.supplier || "*";
      const cat = src.productCategory || "*";
      const candidateKeys = [
        country + "|" + supplier + "|" + cat,
        country + "|" + supplier + "|*",
        country + "|*|" + cat,
        country + "|*|*",
      ];
      let leadDays = null;
      for (const key of candidateKeys) {
        if (supplierMap.has(key)) { leadDays = supplierMap.get(key); break; }
      }
      if (leadDays == null) leadDays = country === "IN" ? 7 : country === "KR" ? 14 : country === "CN" || country === "JP" ? 21 : 30;
      const baseDate = parseISODate(src.baseDate) || todayUTC();
      const supplierEta = addBusinessDays(baseDate, leadDays, country, holidaySet);
      const finalEta = addBusinessDays(parseISODate(supplierEta.date), internalLead, "IN", holidaySet);
      breakdown.push({
        country,
        supplier: src.supplier || null,
        leadDays,
        supplierEta: supplierEta.date,
        skippedSupplierHolidays: supplierEta.skipped,
        internalEta: finalEta.date,
        skippedInternalHolidays: finalEta.skipped,
      });
    }
    breakdown.sort((a, b) => (a.internalEta > b.internalEta ? -1 : 1));
    const promised = breakdown[0];
    const promiseDate = promised ? promised.internalEta : null;
    const gapDays = (() => {
      if (!requestedDate || !promiseDate) return null;
      const target = parseISODate(promiseDate);
      const diff = (requestedDate.getTime() - target.getTime()) / (24 * 3600 * 1000);
      return Math.round(diff);
    })();

    const result = {
      predictedShipDate: promiseDate,
      requestedDate: requestedDate ? requestedDate.toISOString().slice(0, 10) : null,
      gapDays,
      risk: riskClass(gapDays),
      breakdown,
      internalLeadDays: internalLead,
    };
    await recordAudit(ctx, { action: "delivery_promise", objectType: "order", objectId: customerId || null, detail: "promise=" + promiseDate + " risk=" + result.risk });
    return json(res, 200, result);
  } catch (err) {
    sendError(res, err);
  }
}
