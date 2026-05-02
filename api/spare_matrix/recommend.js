// POST /api/spare_matrix/recommend
// Body: { customer_id?, top_n? }
// Computes critical spare scoring and recommended stock qty using BOM, sales history,
// installed base, and supplier lead times. Persists to spare_recommendations.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const customerId = body.customer_id || null;
    const topN = Math.max(10, Math.min(500, Number(body.top_n || 100)));
    const svc = serviceClient();

    let ordersQ = svc.from("orders").select("id, customer_id, result, created_at").eq("tenant_id", ctx.tenantId).not("result", "is", null).order("created_at", { ascending: false }).limit(200);
    if (customerId) ordersQ = ordersQ.eq("customer_id", customerId);
    const orders = await ordersQ;
    if (orders.error) throw new Error(orders.error.message);

    const partUsage = new Map();
    (orders.data || []).forEach((o) => {
      const lines = (o.result && o.result.salesOrder && o.result.salesOrder.lineItems) || [];
      lines.forEach((li) => {
        const key = String(li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
        if (!key) return;
        const stat = partUsage.get(key) || { totalQty: 0, orderCount: 0, lastSeen: null, sourceCountry: null };
        stat.totalQty += Number(li.qty) || 0;
        stat.orderCount += 1;
        if (!stat.lastSeen || o.created_at > stat.lastSeen) stat.lastSeen = o.created_at;
        partUsage.set(key, stat);
      });
    });

    const bom = await svc.from("bill_of_materials").select("parent_part_no, child_part_no").eq("tenant_id", ctx.tenantId);
    const bomChildren = new Map();
    (bom.data || []).forEach((row) => {
      const key = String(row.child_part_no || "").toUpperCase();
      bomChildren.set(key, (bomChildren.get(key) || 0) + 1);
    });

    const supplierLeads = await svc.from("supplier_lead_times").select("country, lead_days").eq("tenant_id", ctx.tenantId);
    const leadByCountry = {};
    (supplierLeads.data || []).forEach((row) => { leadByCountry[(row.country || "").toUpperCase()] = Number(row.lead_days) || 14; });

    // Best-effort part->country mapping. Look at the most recent source PO line for each part.
    const partCountry = new Map();
    (orders.data || []).forEach((o) => {
      const sps = (o.result && o.result.sourcePOs) || [];
      sps.forEach((sp) => {
        const country = String((sp.seller && sp.seller.country) || sp.country || "").toUpperCase();
        if (!country) return;
        ((sp.lineItems) || []).forEach((li) => {
          const k = String(li.partNumber || li.partNo || li.tallyItemName || li.itemName || "").toUpperCase();
          if (!k) return;
          if (!partCountry.has(k)) partCountry.set(k, country);
        });
      });
    });

    const records = [];
    partUsage.forEach((stat, partNo) => {
      const usageScore = Math.min(40, stat.orderCount * 4);
      const bomScore = Math.min(20, (bomChildren.get(partNo) || 0) * 4);
      const recencyDays = stat.lastSeen ? Math.max(1, (Date.now() - new Date(stat.lastSeen).getTime()) / 86400000) : 365;
      const recencyScore = Math.max(0, 20 - Math.min(20, recencyDays / 18));
      // Lead score: parts sourced from longer-lead countries get HIGHER criticality (more important to stock locally).
      const country = partCountry.get(partNo);
      const leadDays = country && leadByCountry[country] != null ? leadByCountry[country] : 14;
      const leadScore = Math.max(0, Math.min(20, Math.round((leadDays / 30) * 20)));
      const score = usageScore + bomScore + recencyScore + leadScore;
      const recommendedQty = Math.max(1, Math.round(stat.totalQty / Math.max(1, stat.orderCount) * 1.5));
      records.push({
        tenant_id: ctx.tenantId,
        part_no: partNo,
        customer_id: customerId,
        criticality_score: Math.round(score * 100) / 100,
        recommended_qty: recommendedQty,
        reason: { usageScore, bomScore, recencyScore, leadScore, totalQty: stat.totalQty, orderCount: stat.orderCount, lastSeen: stat.lastSeen, country, leadDays },
      });
    });
    records.sort((a, b) => b.criticality_score - a.criticality_score);
    const top = records.slice(0, topN);
    if (top.length) {
      const upsert = await svc.from("spare_recommendations").upsert(top, { onConflict: "tenant_id,part_no,customer_id" });
      if (upsert.error) throw new Error(upsert.error.message);
    }
    await recordAudit(ctx, { action: "spare_matrix_recommend", objectType: "spare_matrix", objectId: customerId, detail: "computed=" + top.length });
    return json(res, 200, { computed: top.length, top });
  } catch (err) {
    sendError(res, err);
  }
}
