// /api/ifs/sync
//
// Pulls customers, items, and sales orders from IFS Cloud into the
// local mirror tables. Used by the cron mux (with CRON_SECRET) to
// run for every configured tenant, or by an admin to trigger an
// immediate refresh for their own tenant.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { ifsDecryptCreds, ifsList, ifsIsConfigured, ifsFetch } from "../_lib/ifs-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "ifs";

// IFS Cloud OData filters use camelCase field names. The cursor
// field for sales orders / customers / items is `lastUpdate`.
const cursorFilter = (since, col = "lastUpdate") =>
  since ? `${col} gt ${new Date(since).toISOString()}` : "";

const ENTITY = {
  customer: {
    entity: "Customers", cursorCol: "lastUpdate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("ifs_customers").upsert({
          tenant_id: tid,
          external_id: String(r.CustomerNo || r.CustomerId || r.id),
          name: r.Name || r.CustomerName || null,
          email: r.Email || null,
          currency: r.CurrencyCode || null,
          is_inactive: r.PartyType === "INACTIVE" || r.Status === "Inactive",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastUpdate || r.LastUpdate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    entity: "SalesParts", cursorCol: "lastUpdate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("ifs_items").upsert({
          tenant_id: tid,
          external_id: String(r.CatalogNo || r.PartNo || r.id),
          description: r.Description || r.CatalogDesc || null,
          base_uom: r.SalesUnitMeas || r.UnitMeas || null,
          is_inactive: r.PartStatus === "Inactive",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastUpdate || r.LastUpdate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    entity: "CustomerOrders", cursorCol: "lastUpdate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("ifs_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.OrderNo || r.id),
          customer_external_id: r.CustomerNo ? String(r.CustomerNo) : null,
          status: r.OrderStatus || r.Status || null,
          order_date: r.DateEntered ? r.DateEntered.slice(0, 10) : null,
          ship_to: r.ShipAddrNo || null,
          currency: r.Currency || r.CurrencyCode || null,
          total: r.TotalGrossAmount != null ? Number(r.TotalGrossAmount) : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastUpdate || r.LastUpdate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
};

const ENTITY_NAMES = Object.keys(ENTITY);

const reverseSyncSalesOrders = async (svc, tenantId, settings) => {
  const orders = await svc.from("orders").select("id, result")
    .eq("tenant_id", tenantId)
    .not("result->external_systems->ifs", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.ifs?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.ifs.external_id);
    const r = await ifsFetch(settings, {
      method: "GET",
      entity: `CustomerOrders('${id}')`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        ifs: {
          ...o.result.external_systems.ifs,
          status: r.body?.OrderStatus || r.body?.Status || "unknown",
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
  const settings = ifsDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!ifsIsConfigured(settings)) {
    return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
  }
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
        const items = await ifsList(settings, def.entity, { filter, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("ifs_base_url", "is", null);
      if (tenants.error) throw new Error("tenant_settings: " + tenants.error.message);
      const out = [];
      for (const s of tenants.data || []) {
        out.push(await runForTenant(svc, s.tenant_id, s, { triggeredBy: "cron" }));
      }
      return json(res, 200, {
        ran_at: new Date().toISOString(),
        tenants_considered: (tenants.data || []).length,
        results: out,
      });
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
  } catch (err) {
    return sendError(res, err);
  }
}
