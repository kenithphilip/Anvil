// /api/acumatica/sync

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { acuDecryptCreds, acuList, acuIsConfigured, acuFetch } from "../_lib/acumatica-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "acu";

const cursorFilter = (since, col = "LastModifiedDateTime") =>
  since ? `${col} gt datetimeoffset'${new Date(since).toISOString()}'` : "";

const ENTITY = {
  customer: {
    entity: "Customer", cursorCol: "LastModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        const externalId = String(r.CustomerID?.value || r.CustomerID || "");
        const name = r.CustomerName?.value || r.CustomerName || null;
        await svc.from("acu_customers").upsert({
          tenant_id: tid,
          external_id: externalId,
          name,
          email: r.MainContact?.Email?.value || null,
          currency: r.CurrencyID?.value || null,
          is_blocked: r.Status?.value === "Hold",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        // Audit P8.2: promote to canonical customers table.
        if (name) {
          await canonicaliseCustomer(svc, tid, {
            vendor: "acu",
            vendorIdField: "acumatica_id",
            externalId,
            name,
            email: r.MainContact?.Email?.value || null,
            currency: r.CurrencyID?.value || null,
            ref: { status: r.Status?.value, modified: r.LastModifiedDateTime?.value },
          });
        }
        const t = r.LastModifiedDateTime?.value || r.LastModifiedDateTime;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  stock_item: {
    entity: "StockItem", cursorCol: "LastModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("acu_stock_items").upsert({
          tenant_id: tid,
          external_id: String(r.InventoryID?.value || r.InventoryID || ""),
          description: r.Description?.value || null,
          base_uom: r.BaseUOM?.value || null,
          is_inactive: r.ItemStatus?.value === "Inactive",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LastModifiedDateTime?.value || r.LastModifiedDateTime;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    entity: "SalesOrder", cursorCol: "LastModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("acu_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.OrderNbr?.value || ""),
          customer_external_id: r.CustomerID?.value || null,
          status: r.Status?.value || null,
          total: r.OrderTotal?.value != null ? Number(r.OrderTotal.value) : null,
          currency: r.CurrencyID?.value || null,
          ordered_at: r.Date?.value ? new Date(r.Date.value).toISOString() : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LastModifiedDateTime?.value;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  purchase_order: {
    entity: "PurchaseOrder", cursorCol: "LastModifiedDateTime",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("acu_purchase_orders").upsert({
          tenant_id: tid,
          external_id: String(r.OrderNbr?.value || ""),
          vendor_external_id: r.VendorID?.value || null,
          status: r.Status?.value || null,
          total: r.OrderTotal?.value != null ? Number(r.OrderTotal.value) : null,
          currency: r.CurrencyID?.value || null,
          ordered_at: r.Date?.value ? new Date(r.Date.value).toISOString() : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LastModifiedDateTime?.value;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  inventory: {
    entity: "InventorySummaryInquiry", cursorCol: null,
    upsert: async (svc, tid, items) => {
      let updated = 0;
      for (const r of items) {
        if (!r.InventoryID?.value) continue;
        await svc.from("acu_inventory_balances").upsert({
          tenant_id: tid,
          item_external_id: String(r.InventoryID.value),
          warehouse: r.WarehouseID?.value || "",
          quantity_on_hand: r.QtyOnHand?.value != null ? Number(r.QtyOnHand.value) : null,
          quantity_available: r.QtyAvailable?.value != null ? Number(r.QtyAvailable.value) : null,
          base_uom: r.BaseUOM?.value || null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,item_external_id,warehouse" });
        updated += 1;
      }
      return { updated, highWater: null };
    },
  },
};

const ENTITY_NAMES = Object.keys(ENTITY);

const reverseSyncSalesOrders = async (svc, tenantId, settings) => {
  const orders = await svc.from("orders").select("id, result")
    .eq("tenant_id", tenantId)
    .not("result->external_systems->acumatica", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.acumatica?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const ep = settings.acumatica_endpoint_name || "Default";
    const ver = settings.acumatica_endpoint_version || "20.200.001";
    const id = encodeURIComponent(o.result.external_systems.acumatica.external_id);
    const r = await acuFetch(settings, { method: "GET", path: `/entity/${ep}/${ver}/SalesOrder/SO/${id}` }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        acumatica: {
          ...o.result.external_systems.acumatica,
          status: r.body?.Status?.value || null,
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
  const settings = acuDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!acuIsConfigured(settings)) return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
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
        const items = await acuList(settings, def.entity, { filter, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("acumatica_base_url", "is", null);
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
