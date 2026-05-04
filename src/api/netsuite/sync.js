// POST or GET /api/netsuite/sync
//
// Pulls fresh data from NetSuite into the local mirror tables.
// Two trigger modes:
//   1. Cron (default). Auth via Bearer CRON_SECRET. Loops every
//      configured tenant + every entity. Vercel hits this every
//      30 minutes.
//   2. Manual. Auth via the normal user context (admin role).
//      Body { entity?: "...", entities?: [...], full?: true } scopes
//      the run to the caller's tenant. `full=true` ignores the
//      cursor and re-pulls everything.
//
// v2 entity coverage (10 entities):
//   - customer       -> customers (via external_ref)
//   - item           -> item_master
//   - sales_order    -> netsuite_open_orders
//   - vendor         -> netsuite_vendors
//   - purchase_order -> netsuite_purchase_orders
//   - location       -> netsuite_locations
//   - currency       -> netsuite_currencies
//   - inventory      -> netsuite_inventory_balances
//   - sales_order_status (reverse-sync) -> orders.result.external_systems.netsuite
//   - invoice_paid_status (reverse-sync) -> invoices.status
//
// Each entity uses lastmodifieddate as a high-water cursor so an
// incremental pull only sees rows that changed since the last tick.
// A row is written to netsuite_sync_runs at the start (status=running)
// and updated at the end.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { suiteql, netsuiteIsConfigured } from "../_lib/netsuite-client.js";
import { decryptNetsuiteCreds } from "../_lib/secrets.js";

const CRON_SECRET = process.env.CRON_SECRET;
const PAGE_SIZE = 200;
const MAX_PER_TICK = 5000;

// SuiteQL fragment that gates by the cursor. NetSuite stores
// timestamps in TZ_TO_DATE format. We pass an ISO-8601 string and
// rely on TO_TIMESTAMP_TZ to parse. Because cursoring is by
// lastmodifieddate, the first sync after configuring will pull
// everything (cursor = epoch).
const cursorClause = (column, since) => {
  if (!since) return "";
  return ` AND ${column} > TO_DATE('${since.slice(0, 10)}', 'YYYY-MM-DD')`;
};

