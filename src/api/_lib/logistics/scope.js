// What the logistics monitor is allowed to look at, and what it may close.
//
// The detector was written for a steady-state stream and is switched on against
// years of history, which is a different problem. Enabling it on a tenant with a
// real backlog produced ~2,000 exceptions on the first tick, nearly all
// `critical`, including records that were already finished.
//
// Four decisions, isolated here so they are testable without a database:
//
//   1. A LOOKBACK WINDOW. Nothing older than the window is scanned at all.
//   2. NEWEST-FIRST ordering, so a genuinely urgent record raised yesterday is
//      reachable instead of sitting behind 500 older ones.
//   3. A PER-RUN RAISE CAP. This is what actually bounds the burst. The window
//      and the ordering only change WHICH rows are scanned — with a 90-day
//      window and 3-14 day SLAs, most of what remains is still past 2x SLA and
//      still lands `critical`. A measured simulation of the windowed, newest-
//      first detector on a dense tenant produced 938 exceptions, 727 of them
//      critical: a filter is not a cap, and only a cap bounds a backlog.
//   4. AUTO-RESOLVE, for any object the run actually EXAMINED. Absence from
//      this run's flags means "condition cleared" only if the object was looked
//      at; for one that aged out of the window it means nothing, and closing it
//      would be a lie. Objects that left the scan population entirely (a PO that
//      reached RECEIVED) are reconciled separately, against their real status —
//      otherwise the commonest way a condition clears is the one way the
//      exception could never close.

const DAY_MS = 86400000;

/** Default window. Wide enough to cover a slow foreign PO cycle, far short of "all history". */
export const DEFAULT_LOOKBACK_DAYS = 90;

