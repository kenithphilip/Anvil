// POST or GET /api/d365/sync

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { d365DecryptCreds, d365List, d365IsConfigured, d365Fetch } from "../_lib/d365-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "d365";

const cursorFilter = (since, col = "ModifiedDateTime") =>
  since ? `${col} gt ${new Date(since).toISOString()}` : "";

const ENTITY = {
  customer: {
    path: "/data/CustomersV3", cursorCol: "ModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("d365_customers").upsert({
          tenant_id: tid,
          external_id: String(r.CustomerAccount || r.dataAreaId + ":" + r.CustomerAccount),
          name: r.OrganizationName || r.PersonName || null,
          email: r.PrimaryContactEmail || null,
          phone: r.PrimaryContactPhone || null,
          currency: r.SalesCurrencyCode || null,
          is_blocked: !!r.IsCustomerOnInvoiceHold,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.ModifiedDateTime ? new Date(r.ModifiedDateTime).toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
  released_product: {
    path: "/data/ReleasedProductsV2", cursorCol: "ModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("d365_released_products").upsert({
          tenant_id: tid,
          external_id: String(r.ItemNumber),
          description: r.ProductName || r.SearchName || null,
          base_uom: r.BaseUnit || null,
          product_group: r.ItemGroupId || null,
          is_inactive: r.ItemModelGroupId === "INACTIVE",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.ModifiedDateTime ? new Date(r.ModifiedDateTime).toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    path: "/data/SalesOrderHeadersV2", cursorCol: "ModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("d365_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.SalesOrderNumber),
          customer_external_id: r.OrderingCustomerAccountNumber || null,
          status: r.SalesOrderProcessingStatus || null,
          total: r.SalesOrderAmountIncludingTaxes != null ? Number(r.SalesOrderAmountIncludingTaxes) : null,
          currency: r.SalesOrderCurrencyCode || null,
          ordered_at: r.OrderEntryDate ? new Date(r.OrderEntryDate).toISOString() : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.ModifiedDateTime ? new Date(r.ModifiedDateTime).toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
  purchase_order: {
    path: "/data/PurchaseOrderHeadersV2", cursorCol: "ModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("d365_purchase_orders").upsert({
          tenant_id: tid,
          external_id: String(r.PurchaseOrderNumber),
          vendor_external_id: r.OrderVendorAccountNumber || null,
          status: r.PurchaseOrderApprovalStatus || null,
          total: null,
          currency: r.PurchaseOrderCurrencyCode || null,
          ordered_at: r.OrderPlacedDate ? new Date(r.OrderPlacedDate).toISOString() : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.ModifiedDateTime ? new Date(r.ModifiedDateTime).toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
  inventory: {
    path: "/data/InventOnhand", cursorCol: null,
    upsert: async (svc, tid, items) => {
      let updated = 0;
      for (const r of items) {
        if (!r.ProductNumber && !r.ItemNumber) continue;
        await svc.from("d365_inventory_balances").upsert({
          tenant_id: tid,
          product_external_id: String(r.ProductNumber || r.ItemNumber),
          warehouse: r.WarehouseId || "",
          site: r.SiteId || "",
          quantity_on_hand: r.OnHandQuantity != null ? Number(r.OnHandQuantity) : null,
          quantity_available: r.AvailablePhysical != null ? Number(r.AvailablePhysical) : null,
          base_uom: r.UnitOfMeasure || null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,product_external_id,warehouse,site" });
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
    .not("result->external_systems->d365", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.d365?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = o.result.external_systems.d365.external_id;
    const r = await d365Fetch(settings, {
      method: "GET",
      path: `/data/SalesOrderHeadersV2(SalesOrderNumber='${id}',dataAreaId='${settings.d365_company || ""}')`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        d365: {
          ...o.result.external_systems.d365,
          status: r.body.SalesOrderProcessingStatus || null,
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
  const settings = d365DecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!d365IsConfigured(settings)) return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
  const which = (opts?.entities && opts.entities.length)
    ? opts.entities.filter((e) => ENTITY_NAMES.includes(e))
    : ENTITY_NAMES;
  const out = [];
  for (const entity of which) {
    const def = ENTITY[entity];
    out.push(await runSyncEntity(svc, PREFIX, {
      tenantId, entity,
      triggeredBy: opts?.triggeredBy || "cron",
      full: !!opts?.full,
      runner: async (since) => {
        const filter = (def.cursorCol && since) ? cursorFilter(since, def.cursorCol) : "";
        const items = await d365List(settings, def.path, { filter, top: 200, maxRows: 5000, crossCompany: false });
        const u = await def.upsert(svc, tenantId, items);
        return { pulled: items.length, inserted: 0, updated: u.updated || 0, errored: 0, highWater: u.highWater || null };
      },
    }));
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
      const tenants = await svc.from("tenant_settings").select("*").not("d365_resource_url", "is", null);
      if (tenants.error) throw new Error("tenant_settings: " + tenants.error.message);
      const out = [];
      for (const s of tenants.data || []) out.push(await runForTenant(svc, s.tenant_id, s, { triggeredBy: "cron" }));
      return json(res, 200, { ran_at: new Date().toISOString(), tenants_considered: (tenants.data || []).length, results: out });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const t = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!t.data) return json(res, 404, { error: { message: "no settings" } });
    const result = await runForTenant(svc, ctx.tenantId, t.data, {
      triggeredBy: "manual",
      entities: Array.isArray(body?.entities) ? body.entities : (body?.entity ? [body.entity] : null),
      full: !!body?.full,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) { sendError(res, err); }
}
