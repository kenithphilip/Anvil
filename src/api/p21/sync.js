// /api/p21/sync

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { p21DecryptCreds, p21List, p21IsConfigured, p21Fetch } from "../_lib/p21-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "p21";

const cursorFilter = (since, col = "lastModifiedDate") =>
  since ? `${col} gt ${new Date(since).toISOString()}` : "";

const ENTITY = {
  customer: {
    path: "/api/v2/odata/data/Customers", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("p21_customers").upsert({
          tenant_id: tid,
          external_id: String(r.customer_id || r.CustomerId),
          name: r.customer_name || r.CustomerName || null,
          email: r.email_address || null,
          phone: r.phone_number || null,
          currency: r.currency_id || null,
          is_inactive: !!(r.delete_flag === "Y"),
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.date_last_modified;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    path: "/api/v2/odata/data/Items", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("p21_items").upsert({
          tenant_id: tid,
          external_id: String(r.item_id || r.ItemId),
          description: r.item_desc || r.description || null,
          base_uom: r.base_uom || null,
          item_class: r.class_id1 || null,
          is_inactive: !!(r.delete_flag === "Y"),
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.date_last_modified;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    path: "/api/v2/odata/data/OrderHeader", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("p21_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.order_no),
          customer_external_id: r.customer_id ? String(r.customer_id) : null,
          status: r.completed === "Y" ? "completed" : (r.cancel_flag === "Y" ? "cancelled" : "open"),
          total: r.order_total != null ? Number(r.order_total) : null,
          currency: r.currency_id || null,
          ordered_at: r.order_date ? new Date(r.order_date).toISOString() : null,
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.date_last_modified;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  purchase_order: {
    path: "/api/v2/odata/data/POHeader", cursorCol: "lastModifiedDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("p21_purchase_orders").upsert({
          tenant_id: tid,
          external_id: String(r.po_no),
          vendor_external_id: r.supplier_id ? String(r.supplier_id) : null,
          status: r.complete === "Y" ? "complete" : "open",
          total: r.po_total != null ? Number(r.po_total) : null,
          currency: r.currency_id || null,
          ordered_at: r.po_date ? new Date(r.po_date).toISOString() : null,
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.date_last_modified;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  branch: {
    path: "/api/v2/odata/data/Branches", cursorCol: null,
    upsert: async (svc, tid, items) => {
      let updated = 0;
      for (const r of items) {
        await svc.from("p21_branches").upsert({
          tenant_id: tid,
          external_id: String(r.branch_id),
          name: r.branch_name || null,
          is_inactive: !!(r.delete_flag === "Y"),
          raw: r, synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
      }
      return { updated, highWater: null };
    },
  },
  inventory: {
    path: "/api/v2/odata/data/InventoryQuantity", cursorCol: null,
    upsert: async (svc, tid, items) => {
      let updated = 0;
      for (const r of items) {
        if (!r.inv_mast_uid && !r.item_id) continue;
        await svc.from("p21_inventory_balances").upsert({
          tenant_id: tid,
          item_external_id: String(r.item_id || r.inv_mast_uid),
          warehouse: r.location_id || "",
          quantity_on_hand: r.qty_on_hand != null ? Number(r.qty_on_hand) : null,
          quantity_available: r.qty_allocated != null ? Number(r.qty_allocated) : null,
          base_uom: r.base_uom || null,
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
    .not("result->external_systems->p21", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.p21?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.p21.external_id);
    const r = await p21Fetch(settings, {
      method: "GET",
      path: `/api/v2/odata/data/OrderHeader('${id}')`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        p21: {
          ...o.result.external_systems.p21,
          status: r.body?.completed === "Y" ? "completed" : "open",
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
  const settings = p21DecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!p21IsConfigured(settings)) return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
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
        const items = await p21List(settings, def.path, { filter, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("p21_base_url", "is", null);
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
