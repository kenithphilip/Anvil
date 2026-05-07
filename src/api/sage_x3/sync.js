// /api/sage_x3/sync
//
// Pulls customers, items, and sales orders from Sage X3 into the
// local mirror tables. Used by the cron mux (with CRON_SECRET) to
// run for every configured tenant, or by an admin to trigger an
// immediate refresh for their own tenant.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { sagex3DecryptCreds, sagex3List, sagex3IsConfigured, sagex3Fetch } from "../_lib/sage-x3-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "sagex3";

// Sage X3's standard date filter is `LASTUPDDAT gt '2025-...'` but
// the SData representation also accepts `lastModifiedDate`. We
// stick with LASTUPDDAT (closer to the wire schema).
const cursorFilter = (since, col = "LASTUPDDAT") =>
  since ? `${col} gt '${new Date(since).toISOString()}'` : "";

const ENTITY = {
  customer: {
    entity: "CUSTOMER", cursorCol: "LASTUPDDAT",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        const externalId = String(r.BPCNUM || r.id);
        const name = r.BPCNAM_0 || r.BPCNAM || null;
        if (name) {
          // Audit P8.2: promote to canonical customers table.
          await canonicaliseCustomer(svc, tid, {
            vendor: "sagex3",
            vendorIdField: "sage_x3_id",
            externalId,
            name,
            email: r.WEB || r.email || null,
            currency: r.CUR || null,
            ref: { is_inactive: r.ENAFLG === "1" || r.BPCSTA === "Closed", modified: r.LASTUPDDAT },
          });
        }
        await svc.from("sagex3_customers").upsert({
          tenant_id: tid,
          external_id: externalId,
          name,
          email: r.WEB || r.email || null,
          currency: r.CUR || null,
          is_inactive: r.ENAFLG === "1" || r.BPCSTA === "Closed",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LASTUPDDAT || r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    entity: "ITEM", cursorCol: "LASTUPDDAT",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("sagex3_items").upsert({
          tenant_id: tid,
          external_id: String(r.ITMREF || r.id),
          description: r.ITMDES1 || r.description || null,
          base_uom: r.STU || r.unit || null,
          is_inactive: r.ENAFLG === "1" || r.ITMSTA === "Closed",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LASTUPDDAT || r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    entity: "SOH", cursorCol: "LASTUPDDAT",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("sagex3_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.SOHNUM || r.id),
          customer_external_id: r.BPCORD ? String(r.BPCORD) : null,
          status: r.STA || r.status || null,
          order_date: r.ORDDAT ? r.ORDDAT.slice(0, 10) : null,
          ship_to: r.BPCINV || null,
          currency: r.CUR || null,
          total: r.TOTAMT != null ? Number(r.TOTAMT) : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.LASTUPDDAT || r.lastModifiedDate;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
};

const ENTITY_NAMES = Object.keys(ENTITY);

// Reverse-sync: pick up status changes for orders we previously
// pushed. Skip if the orders.result lacks an external_systems.sage_x3
// entry to avoid scanning the whole table.
const reverseSyncSalesOrders = async (svc, tenantId, settings) => {
  const orders = await svc.from("orders").select("id, result")
    .eq("tenant_id", tenantId)
    .not("result->external_systems->sage_x3", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.sage_x3?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.sage_x3.external_id);
    const r = await sagex3Fetch(settings, {
      method: "GET",
      entity: `SOH('${id}')`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        sage_x3: {
          ...o.result.external_systems.sage_x3,
          status: r.body?.STA || "unknown",
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
  const settings = sagex3DecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!sagex3IsConfigured(settings)) {
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
        const items = await sagex3List(settings, def.entity, { filter, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("sagex3_base_url", "is", null);
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
