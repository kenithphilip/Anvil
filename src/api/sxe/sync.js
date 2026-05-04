// /api/sxe/sync

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { sxeDecryptCreds, sxeList, sxeIsConfigured, sxeFetch } from "../_lib/sxe-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "sxe";

const cursorFilter = (since, col = "lastModifiedDate") =>
  since ? `${col} gt ${new Date(since).toISOString()}` : "";

const ENTITY = {
  customer: {
    path: "/M3/m3api-rest/v2/customer", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("sxe_customers").upsert({
          tenant_id: tid,
          external_id: String(r.customerNumber || r.CustomerNumber || r.id),
          name: r.customerName || r.name || null,
          email: r.email || null,
          currency: r.currency || null,
          is_inactive: !!r.inactive,
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    path: "/M3/m3api-rest/v2/item", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("sxe_items").upsert({
          tenant_id: tid,
          external_id: String(r.itemNumber || r.ItemNumber || r.id),
          description: r.description || null,
          base_uom: r.uom || null,
          is_inactive: r.status === "X",
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    path: "/M3/m3api-rest/v2/customer-order", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("sxe_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.orderNumber || r.OrderNumber),
          customer_external_id: r.customerNumber ? String(r.customerNumber) : null,
          status: r.orderStatus || null,
          total: r.orderValue != null ? Number(r.orderValue) : null,
          currency: r.currency || null,
          ordered_at: r.orderDate ? new Date(r.orderDate).toISOString() : null,
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  purchase_order: {
    path: "/M3/m3api-rest/v2/purchase-order", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("sxe_purchase_orders").upsert({
          tenant_id: tid,
          external_id: String(r.orderNumber || r.OrderNumber),
          vendor_external_id: r.supplierNumber ? String(r.supplierNumber) : null,
          status: r.orderStatus || null,
          total: r.orderValue != null ? Number(r.orderValue) : null,
          currency: r.currency || null,
          ordered_at: r.orderDate ? new Date(r.orderDate).toISOString() : null,
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  warehouse: {
    path: "/M3/m3api-rest/v2/warehouse", cursorCol: null,
    upsert: async (svc, tid, items) => {
      let updated = 0;
      for (const r of items) {
        await svc.from("sxe_warehouses").upsert({
          tenant_id: tid,
          external_id: String(r.warehouseId || r.id),
          name: r.warehouseName || r.name || null,
          is_inactive: !!r.inactive,
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
      }
      return { updated, highWater: null };
    },
  },
  inventory: {
    path: "/M3/m3api-rest/v2/inventory-balance", cursorCol: null,
    upsert: async (svc, tid, items) => {
      let updated = 0;
      for (const r of items) {
        if (!r.itemNumber) continue;
        await svc.from("sxe_inventory_balances").upsert({
          tenant_id: tid,
          item_external_id: String(r.itemNumber),
          warehouse: r.warehouseId || "",
          quantity_on_hand: r.onHand != null ? Number(r.onHand) : null,
          quantity_available: r.available != null ? Number(r.available) : null,
          base_uom: r.uom || null,
          raw: r, synced_at: new Date().toISOString(),
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
    .not("result->external_systems->sxe", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.sxe?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.sxe.external_id);
    const r = await sxeFetch(settings, {
      method: "GET",
      path: `/M3/m3api-rest/v2/customer-order/${id}`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        sxe: {
          ...o.result.external_systems.sxe,
          status: r.body?.orderStatus || null,
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
  const settings = sxeDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!sxeIsConfigured(settings)) return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
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
        const items = await sxeList(settings, def.path, { filter, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("sxe_base_url", "is", null);
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
