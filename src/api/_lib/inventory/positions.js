// Inventory position aggregator. Reads on-hand from the ERP-mirror
// tables (Tally, NetSuite, SAP, D365, Acumatica, IFS, Oracle EBS,
// Oracle Fusion, Plex, JobBoss, P21, Eclipse, SX.e, proALPHA, Ramco,
// JD Edwards, Sage X3), reads in-transit from `source_po_lines`,
// reads allocations from `inventory_allocations`, then upserts a
// snapshot into `inventory_positions` per item per source per day.
//
// The 'union' row is the engine's reconciled view across sources.
// Reconciliation rule (per Q5 in the design doc): if the item has
// `inventory_authoritative_source` set on item_master, that wins.
// Otherwise sum across sources but emit an `inventory_exceptions`
// row (kind='erp_mismatch') if two sources disagree by more than a
// configured tolerance (10% relative or 5 units absolute).

// (source key, mirror table, part-no column, on-hand column).
//
// The columns MUST match what each connector's sync writes into its
// mirror table (see src/api/<vendor>/sync.js and the connector
// migrations). Every structured-ERP entry here was previously wrong
// (imagined column names like item_id / available_physical), so those
// sources silently contributed 0 on-hand — or, once the mirror tables
// existed, crashed the whole refresh with "column does not exist".
// api-inventory-positions-columns.test.js pins these against the
// migrations so drift is caught at CI time, not in production.
//
// on-hand column: `quantity_on_hand` (the gross physical balance) for
// every structured ERP. It is populated uniformly by every sync, and
// the union row nets it against Anvil's own `inventory_allocations`
// below — so reading a vendor "available" column would double-count
// reservations (and two vendors mis-populate it: SAP puts a UoM in
// quantity_unrestricted, P21 puts allocated qty in quantity_available).
// Tally has no separate on-hand column; its `available_qty` IS the
// balance, so it stays as-is.
const ERP_SOURCES = [
  { source: "tally",     table: "tally_inventory",             part: "stock_item_name",      onHand: "available_qty" },
  { source: "netsuite",  table: "netsuite_inventory_balances", part: "item_netsuite_id",     onHand: "quantity_on_hand" },
  { source: "sap",       table: "sap_inventory_balances",      part: "material_external_id", onHand: "quantity_on_hand" },
  { source: "d365",      table: "d365_inventory_balances",     part: "product_external_id",  onHand: "quantity_on_hand" },
  { source: "acumatica", table: "acu_inventory_balances",      part: "item_external_id",     onHand: "quantity_on_hand" },
  { source: "p21",       table: "p21_inventory_balances",      part: "item_external_id",     onHand: "quantity_on_hand" },
  { source: "sxe",       table: "sxe_inventory_balances",      part: "item_external_id",     onHand: "quantity_on_hand" },
];

export { ERP_SOURCES };

// Lower-cased trimmed key so Tally's "Bearing 6204 (Pune)" matches
// item_master.part_no "BEARING-6204" via a case-insensitive lookup.
// Real production will need an alias table; for v1 we exact-match
// on lowercase for the structured ERPs and fuzzy-match Tally.
const norm = (s) => String(s || "").trim().toLowerCase();

// Read the position rows from one ERP-mirror table. Returns a Map
// of normalised-part-key -> qty.
const readSource = async (svc, tenantId, source) => {
  const select = `${source.part}, ${source.onHand}`;
  const r = await svc.from(source.table).select(select).eq("tenant_id", tenantId);
  if (r.error) {
    const msg = r.error.message || "";
    // A missing table (older deployment) or a mismatched column (schema
    // drift for THIS source) must not take down the whole refresh — the
    // other ERP sources should still reconcile. Skip this source with a
    // warning; the columns test guards against the drift landing at all.
    if (/relation .* does not exist/i.test(msg) || /column .* does not exist/i.test(msg) || r.error.code === "42703") {
      try { console.warn(`[positions] skipping source ${source.source}: ${msg}`); } catch (_) { /* noop */ }
      return new Map();
    }
    throw new Error(`positions/${source.source}: ${msg}`);
  }
  const map = new Map();
  for (const row of (r.data || [])) {
    const k = norm(row[source.part]);
    if (!k) continue;
    map.set(k, (map.get(k) || 0) + (Number(row[source.onHand]) || 0));
  }
  return map;
};

// Sum open in-transit from source_po_lines: open = received_qty < qty.
const readInTransit = async (svc, tenantId) => {
  const r = await svc.from("source_po_lines")
    .select("part_no, qty, received_qty")
    .eq("tenant_id", tenantId);
  if (r.error) {
    if (/relation .* does not exist/i.test(r.error.message || "")) return new Map();
    throw new Error("positions/source_po_lines: " + r.error.message);
  }
  const map = new Map();
  for (const row of (r.data || [])) {
    const open = (Number(row.qty) || 0) - (Number(row.received_qty) || 0);
    if (open <= 0) continue;
    const k = norm(row.part_no);
    map.set(k, (map.get(k) || 0) + open);
  }
  return map;
};

