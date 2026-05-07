// /api/jde/sync
//
// Pulls customers, items, and sales orders from JDE EnterpriseOne
// (via AIS dataservice) into the local mirror tables. Cron-driven
// for every configured tenant; admin-callable for an immediate
// refresh.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { jdeDecryptCreds, jdeList, jdeIsConfigured, jdeFetch } from "../_lib/jde-client.js";
import { runSyncEntity } from "../_lib/erp-runner.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PREFIX = "jde";

// JDE dataservice criteria for "modified since". Each table uses a
// different update-date column; we map them per-entity. Most JDE
// tables have an `UPMJ` (update Julian date) column.
const ENTITY = {
  customer: {
    target: "F0101", // Address Book Master (customer = AB record with AC type CUST)
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        const ext = String(r.AN8 || r.id);
        const name = r.ALPH || r.MLNM || null;
        if (name) {
          // Audit P8.2: promote to canonical customers table.
          await canonicaliseCustomer(svc, tid, {
            vendor: "jde",
            vendorIdField: "jde_id",
            externalId: ext,
            name,
            email: r.EMAL || null,
            currency: r.CRCD || null,
            ref: { search_type: r.AT1, julian_update: r.UPMJ },
          });
        }
        await svc.from("jde_customers").upsert({
          tenant_id: tid,
          external_id: ext,
          name,
          email: r.EMAL || null,
          currency: r.CRCD || null,
          is_inactive: r.AT1 === "Z",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.UPMJ ? new Date().toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
  item: {
    target: "F4101", // Item Master
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("jde_items").upsert({
          tenant_id: tid,
          external_id: String(r.IMITM || r.id),
          description: r.DSC1 || null,
          base_uom: r.UOM1 || null,
          is_inactive: r.STKT === "X",
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.UPMJ ? new Date().toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
  sales_order: {
    target: "F4201", // Sales Order Header
    upsert: async (svc, tid, items) => {
      let updated = 0; let hw = null;
      for (const r of items) {
        await svc.from("jde_sales_orders").upsert({
          tenant_id: tid,
          external_id: String(r.SDDOCO || r.id),
          customer_external_id: r.SDAN8 ? String(r.SDAN8) : null,
          status: r.SDNXTR || null,
          order_date: r.SDTRDJ ? null : null, // JDE Julian-date conversion is non-trivial; skip here
          ship_to: r.SDSHAN ? String(r.SDSHAN) : null,
          currency: r.SDCRCD || null,
          total: r.SDTOTAL != null ? Number(r.SDTOTAL) : null,
          raw: r,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,external_id" });
        updated += 1;
        const t = r.UPMJ ? new Date().toISOString() : null;
        if (t && (!hw || t > hw)) hw = t;
      }
      return { updated, highWater: hw };
    },
  },
};

const ENTITY_NAMES = Object.keys(ENTITY);

const reverseSyncSalesOrders = async (svc, tenantId, settings) => {
  const orders = await svc.from("orders").select("id, result")
    .eq("tenant_id", tenantId)
    .not("result->external_systems->jde", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) => o.result?.external_systems?.jde?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };
  let updated = 0;
  for (const o of linked) {
    const id = o.result.external_systems.jde.external_id;
    const r = await jdeFetch(settings, {
      method: "POST",
      path: "dataservice",
      body: {
        targetName: "F4201",
        targetType: "table",
        dataServiceType: "BROWSE",
        query: { autoFind: true, condition: [{ value: [id], controlId: "F4201.SDDOCO", operator: "EQUAL" }] },
      },
    }).catch(() => null);
    if (!r?.ok) continue;
    const row = r.body?.fs_DATABROWSE_LIST?.data?.gridData?.rowset?.[0] || null;
    if (!row) continue;
    const newResult = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        jde: {
          ...o.result.external_systems.jde,
          status: row?.SDNXTR || "unknown",
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
  const settings = jdeDecryptCreds({ ...settingsRow, tenant_id: tenantId });
  if (!jdeIsConfigured(settings)) {
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
        // JDE Julian-date filtering is non-trivial; we always full-pull
        // capped at 5000 rows. A future iteration converts the cursor
        // to Julian and filters via UPMJ.
        const items = await jdeList(settings, def.target, { top: 200, maxRows: 5000 });
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
      const tenants = await svc.from("tenant_settings").select("*").not("jde_base_url", "is", null);
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
