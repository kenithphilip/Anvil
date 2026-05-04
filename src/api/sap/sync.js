// POST or GET /api/sap/sync
//
// Pulls SAP S/4HANA mirror tables. Cron-only via Bearer CRON_SECRET,
// or manual via authenticated admin user. Manual body:
//   { entity?: "...", entities?: [...], full?: true }
//
// Entities (8): business_partner, material, sales_order,
// purchase_order, plant, currency, inventory, sales_order_status
// (reverse-sync of SOs we previously pushed).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { sapDecryptCreds, sapList, sapIsConfigured, sapFetch } from "../_lib/sap-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "sap";

const isoFromSap = (s) => {
  // SAP returns LastChangeDateTime as ISO 8601 (V4) or /Date(ms)/ (V2 legacy);
  // we only call V4 services so we expect ISO already.
  return s ? new Date(s).toISOString() : null;
};

const buildCursorFilter = (since, column = "LastChangeDateTime") =>
  since ? `${column} gt ${new Date(since).toISOString()}` : "";

const ENTITY = {
  business_partner: {
    path: "/sap/opu/odata4/sap/api_business_partner/srvd_a2x/sap/businesspartner/0001/A_BusinessPartner",
    cursorCol: "LastChangeDateTime",
    upsert: async (svc, tenantId, items) => {
      let updated = 0; let highWater = null;
      for (const r of items) {
        await svc.from("sap_business_partners").upsert({
          tenant_id: tenantId,
          external_id: String(r.BusinessPartner),
          name: r.BusinessPartnerFullName || r.OrganizationBPName1 || r.LastName || null,
          email: null,
          phone: null,
          category: r.BusinessPartnerCategory || null,
          is_blocked: r.SearchTerm1 === "BLOCKED",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = isoFromSap(r.LastChangeDateTime);
        if (t && (!highWater || t > highWater)) highWater = t;
      }
      return { updated, highWater };
    },
  },

  material: {
    path: "/sap/opu/odata4/sap/api_product_srv/srvd_a2x/sap/product/0001/Product",
    cursorCol: "LastChangeDateTime",
    upsert: async (svc, tenantId, items) => {
      let updated = 0; let highWater = null;
      for (const r of items) {
        await svc.from("sap_materials").upsert({
          tenant_id: tenantId,
          external_id: String(r.Product),
          description: r.ProductDescription || r.ProductType || null,
          base_uom: r.BaseUnit || null,
          material_group: r.ProductGroup || null,
          is_inactive: !!r.IsMarkedForDeletion,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = isoFromSap(r.LastChangeDateTime);
        if (t && (!highWater || t > highWater)) highWater = t;
      }
      return { updated, highWater };
    },
  },

  sales_order: {
    path: "/sap/opu/odata4/sap/api_sales_order_srv/srvd_a2x/sap/salesorder/0001/A_SalesOrder",
    cursorCol: "LastChangeDate",
    upsert: async (svc, tenantId, items) => {
      let updated = 0; let highWater = null;
      for (const r of items) {
        await svc.from("sap_sales_orders").upsert({
          tenant_id: tenantId,
          external_id: String(r.SalesOrder),
          customer_external_id: r.SoldToParty ? String(r.SoldToParty) : null,
          status: r.OverallSDProcessStatus || null,
          total: r.TotalNetAmount != null ? Number(r.TotalNetAmount) : null,
          currency: r.TransactionCurrency || null,
          ordered_at: r.SalesOrderDate ? new Date(r.SalesOrderDate).toISOString() : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = isoFromSap(r.LastChangeDate);
        if (t && (!highWater || t > highWater)) highWater = t;
      }
      return { updated, highWater };
    },
  },

  purchase_order: {
    path: "/sap/opu/odata4/sap/api_purchaseorder_process_srv/srvd_a2x/sap/purchaseorder/0001/A_PurchaseOrder",
    cursorCol: "LastChangeDateTime",
    upsert: async (svc, tenantId, items) => {
      let updated = 0; let highWater = null;
      for (const r of items) {
        await svc.from("sap_purchase_orders").upsert({
          tenant_id: tenantId,
          external_id: String(r.PurchaseOrder),
          vendor_external_id: r.Supplier ? String(r.Supplier) : null,
          status: r.PurchasingProcessingStatus || null,
          total: null,
          currency: r.DocumentCurrency || null,
          ordered_at: r.PurchaseOrderDate ? new Date(r.PurchaseOrderDate).toISOString() : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = isoFromSap(r.LastChangeDateTime);
        if (t && (!highWater || t > highWater)) highWater = t;
      }
      return { updated, highWater };
    },
  },

  plant: {
    path: "/sap/opu/odata4/sap/api_plant_srv/srvd_a2x/sap/plant/0001/Plant",
    cursorCol: null,
    upsert: async (svc, tenantId, items) => {
      let updated = 0;
      for (const r of items) {
        await svc.from("sap_plants").upsert({
          tenant_id: tenantId,
          external_id: String(r.Plant),
          name: r.PlantName || null,
          is_inactive: false,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
      }
      return { updated, highWater: null };
    },
  },

  currency: {
    path: "/sap/opu/odata4/sap/api_currency_srv/srvd_a2x/sap/currency/0001/Currency",
    cursorCol: null,
    upsert: async (svc, tenantId, items) => {
      let updated = 0;
      for (const r of items) {
        await svc.from("sap_currencies").upsert({
          tenant_id: tenantId,
          external_id: String(r.Currency),
          description: r.CurrencyName || null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
      }
      return { updated, highWater: null };
    },
  },

  inventory: {
    path: "/sap/opu/odata4/sap/api_material_stock_srv/srvd_a2x/sap/materialstock/0001/MaterialStock",
    cursorCol: null,
    upsert: async (svc, tenantId, items) => {
      let updated = 0;
      for (const r of items) {
        if (!r.Material) continue;
        await svc.from("sap_inventory_balances").upsert({
          tenant_id: tenantId,
          material_external_id: String(r.Material),
          plant_external_id: r.Plant ? String(r.Plant) : null,
          storage_location: r.StorageLocation || null,
          quantity_on_hand: r.MatlWrhsStkQtyInMatlBaseUnit != null ? Number(r.MatlWrhsStkQtyInMatlBaseUnit) : null,
          quantity_unrestricted: r.MaterialBaseUnit != null ? Number(r.MaterialBaseUnit) : null,
          base_uom: r.MaterialBaseUnit || null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,material_external_id,plant_external_id,storage_location" });
        updated += 1;
      }
      return { updated, highWater: null };
    },
  },
};

const ENTITY_NAMES = Object.keys(ENTITY);

const reverseSyncSalesOrders = async (svc, tenantId, settings) => {
  const orders = await svc.from("orders")
    .select("id, result")
    .eq("tenant_id", tenantId)
    .not("result->external_systems->sap", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.sap?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = o.result.external_systems.sap.external_id;
    const r = await sapFetch(settings, {
      method: "GET",
      path: `/sap/opu/odata4/sap/api_sales_order_srv/srvd_a2x/sap/salesorder/0001/A_SalesOrder('${id}')`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const sap = r.body || {};
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        sap: {
          ...o.result.external_systems.sap,
          status: sap.OverallSDProcessStatus || null,
          total: sap.TotalNetAmount != null ? Number(sap.TotalNetAmount) : null,
          last_reverse_sync_at: new Date().toISOString(),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("id", o.id);
    updated += 1;
  }
  return { entity: "sales_order_status", pulled: linked.length, updated };
};

const runForTenant = async (svc, tenantId, settingsRow, opts) => {
  const settings = sapDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!sapIsConfigured(settings)) return { tenant_id: tenantId, skipped: true, reason: "not_configured" };

  const which = (opts?.entities && opts.entities.length)
    ? opts.entities.filter((e) => ENTITY_NAMES.includes(e))
    : ENTITY_NAMES;
  const out = [];
  for (const entity of which) {
    const def = ENTITY[entity];
    const r = await runSyncEntity(svc, PREFIX, {
      tenantId, entity,
      triggeredBy: opts?.triggeredBy || "cron",
      full: !!opts?.full,
      runner: async (since) => {
        const filter = (def.cursorCol && since) ? buildCursorFilter(since, def.cursorCol) : "";
        const items = await sapList(settings, def.path, { filter, top: 200, maxRows: 5000 });
        const u = await def.upsert(svc, tenantId, items);
        return { pulled: items.length, inserted: 0, updated: u.updated || 0, errored: 0, highWater: u.highWater || null };
      },
    });
    out.push(r);
  }
  if (!opts?.entities || opts.entities.includes("sales_order_status")) {
    out.push(await reverseSyncSalesOrders(svc, tenantId, settings));
  }
  return { tenant_id: tenantId, results: out };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const tenants = await svc.from("tenant_settings").select("*").not("sap_base_url", "is", null);
      if (tenants.error) throw new Error("tenant_settings read: " + tenants.error.message);
      const out = [];
      for (const s of tenants.data || []) {
        out.push(await runForTenant(svc, s.tenant_id, s, { triggeredBy: "cron" }));
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants_considered: (tenants.data || []).length, results: out });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const t = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!t.data) return json(res, 404, { error: { message: "tenant has no settings" } });
    const result = await runForTenant(svc, ctx.tenantId, t.data, {
      triggeredBy: "manual",
      entities: Array.isArray(body?.entities) ? body.entities : (body?.entity ? [body.entity] : null),
      full: !!body?.full,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) { sendError(res, err); }
}