export const lookbackDays = () => {
  const raw = Number(process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(3650, Math.floor(raw));
};

export const lookbackCutoff = (now = Date.now(), days = lookbackDays()) =>
  new Date((now instanceof Date ? now.getTime() : now) - days * DAY_MS).toISOString();

/**
 * Statuses the monitor scans.
 *
 * RECEIVED source POs and RECONCILED orders are deliberately absent. Both are
 * terminal — the goods arrived, the order closed — and scan.js treats RECEIVED
 * as "acknowledged", so every historical received PO without an
 * `acknowledged_eta` flagged `ready_date_missing` forever. Chasing a ready date
 * for something already received is noise, and it was a large share of the
 * first-run burst.
 *
 * scan.js keeps its own broader lists: it also backs the read-only delays
 * screen, where showing a received PO is harmless. The monitor narrows what it
 * FEEDS scan.js rather than changing shared rule logic.
 */
export const PO_SCAN_STATUSES = Object.freeze([
  "SENT_TO_SUPPLIER", "SUPPLIER_ACK", "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED",
]);
export const ISO_SCAN_STATUSES = Object.freeze(["APPROVED", "DISPATCHED"]);
export const ORDER_SCAN_STATUSES = Object.freeze([
  "APPROVED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT",
]);

/** Which fetched population each rule_kind draws its objects from. */
export const KIND_SOURCE = Object.freeze({
  po_source_country: "source_po",
  po_local_supplier: "source_po",
  ready_date_missing: "source_po",
  ready_date_orphan: "source_po",
  work_order_manufacturing: "internal_so",
  dispatch_overdue: "order",
  customer_delivery_at_risk: "order",
  customer_delivery_overdue: "order",
});

/**
 * How many NEW exceptions one run may raise.
 *
 * The real bound on the burst. Flags are recomputed from scratch every run, so
 * anything skipped here is simply raised on a later tick — nothing is lost, and
 * the queue grows at a rate an operator can work through instead of arriving as
 * a wall. scan() already sorts by severity then elapsed, so the cap keeps the
 * most severe and takes the tail next time.
 */
export const maxRaisePerRun = () => {
  const raw = Number(process.env.LOGISTICS_MAX_RAISE_PER_RUN);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.floor(raw);
};

/**
 * Statuses meaning the work is done, per object type.
 *
 * Used to close an exception whose object has left the scan population. A source
 * PO reaching RECEIVED is the commonest way a procurement exception clears, and
 * it is precisely the transition that removes the PO from PO_SCAN_STATUSES — so
 * without this pass the dominant clearing event is the one the detector can
 * never observe, and those exceptions stay open forever.
 */
export const TERMINAL_STATUSES = Object.freeze({
  source_po: new Set(["RECEIVED", "CLOSED", "CANCELLED"]),
  internal_so: new Set(["DISPATCHED", "COMPLETED", "CLOSED", "CANCELLED"]),
  order: new Set(["RECONCILED", "CANCELLED", "CLOSED"]),
});

export const isTerminal = (objectType, status) =>
  !!TERMINAL_STATUSES[objectType]?.has(String(status || "").toUpperCase());

/**
 * Open exceptions whose condition no longer holds.
 *
 * `examined` maps object_type -> Set of ids this run actually read. `flagged` is
 * the set of `kind:object_id` fingerprints this run raised.
 *
 * An exception closes when its object was examined AND produced no flag.
 * Anything not examined is left open — an object outside the window is simply
 * unknown, and "unknown" must never be reported to an operator as "fixed".
 *
 * Truncation deliberately does NOT block this. An earlier version skipped every
 * kind whose population hit its row cap, reasoning that the read was partial.
 * That was wrong twice over: partial knowledge of the POPULATION says nothing
 * about an individual object we did read and fully evaluated (shipments are
 * scoped to exactly those objects, so their rules had complete inputs) — and on
 * the dense tenant this was built for, all three populations hit the cap on
 * every run, so the guard disabled auto-resolve permanently. The safety valve
 * shut itself off in exactly the situation it existed for.
 */
export const resolvableExceptions = (openRows, { examined, flagged } = {}) => {
  const seenFlags = flagged instanceof Set ? flagged : new Set(flagged || []);
  const out = [];
  for (const e of openRows || []) {
    const source = KIND_SOURCE[e?.rule_kind];
    // A rule this build does not know how to source cannot be judged.
    if (!source) continue;
    const ids = examined?.[source];
    if (!ids || !ids.has(e.object_id)) continue;   // not looked at -> not cleared
    const fp = e.detail?.fingerprint || `${e.rule_kind}:${e.object_id}`;
    if (seenFlags.has(fp)) continue;               // still flagged -> still open
    out.push(e);
  }
  return out;
};

/**
 * Whether a fingerprint may be raised again, given what already exists for it.
 *
 * Dedup used to look only at `status='open'`, so acknowledging an exception
 * removed it from the guard AND from the partial unique index, and the very next
 * tick re-created it. The operator's acknowledgement survived about five
 * minutes, which makes the queue impossible to work down.
 *
 *   open         already raised; ratchet severity, do not duplicate
 *   acknowledged the operator has seen it; leave it alone
 *   suppressed   the operator asked never to see it again; honour that
 *   resolved     it cleared and has come back — a genuine recurrence, raise it
 */
export const raiseDecision = (existing) => {
  if (!existing) return { action: "insert" };
  if (existing.status === "open") return { action: "update", id: existing.id };
  if (existing.status === "acknowledged" || existing.status === "suppressed") {
    return { action: "skip", reason: existing.status };
  }
  return { action: "insert" };                     // resolved -> recurrence
};

/**
 * Pick the most relevant prior row for a fingerprint.
 *
 * Suppression outranks everything, then an acknowledgement, then an open row;
 * a resolved row only wins when nothing else exists, so a recurrence after a
 * resolve still raises while a suppression keeps holding.
 */
const STATUS_RANK = { suppressed: 4, acknowledged: 3, open: 2, resolved: 1 };
export const pickExisting = (rows) => {
  let best = null;
  for (const r of rows || []) {
    if (!best) { best = r; continue; }
    const a = STATUS_RANK[r.status] || 0;
    const b = STATUS_RANK[best.status] || 0;
    if (a > b) best = r;
    else if (a === b && Date.parse(r.created_at || 0) < Date.parse(best.created_at || 0)) best = r;
  }
  return best;
};
