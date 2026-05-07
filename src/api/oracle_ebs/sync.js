// /api/oracle_ebs/sync — Phase 5.4b cluster C.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { oracleEbsDecryptCreds, oracleEbsList, oracleEbsIsConfigured, oracleEbsFetch } from "../_lib/oracle-ebs-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "oracle_ebs";

const ENTITY = {
  customer: {
    path: "ar_customers/get_customer_list/",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        const externalId = String(r.PARTY_ID || r.CUST_ACCOUNT_ID || r.id);
        const name = r.PARTY_NAME || r.NAME || null;
        if (name) {
          // Audit P8.2: promote to canonical customers table.
          await canonicaliseCustomer(svc, tid, {
            vendor: "oracle_ebs",
            vendorIdField: "oracle_ebs_id",
            externalId,
            name,
            email: r.EMAIL_ADDRESS || null,
            currency: r.CURRENCY_CODE || null,
            ref: { status: r.STATUS, modified: r.LAST_UPDATE_DATE },
          });
        }
        await svc.from("oracle_ebs_customers").upsert({
          tenant_id: tid,
          external_id: externalId,
          name,
          email: r.EMAIL_ADDRESS || null,
          currency: r.CURRENCY_CODE || null,
          is_inactive: r.STATUS === "I",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LAST_UPDATE_DATE;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    path: "inv_items/get_item_list/",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("oracle_ebs_items").upsert({
          tenant_id: tid,
          external_id: String(r.INVENTORY_ITEM_ID || r.SEGMENT1 || r.id),
          description: r.DESCRIPTION || null,
          base_uom: r.PRIMARY_UOM_CODE || null,
          is_inactive: r.ENABLED_FLAG === "N",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LAST_UPDATE_DATE;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    path: "oe_orders/get_order_list/",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("oracle_ebs_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.HEADER_ID || r.ORDER_NUMBER || r.id),
          customer_external_id: r.SOLD_TO_ORG_ID ? String(r.SOLD_TO_ORG_ID) : null,
          status: r.FLOW_STATUS_CODE || null,
          order_date: r.ORDERED_DATE ? r.ORDERED_DATE.slice(0, 10) : null,
          ship_to: r.SHIP_TO_ORG_ID ? String(r.SHIP_TO_ORG_ID) : null,
          currency: r.TRANSACTIONAL_CURR_CODE || null,
          total: r.ORDER_TOTAL != null ? Number(r.ORDER_TOTAL) : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LAST_UPDATE_DATE;
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
    .not("result->external_systems->oracle_ebs", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.oracle_ebs?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.oracle_ebs.external_id);
    const r = await oracleEbsFetch(settings, {
      method: "GET",
      path: `oe_orders/get_order_status/`,
      query: { p_header_id: id },
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        oracle_ebs: {
          ...o.result.external_systems.oracle_ebs,
          status: r.body?.FLOW_STATUS_CODE || r.body?.STATUS || "unknown",
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
  const settings = oracleEbsDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!oracleEbsIsConfigured(settings)) {
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
      runner: async (_since) => {
        const items = await oracleEbsList(settings, def.path, { top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("oracle_ebs_base_url", "is", null);
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
