// GET /api/sap/diagnostics
// Probes 7 SAP services and reports per-entity status + latency.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { sapDecryptCreds, sapFetch, sapIsConfigured } from "../_lib/sap-client.js";

const PROBES = [
  { entity: "business_partner", path: "/sap/opu/odata4/sap/api_business_partner/srvd_a2x/sap/businesspartner/0001/A_BusinessPartner" },
  { entity: "material",         path: "/sap/opu/odata4/sap/api_product_srv/srvd_a2x/sap/product/0001/Product" },
  { entity: "sales_order",      path: "/sap/opu/odata4/sap/api_sales_order_srv/srvd_a2x/sap/salesorder/0001/A_SalesOrder" },
  { entity: "purchase_order",   path: "/sap/opu/odata4/sap/api_purchaseorder_process_srv/srvd_a2x/sap/purchaseorder/0001/A_PurchaseOrder" },
  { entity: "plant",            path: "/sap/opu/odata4/sap/api_plant_srv/srvd_a2x/sap/plant/0001/Plant" },
  { entity: "currency",         path: "/sap/opu/odata4/sap/api_currency_srv/srvd_a2x/sap/currency/0001/Currency" },
  { entity: "inventory",        path: "/sap/opu/odata4/sap/api_material_stock_srv/srvd_a2x/sap/materialstock/0001/MaterialStock" },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = sapDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!sapIsConfigured(settings)) {
      return json(res, 200, { configured: false, probes: [], notes: ["SAP not configured"] });
    }
    const out = [];
    for (const p of PROBES) {
      const t0 = Date.now();
      try {
        const r = await sapFetch(settings, { method: "GET", path: p.path, query: { $top: "1" } });
        out.push({
          entity: p.entity, ok: r.ok, status: r.status,
          latency_ms: Date.now() - t0,
          rows_returned: (r.body?.value || []).length,
          error: r.ok ? null : (r.body?.error?.message || r.body?.error || r.body?.raw),
        });
      } catch (err) {
        out.push({ entity: p.entity, ok: false, status: 0, latency_ms: Date.now() - t0, rows_returned: 0, error: err.message });
      }
    }
    const allOk = out.every((p) => p.ok);
    return json(res, 200, {
      configured: true,
      base_url: settings.sap_base_url,
      probes: out,
      summary: { all_ok: allOk, total: out.length, failed: out.filter((p) => !p.ok).length },
      ran_at: new Date().toISOString(),
    });
  } catch (err) { sendError(res, err); }
}
