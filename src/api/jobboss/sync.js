// /api/jobboss/sync
//
// Pulls customers, items, sales orders/quotes from JobBoss² into
// the local mirror tables. Phase 5.4b cluster B.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { jobbossDecryptCreds, jobbossList, jobbossIsConfigured, jobbossFetch } from "../_lib/jobboss-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "jobboss";

const cursorFilter = (since, col = "lastModifiedDate") =>
  since ? `${col} ge '${new Date(since).toISOString()}'` : "";

const ENTITY = {
  customer: {
    path: "customers",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        const externalId = String(r.customerId || r.id);
        const name = r.name || r.customerName || null;
        if (name) {
          // Audit P8.2: promote to canonical customers table.
          await canonicaliseCustomer(svc, tid, {
            vendor: "jobboss",
            vendorIdField: "jobboss_id",
            externalId,
            name,
            email: r.email || null,
            currency: r.currency || null,
            ref: { status: r.status, modified: r.lastModifiedDate || r.modifiedOn },
          });
        }
        await svc.from("jobboss_customers").upsert({
          tenant_id: tid,
          external_id: externalId,
          name,
          email: r.email || null,
          currency: r.currency || null,
          is_inactive: r.status === "Inactive",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.modifiedOn;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    path: "parts",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("jobboss_items").upsert({
          tenant_id: tid,
          external_id: String(r.partId || r.partNumber || r.id),
          description: r.description || null,
          base_uom: r.unitOfMeasure || null,
          is_inactive: r.status === "Inactive",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.modifiedOn;
        if (t && (!hw || t > hw)) hw = new Date(t).toISOString();
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    path: "quotes",
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("jobboss_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.quoteNumber || r.jobNumber || r.id),
          customer_external_id: r.customerId ? String(r.customerId) : null,
          status: r.status || null,
          order_date: r.quoteDate ? r.quoteDate.slice(0, 10) : null,
          ship_to: r.shipToAddress || null,
          currency: r.currency || null,
          total: r.totalAmount != null ? Number(r.totalAmount) : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.lastModifiedDate || r.modifiedOn;
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
    .not("result->external_systems->jobboss", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.jobboss?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = encodeURIComponent(o.result.external_systems.jobboss.external_id);
    const r = await jobbossFetch(settings, {
      method: "GET",
      path: `quotes/${id}`,
    }).catch(() => null);
    if (!r?.ok) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        jobboss: {
          ...o.result.external_systems.jobboss,
          status: r.body?.status || "unknown",
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
  const settings = jobbossDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!jobbossIsConfigured(settings)) {
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
        const filter = since ? cursorFilter(since) : "";
        const items = await jobbossList(settings, def.path, { filter, top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("jobboss_base_url", "is", null);
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