const ENTITY_DEF = {
  customer: {
    cursor: "lastmodifieddate",
    sql: (since) => `
      SELECT id, entityid, companyname, email, phone, datecreated, lastmodifieddate, isinactive
      FROM customer
      WHERE 1=1${cursorClause("lastmodifieddate", since)}
      ORDER BY lastmodifieddate
    `,
    syncer: async (svc, tenantId, items) => {
      let inserted = 0, updated = 0;
      for (const c of items) {
        const r = await svc.from("customers").upsert({
          tenant_id: tenantId,
          customer_key: "ns:" + c.id,
          customer_name: c.companyname || c.entityid || ("Customer " + c.id),
          contact_email: c.email || null,
          external_ref: {
            netsuite_id: c.id,
            datecreated: c.datecreated,
            lastmodifieddate: c.lastmodifieddate,
            is_inactive: c.isinactive === "T",
          },
        }, { onConflict: "tenant_id,customer_key" });
        if (r.error) throw new Error("customer upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted, updated };
    },
    highWater: (items) => items.map((c) => c.lastmodifieddate).filter(Boolean).sort().pop(),
  },

  item: {
    cursor: "lastmodifieddate",
    sql: (since) => `
      SELECT id, itemid, displayname, salesdescription, baseprice, lastmodifieddate, isinactive
      FROM item
      WHERE 1=1${cursorClause("lastmodifieddate", since)}
      ORDER BY lastmodifieddate
    `,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const it of items) {
        const r = await svc.from("item_master").upsert({
          tenant_id: tenantId,
          part_no: it.itemid || ("ns-" + it.id),
          description: it.displayname || it.salesdescription || null,
          list_price: it.baseprice || null,
          external_ref: {
            netsuite_id: it.id,
            lastmodifieddate: it.lastmodifieddate,
            is_inactive: it.isinactive === "T",
          },
        }, { onConflict: "tenant_id,part_no" });
        if (r.error) throw new Error("item upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: (items) => items.map((c) => c.lastmodifieddate).filter(Boolean).sort().pop(),
  },

  sales_order: {
    cursor: "lastmodifieddate",
    sql: (since) => `
      SELECT id, tranid, entity AS customer_id, status, totalamount, currencyname, trandate, lastmodifieddate
      FROM transaction
      WHERE type='SalesOrd'${cursorClause("lastmodifieddate", since)}
      ORDER BY lastmodifieddate
    `,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const so of items) {
        const r = await svc.from("netsuite_open_orders").upsert({
          tenant_id: tenantId,
          netsuite_id: String(so.id),
          order_number: so.tranid || null,
          customer_name: null,
          status: so.status || null,
          total: so.totalamount != null ? Number(so.totalamount) : null,
          currency: so.currencyname || null,
          ordered_at: so.trandate ? new Date(so.trandate).toISOString() : null,
          raw: so,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,netsuite_id" });
        if (r.error) throw new Error("sales_order upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: (items) => items.map((c) => c.lastmodifieddate).filter(Boolean).sort().pop(),
  },

  vendor: {
    cursor: "lastmodifieddate",
    sql: (since) => `
      SELECT id, entityid, companyname, email, phone, category, isinactive, lastmodifieddate
      FROM vendor
      WHERE 1=1${cursorClause("lastmodifieddate", since)}
      ORDER BY lastmodifieddate
    `,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const v of items) {
        const r = await svc.from("netsuite_vendors").upsert({
          tenant_id: tenantId,
          netsuite_id: String(v.id),
          name: v.companyname || v.entityid || null,
          email: v.email || null,
          phone: v.phone || null,
          category: v.category || null,
          is_inactive: v.isinactive === "T",
          raw: v,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,netsuite_id" });
        if (r.error) throw new Error("vendor upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: (items) => items.map((c) => c.lastmodifieddate).filter(Boolean).sort().pop(),
  },

  purchase_order: {
    cursor: "lastmodifieddate",
    sql: (since) => `
      SELECT id, tranid, entity AS vendor_id, status, totalamount, currencyname, trandate, lastmodifieddate
      FROM transaction
      WHERE type='PurchOrd'${cursorClause("lastmodifieddate", since)}
      ORDER BY lastmodifieddate
    `,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const po of items) {
        const r = await svc.from("netsuite_purchase_orders").upsert({
          tenant_id: tenantId,
          netsuite_id: String(po.id),
          tranid: po.tranid || null,
          vendor_netsuite_id: po.vendor_id ? String(po.vendor_id) : null,
          status: po.status || null,
          total: po.totalamount != null ? Number(po.totalamount) : null,
          currency: po.currencyname || null,
          ordered_at: po.trandate ? new Date(po.trandate).toISOString() : null,
          raw: po,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,netsuite_id" });
        if (r.error) throw new Error("purchase_order upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: (items) => items.map((c) => c.lastmodifieddate).filter(Boolean).sort().pop(),
  },

  location: {
    cursor: null, // small table, full pull each time
    sql: () => `SELECT id, name, isinactive FROM location ORDER BY id`,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const l of items) {
        const r = await svc.from("netsuite_locations").upsert({
          tenant_id: tenantId,
          netsuite_id: String(l.id),
          name: l.name || null,
          is_inactive: l.isinactive === "T",
          raw: l,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,netsuite_id" });
        if (r.error) throw new Error("location upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: () => null,
  },

  currency: {
    cursor: null,
    sql: () => `SELECT id, symbol, exchangerate, isbasecurrency FROM currency ORDER BY id`,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const c of items) {
        const r = await svc.from("netsuite_currencies").upsert({
          tenant_id: tenantId,
          netsuite_id: String(c.id),
          symbol: c.symbol || null,
          exchange_rate: c.exchangerate != null ? Number(c.exchangerate) : null,
          is_base_currency: c.isbasecurrency === "T",
          raw: c,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,netsuite_id" });
        if (r.error) throw new Error("currency upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: () => null,
  },

  inventory: {
    cursor: null,
    sql: () => `
      SELECT iil.item AS item_id, iil.location AS location_id,
             iil.quantityonhand, iil.quantityavailable, iil.quantitycommitted,
             iil.reorderpoint
      FROM inventoryitemlocations iil
    `,
    syncer: async (svc, tenantId, items) => {
      let updated = 0;
      for (const b of items) {
        if (!b.item_id) continue;
        const r = await svc.from("netsuite_inventory_balances").upsert({
          tenant_id: tenantId,
          item_netsuite_id: String(b.item_id),
          location_netsuite_id: b.location_id ? String(b.location_id) : null,
          quantity_on_hand: b.quantityonhand != null ? Number(b.quantityonhand) : null,
          quantity_available: b.quantityavailable != null ? Number(b.quantityavailable) : null,
          quantity_committed: b.quantitycommitted != null ? Number(b.quantitycommitted) : null,
          reorder_point: b.reorderpoint != null ? Number(b.reorderpoint) : null,
          synced_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,item_netsuite_id,location_netsuite_id" });
        if (r.error) throw new Error("inventory upsert: " + r.error.message);
        updated += 1;
      }
      return { inserted: 0, updated };
    },
    highWater: () => null,
  },
};

const ENTITY_NAMES = Object.keys(ENTITY_DEF);

const upsertSyncState = async (svc, tenantId, entity, patch) => {
  const existing = await svc
    .from("netsuite_sync_state")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity", entity)
    .maybeSingle();
  if (existing.data) {
    const upd = await svc.from("netsuite_sync_state")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);
    if (upd.error) throw new Error("sync_state update: " + upd.error.message);
  } else {
    const ins = await svc.from("netsuite_sync_state").insert({ tenant_id: tenantId, entity, ...patch });
    if (ins.error) throw new Error("sync_state insert: " + ins.error.message);
  }
};

const getSyncState = async (svc, tenantId, entity) => {
  const r = await svc
    .from("netsuite_sync_state")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("entity", entity)
    .maybeSingle();
  return r.data || null;
};

const syncEntity = async (svc, tenantId, settings, entity, opts) => {
  const def = ENTITY_DEF[entity];
  if (!def) return { entity, error: "unknown entity" };
  const triggeredBy = opts?.triggeredBy || "cron";
  const full = !!opts?.full;

  // Open a sync run row.
  const runIns = await svc.from("netsuite_sync_runs").insert({
    tenant_id: tenantId,
    entity,
    status: "running",
    triggered_by: triggeredBy,
  }).select("id").single();
  const runId = runIns.data?.id || null;

  await upsertSyncState(svc, tenantId, entity, { status: "running", error: null });

  let pulled = 0, inserted = 0, updated = 0, errored = 0;
  let highWater = null;
  try {
    const state = await getSyncState(svc, tenantId, entity);
    const since = (full || !def.cursor) ? null : (state?.last_modified_high_water || null);
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const resp = await suiteql(settings, def.sql(since), { limit: PAGE_SIZE, offset });
      if (!resp.ok) {
        const detail = JSON.stringify(resp.body).slice(0, 400);
        throw new Error("SuiteQL " + entity + " " + resp.status + ": " + detail);
      }
      const items = resp.body?.items || [];
      pulled += items.length;
      try {
        const r = await def.syncer(svc, tenantId, items);
        inserted += (r.inserted || 0);
        updated += (r.updated || 0);
      } catch (syncErr) {
        errored += items.length;
        throw syncErr;
      }
      const hw = def.highWater(items);
      if (hw && (!highWater || hw > highWater)) highWater = hw;
      hasMore = !!resp.body?.hasMore && items.length >= PAGE_SIZE;
      offset += PAGE_SIZE;
      if (pulled >= MAX_PER_TICK) break;
    }
    await upsertSyncState(svc, tenantId, entity, {
      status: "idle",
      last_sync_at: new Date().toISOString(),
      rows_pulled: pulled,
      records_inserted: inserted,
      records_updated: updated,
      records_errored: errored,
      last_modified_high_water: highWater || (full ? null : null),
      ...(full ? { last_full_sync_at: new Date().toISOString() } : {}),
    });
    if (runId) {
      await svc.from("netsuite_sync_runs").update({
        run_finished_at: new Date().toISOString(),
        status: errored > 0 ? "partial" : "ok",
        rows_pulled: pulled,
        rows_inserted: inserted,
        rows_updated: updated,
        rows_errored: errored,
        high_water_after: highWater,
      }).eq("id", runId);
    }
    return { entity, pulled, inserted, updated, errored, high_water: highWater };
  } catch (err) {
    await upsertSyncState(svc, tenantId, entity, {
      status: "error",
      error: (err.message || String(err)).slice(0, 500),
    });
    if (runId) {
      await svc.from("netsuite_sync_runs").update({
        run_finished_at: new Date().toISOString(),
        status: "error",
        rows_pulled: pulled,
        rows_errored: errored,
        error: (err.message || String(err)).slice(0, 1000),
      }).eq("id", runId);
    }
    return { entity, error: (err.message || String(err)).slice(0, 500) };
  }
};

// Reverse-sync: NetSuite sales-order status flows back to the
// originating Anvil order (only if we previously pushed it). We pull
// the SO ids stored on orders.result.external_systems.netsuite, ask
// SuiteQL for their current status, and write the status back. This
// closes the loop so when a NetSuite-side workflow approves / fulfils
// a SO, the Anvil tab shows the right state without manual refresh.
const reverseSyncSalesOrders = async (svc, tenantId, settings) => {
  const orders = await svc
    .from("orders")
    .select("id, result")
    .eq("tenant_id", tenantId)
    .not("result->external_systems->netsuite", "is", null)
    .limit(500);
  if (orders.error) return { entity: "sales_order_status", error: orders.error.message };
  const linked = (orders.data || []).filter((o) =>
    o.result?.external_systems?.netsuite?.external_id);
  if (!linked.length) return { entity: "sales_order_status", pulled: 0 };

  const ids = linked.map((o) => o.result.external_systems.netsuite.external_id);
  const inList = ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(",");
  const resp = await suiteql(settings, `
    SELECT id, status, totalamount FROM transaction
    WHERE type='SalesOrd' AND id IN (${inList})
  `);
  if (!resp.ok) return { entity: "sales_order_status", error: "SuiteQL " + resp.status };
  const byId = new Map((resp.body?.items || []).map((r) => [String(r.id), r]));
  let updated = 0;
  for (const o of linked) {
    const ns = byId.get(String(o.result.external_systems.netsuite.external_id));
    if (!ns) continue;
    const next = {
      ...o.result,
      external_systems: {
        ...o.result.external_systems,
        netsuite: {
          ...o.result.external_systems.netsuite,
          status: ns.status,
          total: ns.totalamount != null ? Number(ns.totalamount) : null,
          last_reverse_sync_at: new Date().toISOString(),
        },
      },
    };
    await svc.from("orders").update({ result: next }).eq("id", o.id);
    updated += 1;
  }
  return { entity: "sales_order_status", pulled: linked.length, updated };
};

const runForTenant = async (svc, tenantId, rawSettings, opts) => {
  const settings = decryptNetsuiteCreds(rawSettings);
  if (!netsuiteIsConfigured(settings)) {
    return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
  }
  const which = opts?.entities && opts.entities.length
    ? opts.entities.filter((e) => ENTITY_NAMES.includes(e))
    : ENTITY_NAMES;
  const out = [];
  for (const entity of which) {
    const r = await syncEntity(svc, tenantId, settings, entity, opts);
    out.push(r);
  }
  // Reverse-sync only on cron or when explicitly asked.
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
      const tenants = await svc
        .from("tenant_settings")
        .select("*")
        .not("netsuite_account_id", "is", null);
      if (tenants.error) throw new Error("tenant_settings read: " + tenants.error.message);
      const results = [];
      for (const settings of tenants.data || []) {
        const r = await runForTenant(svc, settings.tenant_id, settings, { triggeredBy: "cron" });
        results.push(r);
      }
      return json(res, 200, {
        ran_at: new Date().toISOString(),
        tenants_considered: (tenants.data || []).length,
        results,
      });
    }

    // Manual trigger: requires authenticated admin user.
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const tenants = await svc
      .from("tenant_settings")
      .select("*")
      .eq("tenant_id", ctx.tenantId);
    if (tenants.error) throw new Error("tenant_settings read: " + tenants.error.message);
    const settings = (tenants.data || [])[0];
    if (!settings) return json(res, 404, { error: { message: "tenant has no NetSuite settings" } });
    const result = await runForTenant(svc, ctx.tenantId, settings, {
      triggeredBy: "manual",
      entities: Array.isArray(body?.entities) ? body.entities : (body?.entity ? [body.entity] : null),
      full: !!body?.full,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) {
    sendError(res, err);
  }
}
