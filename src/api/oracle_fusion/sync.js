// /api/oracle_fusion/sync
//
// Pulls customers, items, sales orders from Oracle Fusion Cloud ERP
// into the local mirror tables. Cron-driven for every configured
// tenant; admin-callable to trigger an immediate refresh.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { oracleFusionDecryptCreds, oracleFusionList, oracleFusionIsConfigured, oracleFusionFetch } from "../_lib/oracle-fusion-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "oracle_fusion";

// Oracle Fusion REST cursor expression goes into the `q` query
// parameter as a SQL-like predicate, e.g. `LastUpdateDate>"2025-..."`.
const cursorFilter = (since, col = "LastUpdateDate") =>
  since ? `${col}>"${new Date(since).toISOString()}"` : "";

const ENTITY = {
  customer: {
    resource: "accounts", cursorCol: "LastUpdateDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        const externalId = String(r.PartyNumber || r.PartyId || r.id);
        const name = r.OrganizationName || r.PartyName || r.PersonFirstName || null;
        if (name) {
          // Audit P8.2: promote to canonical customers table.
          await canonicaliseCustomer(svc, tid, {
            vendor: "oracle_fusion",
            vendorIdField: "oracle_fusion_id",
            externalId,
            name,
            email: r.EmailAddress || null,
            currency: r.CurrencyCode || null,
            ref: { party_status: r.PartyStatus, modified: r.LastUpdateDate },
          });
        }
        await svc.from("oracle_fusion_customers").upsert({
          tenant_id: tid,
          external_id: externalId,
          name,
          email: r.EmailAddress || null,
          currency: r.CurrencyCode || null,
          is_inactive: r.PartyStatus === "I",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LastUpdateDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    resource: "itemsV2", cursorCol: "LastUpdateDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("oracle_fusion_items").upsert({
          tenant_id: tid,
          external_id: String(r.ItemNumber || r.ItemId || r.id),
          description: r.ItemDescription || r.LongDescription || null,
          base_uom: r.PrimaryUOMValue || r.PrimaryUnitOfMeasure || null,
          is_inactive: r.ItemStatusValue === "Inactive",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LastUpdateDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    resource: "salesOrdersForOrderHub", cursorCol: "LastUpdateDate",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("oracle_fusion_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.OrderNumber || r.HeaderId || r.id),
          customer_external_id: r.BuyingPartyNumber ? String(r.BuyingPartyNumber) : null,
          status: r.StatusCode || r.Status || null,
          order_date: r.TransactionalCurrencyCode && r.OrderedDate ? r.OrderedDate.slice(0, 10) : (r.OrderedDate ? r.OrderedDate.slice(0, 10) : null),
          ship_to: r.ShipToAddress1 || null,
          currency: r.TransactionalCurrencyCode || null,
          total: r.TotalAmount != null ? Number(r.TotalAmount) : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LastUpdateDate;
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
    .not("result->external_systems->oracle_fusion", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.oracle_fusion?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.oracle_fusion.external_id);
    const r = await oracleFusionFetch(settings, {
      method: "GET",
      resource: `salesOrdersForOrderHub/${id}`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        oracle_fusion: {
          ...o.result.external_systems.oracle_fusion,
          status: r.body?.StatusCode || r.body?.Status || "unknown",
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
  const settings = oracleFusionDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!oracleFusionIsConfigured(settings)) {
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
        const q = (def.cursorCol && since) ? cursorFilter(since, def.cursorCol) : "";
        const items = await oracleFusionList(settings, def.resource, { q, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("oracle_fusion_base_url", "is", null);
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
