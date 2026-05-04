// POST or GET /api/netsuite/sync
//
// Pulls fresh data from NetSuite into the local mirror tables.
// Cron-only: gated by CRON_SECRET. Same auth pattern as
// /api/agents/run. The cron entry in vercel.json fires this every
// 30 minutes for every tenant with NetSuite configured.
//
// v1 syncs three entities:
//   - customer  -> upserts by external_ref into customers
//   - item      -> upserts by part_no into item_master
//   - sales_order -> mirrors into netsuite_open_orders
//
// Each entity has its own sync_state row (unique per (tenant,
// entity)). On error we mark the row as `error` with the detail and
// move on; one failing entity does not block the others.

import { applyCors, handlePreflight, json } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { suiteql, netsuiteIsConfigured } from "../_lib/netsuite-client.js";

const CRON_SECRET = process.env.CRON_SECRET;

const ENTITY_QUERIES = {
  customer:    "SELECT id, entityid, companyname, email, datecreated FROM customer ORDER BY id",
  item:        "SELECT id, itemid, displayname, salesdescription, baseprice FROM item WHERE isinactive='F' ORDER BY id",
  sales_order: "SELECT id, tranid, entity AS customer_id, status, totalamount, currencyname, trandate FROM transaction WHERE type='SalesOrd' AND status NOT IN ('Closed','Cancelled') ORDER BY trandate DESC",
};

const PAGE_SIZE = 200;

const upsertSyncState = async (svc, tenantId, entity, patch) => {
  const existing = await svc
    .from("netsuite_sync_state")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity", entity)
    .maybeSingle();
  if (existing.data) {
    await svc.from("netsuite_sync_state")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);
  } else {
    await svc.from("netsuite_sync_state").insert({ tenant_id: tenantId, entity, ...patch });
  }
};

const syncCustomers = async (svc, tenantId, settings, items) => {
  for (const c of items) {
    await svc.from("customers").upsert({
      tenant_id: tenantId,
      customer_key: "ns:" + c.id,
      customer_name: c.companyname || c.entityid || ("Customer " + c.id),
      contact_email: c.email || null,
      external_ref: { netsuite_id: c.id, datecreated: c.datecreated },
    }, { onConflict: "tenant_id,customer_key" });
  }
};

const syncItems = async (svc, tenantId, settings, items) => {
  for (const it of items) {
    await svc.from("item_master").upsert({
      tenant_id: tenantId,
      part_no: it.itemid || ("ns-" + it.id),
      description: it.displayname || it.salesdescription || null,
      list_price: it.baseprice || null,
      external_ref: { netsuite_id: it.id },
    }, { onConflict: "tenant_id,part_no" });
  }
};

const syncSalesOrders = async (svc, tenantId, settings, items) => {
  for (const so of items) {
    await svc.from("netsuite_open_orders").upsert({
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
  }
};

const ENTITY_SYNCERS = {
  customer: syncCustomers,
  item: syncItems,
  sales_order: syncSalesOrders,
};

const syncEntity = async (svc, tenantId, settings, entity) => {
  await upsertSyncState(svc, tenantId, entity, { status: "running", error: null });
  try {
    let pulled = 0;
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const resp = await suiteql(settings, ENTITY_QUERIES[entity], { limit: PAGE_SIZE, offset });
      if (!resp.ok) {
        throw new Error("SuiteQL " + entity + " " + resp.status + ": " + JSON.stringify(resp.body).slice(0, 200));
      }
      const items = resp.body?.items || [];
      pulled += items.length;
      const syncer = ENTITY_SYNCERS[entity];
      if (syncer) await syncer(svc, tenantId, settings, items);
      hasMore = !!resp.body?.hasMore && items.length >= PAGE_SIZE;
      offset += PAGE_SIZE;
      // Guard rail: do not pull more than 5000 rows per entity per
      // tick. v2 should checkpoint a cursor + resume.
      if (pulled >= 5000) break;
    }
    await upsertSyncState(svc, tenantId, entity, {
      status: "idle",
      last_sync_at: new Date().toISOString(),
      rows_pulled: pulled,
    });
    return { entity, pulled };
  } catch (err) {
    await upsertSyncState(svc, tenantId, entity, {
      status: "error",
      error: err.message || String(err),
    });
    return { entity, error: err.message };
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return json(res, 401, { error: { message: "netsuite sync is cron-only" } });
  }
  try {
    const svc = serviceClient();
    const tenants = await svc
      .from("tenant_settings")
      .select("tenant_id, netsuite_account_id, netsuite_consumer_key, netsuite_consumer_secret, netsuite_token_id, netsuite_token_secret, netsuite_connected_at")
      .not("netsuite_account_id", "is", null);
    if (tenants.error) throw new Error("tenant_settings read: " + tenants.error.message);

    const results = [];
    for (const settings of tenants.data || []) {
      if (!netsuiteIsConfigured(settings)) {
        results.push({ tenant_id: settings.tenant_id, skipped: true });
        continue;
      }
      for (const entity of Object.keys(ENTITY_QUERIES)) {
        const r = await syncEntity(svc, settings.tenant_id, settings, entity);
        results.push({ tenant_id: settings.tenant_id, ...r });
      }
    }

    return json(res, 200, {
      ran_at: new Date().toISOString(),
      tenants_considered: (tenants.data || []).length,
      results,
    });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
}