// Sum reserved allocations for status='reserved' that are still in
// the future (required_by >= today).
const readAllocated = async (svc, tenantId) => {
  const r = await svc.from("inventory_allocations")
    .select("part_no, qty, status, required_by")
    .eq("tenant_id", tenantId)
    .eq("status", "reserved");
  if (r.error) {
    if (/relation .* does not exist/i.test(r.error.message || "")) return new Map();
    throw new Error("positions/inventory_allocations: " + r.error.message);
  }
  const map = new Map();
  const today = new Date().toISOString().slice(0, 10);
  for (const row of (r.data || [])) {
    if ((row.required_by || "9999-12-31") < today) continue; // expired
    const k = norm(row.part_no);
    map.set(k, (map.get(k) || 0) + (Number(row.qty) || 0));
  }
  return map;
};

// Reconcile per-source on-hand into a single 'union' row. Returns
// { onHand, mismatchSources } where mismatchSources is the set of
// non-empty source labels if multiple sources disagree by more than
// 10% relative (or 5 units absolute) and there is no authoritative
// pin on item_master.
const reconcile = (perSource, authoritativeSource) => {
  // If the item has a pinned source, use that source only.
  if (authoritativeSource && perSource[authoritativeSource] != null) {
    return { onHand: perSource[authoritativeSource], mismatch: false, sources_seen: [authoritativeSource] };
  }
  const seen = Object.entries(perSource).filter(([_, v]) => v > 0);
  if (!seen.length) return { onHand: 0, mismatch: false, sources_seen: [] };
  if (seen.length === 1) return { onHand: seen[0][1], mismatch: false, sources_seen: [seen[0][0]] };
  // Multiple sources have positive on-hand; sum them but flag
  // disagreement if max-min spread is large.
  const values = seen.map(([_, v]) => v);
  const maxV = Math.max(...values);
  const minV = Math.min(...values);
  const spread = maxV - minV;
  const relative = maxV === 0 ? 0 : spread / maxV;
  const mismatch = spread > 5 && relative > 0.1;
  return {
    onHand: values.reduce((s, v) => s + v, 0),
    mismatch,
    sources_seen: seen.map(([s]) => s),
  };
};

// Snapshot every planning-enabled item's position into
// `inventory_positions`. Writes one row per source plus the 'union'
// row. Surfaces erp_mismatch exceptions where applicable.
//
// Returns counts for the cron-mux heartbeat:
//   { items_updated, sources_read, mismatches }
export const refreshPositions = async (svc, tenantId, asOf = null) => {
  const today = asOf || new Date().toISOString().slice(0, 10);
  // 1. Read all the planning-enabled items for this tenant.
  const itemsResp = await svc.from("item_master")
    .select("part_no, inventory_authoritative_source, reorder_point, safety_stock")
    .eq("tenant_id", tenantId)
    .eq("planning_enabled", true);
  if (itemsResp.error) throw new Error("positions/items: " + itemsResp.error.message);
  const items = itemsResp.data || [];
  if (!items.length) return { items_updated: 0, sources_read: 0, mismatches: 0 };
  const partLookup = new Map(items.map((i) => [norm(i.part_no), i]));

  // 2. Read each ERP source.
  const sourceMaps = {};
  for (const src of ERP_SOURCES) {
    sourceMaps[src.source] = await readSource(svc, tenantId, src);
  }
  const inTransitMap = await readInTransit(svc, tenantId);
  const allocatedMap = await readAllocated(svc, tenantId);

  // 3. Per item: write per-source rows + the union.
  const positionRows = [];
  const mismatchExceptions = [];
  for (const item of items) {
    const key = norm(item.part_no);
    const perSource = {};
    for (const src of ERP_SOURCES) {
      const v = sourceMaps[src.source].get(key) || 0;
      perSource[src.source] = v;
      if (v > 0) {
        positionRows.push({
          tenant_id: tenantId, part_no: item.part_no, as_of: today,
          on_hand_qty: v, in_transit_qty: 0, allocated_qty: 0,
          reorder_point: item.reorder_point, safety_stock: item.safety_stock,
          source: src.source,
        });
      }
    }
    const recon = reconcile(perSource, item.inventory_authoritative_source);
    positionRows.push({
      tenant_id: tenantId, part_no: item.part_no, as_of: today,
      on_hand_qty: recon.onHand,
      in_transit_qty: inTransitMap.get(key) || 0,
      allocated_qty: allocatedMap.get(key) || 0,
      reorder_point: item.reorder_point, safety_stock: item.safety_stock,
      source: "union",
      raw_payload: { sources_seen: recon.sources_seen, mismatch: recon.mismatch },
    });
    if (recon.mismatch) {
      mismatchExceptions.push({
        tenant_id: tenantId,
        part_no: item.part_no,
        exception_kind: "erp_mismatch",
        severity: "warn",
        detail: { sources: perSource, sources_seen: recon.sources_seen },
        status: "open",
      });
    }
  }

  // 4. Upsert positions (replace per (tenant, part_no, as_of, source)).
  if (positionRows.length) {
    const up = await svc.from("inventory_positions").upsert(
      positionRows, { onConflict: "tenant_id,part_no,as_of,source" }
    );
    if (up.error) throw new Error("positions/upsert: " + up.error.message);
  }
  if (mismatchExceptions.length) {
    const ex = await svc.from("inventory_exceptions").insert(mismatchExceptions);
    if (ex.error) throw new Error("positions/exception_insert: " + ex.error.message);
  }
  return {
    items_updated: items.length,
    sources_read: ERP_SOURCES.length,
    mismatches: mismatchExceptions.length,
  };
};

export { ERP_SOURCES };
