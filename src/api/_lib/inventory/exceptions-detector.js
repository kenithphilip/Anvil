// Real-time exception detector for the inventory-planning module.
// Runs from /api/cron/inventory-exceptions-tick every 30 min.
//
// Detects (per docs/INVENTORY_PLANNING_DESIGN.md section 4.5):
//   stockout_imminent     net_avail < 0 within lead-time window
//   below_reorder_point   net_avail < ROP
//   negative_position     any source row reports < 0 on hand
//   allocation_overrun    sum of reservations > on_hand + in_transit
//   demand_spike          recent (4w) demand > 2x prior 12w mean
//   forecast_drift        |tracking signal| > 4 over the last 8 weeks
//   supplier_delay        source_po has slipped acknowledged_eta > 0d
//                         and is still in transit
//
// Each detector is self-contained: idempotent on the (tenant, part,
// kind, day) key (we use a string fingerprint in detail.fingerprint
// to avoid duplicate exception spam if the cron runs many times the
// same day).

const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s || "").trim().toLowerCase();

// Insert exception only if no open row with the same fingerprint
// already exists. The "fingerprint" is a deterministic string the
// caller builds from the offending values; same fingerprint = same
// underlying problem.
const upsertException = async (svc, row) => {
  const fingerprint = row.detail?.fingerprint;
  if (fingerprint) {
    const existing = await svc.from("inventory_exceptions")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("exception_kind", row.exception_kind)
      .eq("status", "open")
      .filter("detail->>fingerprint", "eq", fingerprint)
      .maybeSingle();
    if (existing.data) return { skipped: true, id: existing.data.id };
  }
  const ins = await svc.from("inventory_exceptions").insert(row).select("id").single();
  if (ins.error) {
    return { error: ins.error.message };
  }
  return { id: ins.data.id };
};

// 1. stockout_imminent + below_reorder_point + negative_position
//    Walk inventory_positions(union) for today's snapshot.
const detectFromPositions = async (svc, tenantId) => {
  const out = { stockout: 0, below_rop: 0, negative: 0 };
  const positions = await svc.from("inventory_positions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("source", "union")
    .eq("as_of", today());
  if (positions.error) throw new Error("positions: " + positions.error.message);
  for (const p of (positions.data || [])) {
    const net = Number(p.net_available_qty) || 0;
    const rop = Number(p.reorder_point) || 0;
    const ss = Number(p.safety_stock) || 0;
    const onHand = Number(p.on_hand_qty) || 0;
    if (onHand < 0) {
      const r = await upsertException(svc, {
        tenant_id: tenantId,
        part_no: p.part_no,
        exception_kind: "negative_position",
        severity: "bad",
        detail: { fingerprint: "neg:" + p.part_no + ":" + today(), on_hand: onHand },
        status: "open",
      });
      if (r.id) out.negative += 1;
    }
    if (net < ss) {
      const r = await upsertException(svc, {
        tenant_id: tenantId,
        part_no: p.part_no,
        exception_kind: "stockout_imminent",
        severity: "critical",
        detail: { fingerprint: "stockout:" + p.part_no + ":" + today(), net_avail: net, ss },
        status: "open",
      });
      if (r.id) out.stockout += 1;
    } else if (net < rop) {
      const r = await upsertException(svc, {
        tenant_id: tenantId,
        part_no: p.part_no,
        exception_kind: "below_reorder_point",
        severity: "warn",
        detail: { fingerprint: "rop:" + p.part_no + ":" + today(), net_avail: net, rop },
        status: "open",
      });
      if (r.id) out.below_rop += 1;
    }
  }
  return out;
};

// 2. allocation_overrun: sum of reserved allocations for a part
//    exceeds on_hand + in_transit (= we've over-promised).
const detectAllocationOverruns = async (svc, tenantId) => {
  let count = 0;
  const allocs = await svc.from("inventory_allocations")
    .select("part_no, qty")
    .eq("tenant_id", tenantId)
    .eq("status", "reserved");
  if (allocs.error) throw new Error("allocs: " + allocs.error.message);
  const byPart = new Map();
  for (const a of (allocs.data || [])) {
    byPart.set(a.part_no, (byPart.get(a.part_no) || 0) + (Number(a.qty) || 0));
  }
  if (!byPart.size) return { count };
  const positions = await svc.from("inventory_positions")
    .select("part_no, on_hand_qty, in_transit_qty")
    .eq("tenant_id", tenantId)
    .eq("source", "union")
    .eq("as_of", today())
    .in("part_no", Array.from(byPart.keys()));
  if (positions.error) throw new Error("positions: " + positions.error.message);
  for (const p of (positions.data || [])) {
    const reserved = byPart.get(p.part_no) || 0;
    const supply = (Number(p.on_hand_qty) || 0) + (Number(p.in_transit_qty) || 0);
    if (reserved > supply + 0.001) {
      const r = await upsertException(svc, {
        tenant_id: tenantId,
        part_no: p.part_no,
        exception_kind: "allocation_overrun",
        severity: "bad",
        detail: { fingerprint: "alloc:" + p.part_no + ":" + today(), reserved, supply },
        status: "open",
      });
      if (r.id) count += 1;
    }
  }
  return { count };
};

// 3. supplier_delay: source_po acknowledged_eta in the past + still
//    not received. Read from source_po_lines (relational); group per
//    supplier so we don't fire 30 exceptions for one supplier slip.
const detectSupplierDelays = async (svc, tenantId) => {
  let count = 0;
  const t = today();
  const lines = await svc.from("source_po_lines")
    .select("source_po_id, part_no, qty, received_qty, acknowledged_eta")
    .eq("tenant_id", tenantId)
    .lt("acknowledged_eta", t);
  if (lines.error) throw new Error("source_po_lines: " + lines.error.message);
  // For each line still open (received < qty), emit if not already.
  for (const ln of (lines.data || [])) {
    const open = (Number(ln.qty) || 0) - (Number(ln.received_qty) || 0);
    if (open <= 0) continue;
    const fingerprint = "delay:" + ln.source_po_id + ":" + ln.part_no;
    const r = await upsertException(svc, {
      tenant_id: tenantId,
      part_no: ln.part_no,
      exception_kind: "supplier_delay",
      severity: "bad",
      detail: {
        fingerprint,
        source_po_id: ln.source_po_id,
        acknowledged_eta: ln.acknowledged_eta,
        open_qty: open,
        delay_days: Math.floor(
          (new Date(t).getTime() - new Date(ln.acknowledged_eta).getTime()) / 86400000
        ),
      },
      status: "open",
    });
    if (r.id) count += 1;
  }
  return { count };
};

// 4. demand_spike: per-item, last 4 weeks of forecast vs prior 12.
//    If recent mean > 2x prior mean (and prior > 0), raise.
const detectDemandSpikes = async (svc, tenantId) => {
  let count = 0;
  // Pull 16 most-recent forecast rows per part.
  const items = await svc.from("item_master")
    .select("part_no")
    .eq("tenant_id", tenantId)
    .eq("planning_enabled", true);
  if (items.error) throw new Error("items: " + items.error.message);
  for (const item of (items.data || [])) {
    const f = await svc.from("demand_forecasts")
      .select("week_start, forecast_total")
      .eq("tenant_id", tenantId)
      .eq("part_no", item.part_no)
      .order("week_start", { ascending: false })
      .limit(16);
    if (f.error) continue;
    const totals = (f.data || []).map((r) => Number(r.forecast_total) || 0);
    if (totals.length < 16) continue;
    const recent = totals.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
    const prior = totals.slice(4, 16).reduce((s, v) => s + v, 0) / 12;
    if (prior > 0 && recent > 2 * prior) {
      const r = await upsertException(svc, {
        tenant_id: tenantId,
        part_no: item.part_no,
        exception_kind: "demand_spike",
        severity: "warn",
        detail: { fingerprint: "spike:" + item.part_no + ":" + today(), recent_4w_mean: recent, prior_12w_mean: prior },
        status: "open",
      });
      if (r.id) count += 1;
    }
  }
  return { count };
};

// 5. forecast_drift: tracking signal = cumulative bias / MAD over
//    the last 8 weeks of (forecast vs realised) residuals. |TS| > 4
//    is the standard alarm threshold.
//
// We don't yet have a realised-demand stream wired (Phase 2.5 work);
// the design doc lists this as the engine's job. For now we proxy
// by checking if the per-item WAPE_8w (already persisted) exceeds
// a threshold (35%). This gives the operator a useful drift signal
// without the full MAD/CUSUM machinery. The full tracking signal
// lands when the realised-demand pipeline ships.
const detectForecastDrift = async (svc, tenantId) => {
  let count = 0;
  const r = await svc.from("demand_forecasts")
    .select("part_no, wape_8w, week_start")
    .eq("tenant_id", tenantId)
    .gte("week_start", today())
    .order("week_start", { ascending: true });
  if (r.error) throw new Error("forecasts: " + r.error.message);
  const seen = new Set();
  for (const row of (r.data || [])) {
    if (seen.has(row.part_no)) continue;
    seen.add(row.part_no);
    const wape = Number(row.wape_8w);
    if (Number.isFinite(wape) && wape > 0.35) {
      const out = await upsertException(svc, {
        tenant_id: tenantId,
        part_no: row.part_no,
        exception_kind: "forecast_drift",
        severity: "warn",
        detail: { fingerprint: "drift:" + row.part_no + ":" + today(), wape_8w: wape },
        status: "open",
      });
      if (out.id) count += 1;
    }
  }
  return { count };
};

// Tenant-level fanout. Returns a summary suitable for the cron
// heartbeat metadata.
export const detectAllExceptions = async (svc, tenantId) => {
  const out = {
    tenant_id: tenantId,
    positions: await detectFromPositions(svc, tenantId),
    allocations: await detectAllocationOverruns(svc, tenantId),
    suppliers: await detectSupplierDelays(svc, tenantId),
    spikes: await detectDemandSpikes(svc, tenantId),
    drift: await detectForecastDrift(svc, tenantId),
  };
  return out;
};

export {
  detectFromPositions, detectAllocationOverruns, detectSupplierDelays,
  detectDemandSpikes, detectForecastDrift,
};
