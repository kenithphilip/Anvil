// "How many times has this slipped, and is it still going to make the date?"
//
// Everything here is DERIVED from the shipment_eta_observations log (migration
// 212). Nothing is a stored counter.
//
// That is the whole design decision. The daily workbook carries its own
// hand-maintained "No. of Delays" column, and mirroring it into a column would
// have imported a number Anvil could never verify and that could silently
// disagree with the dates beside it. A count computed from the evidence cannot.
//
// The counter is also the wrong thing to act on. A shipment revised five times
// that still lands three weeks inside its commitment needs nobody's attention; a
// shipment revised once that now lands two days late is the emergency. Slip is
// the input to that judgement, not the answer — the answer is float against the
// customer's promised date, which P2 computes on top of this.

const DAY = 86400000;

const asDate = (v) => {
  if (!v) return null;
  const t = Date.parse(typeof v === "string" && v.length === 10 ? v + "T00:00:00Z" : v);
  return Number.isFinite(t) ? t : null;
};

/** Whole days from a to b, positive when b is later. Null unless both parse. */
export const dayDelta = (a, b) => {
  const from = asDate(a);
  const to = asDate(b);
  if (from == null || to == null) return null;
  return Math.round((to - from) / DAY);
};

/** Oldest first. The log is written in order, but a caller may hand us anything. */
const chronological = (rows) =>
  [...(rows || [])].filter(Boolean).sort((a, b) =>
    Date.parse(a.observed_at || 0) - Date.parse(b.observed_at || 0));

/**
 * The promise carried by a normalized pending row, and whether it is degraded.
 *
 * The frontend parses the workbook client-side and the server uses those rows
 * AS-IS, so `eta_port_current` — added with this feature — only exists if the
 * browser is running a current bundle. A tab opened before the deploy posts rows
 * without it, and the naive read produced `{ null, null }`, `etaChanged` said
 * "nothing moved", and the import recorded NOTHING while reporting success. A
 * server-side feature silently gated on client-side freshness is a bad design,
 * and this is the guard against it.
 *
 * The fallback fields predate this feature and carry the ORIGINAL promise
 * (occurrence 0 of the duplicated headers). That is exactly right for a
 * baseline, so an old client still seeds the log correctly — it just cannot
 * detect revisions, because the field it reads never moves. Once the browser
 * updates, the next import compares the real current ETA against that baseline
 * and the revision surfaces.
 *
 * Presence of the KEY, not its value, decides: a current bundle always sets both
 * keys, even to "" for a shipment with no ETA on the sheet.
 */
export const resolvePromise = (n) => {
  const current = !!n && ("eta_port_current" in n || "eta_store_current" in n);
  if (current) {
    return { eta_port: n.eta_port_current || null, eta_store: n.eta_store_current || null, degraded: false };
  }
  return { eta_port: n?.eta_india || null, eta_store: n?.eta_store || null, degraded: true };
};

/**
 * Has the promise moved since the last observation?
 *
 * The write gate: a row is added only when this returns a change, so every row
 * in the log is a real revision and re-importing an unchanged workbook is free.
 * A field going from a date to NULL is NOT a change — sheets drop a column or
 * leave a cell blank routinely, and treating that as a revision would
 * manufacture slip out of a formatting accident.
 */
export const etaChanged = (prev, next) => {
  if (!next) return false;
  const moved = (a, b) => !!b && a !== b;
  if (!prev) return !!(next.eta_port || next.eta_store);
  return moved(prev.eta_port, next.eta_port) || moved(prev.eta_store, next.eta_store);
};

/**
 * The observation row to write, or null when nothing moved.
 *
 * Carries the previous values and the per-step movement so one row reads on its
 * own; cumulative slip against the baseline stays derived in summarise().
 */
export const buildObservation = (prev, next, { tenantId, shipmentId, source, observedAt } = {}) => {
  if (!etaChanged(prev, next)) return null;
  // A field the new sheet left blank keeps its previous value rather than
  // recording a regression to null.
  const eta_port = next.eta_port || prev?.eta_port || null;
  const eta_store = next.eta_store || prev?.eta_store || null;
  return {
    tenant_id: tenantId,
    shipment_id: shipmentId,
    eta_port,
    eta_store,
    prev_eta_port: prev?.eta_port || null,
    prev_eta_store: prev?.eta_store || null,
    slip_port_days: prev ? dayDelta(prev.eta_port, eta_port) : null,
    slip_store_days: prev ? dayDelta(prev.eta_store, eta_store) : null,
    kind: prev ? "revision" : "baseline",
    source: source || "workbook_import",
    observed_at: observedAt || new Date().toISOString(),
  };
};

/**
 * The whole history of one shipment, reduced to what an operator asks.
 *
 * `revisions` counts CHANGES, so a shipment observed once has 0 — it has been
 * promised, not delayed. Counting rows would report 1 and quietly overstate
 * every shipment in the system by one.
 *
 * `slip_*_days` is cumulative against the BASELINE, not the sum of steps: a
 * promise that moved out two weeks and then back one has slipped seven days, and
 * summing absolute movements would call that twenty-one.
 */
export const summarise = (rows) => {
  const log = chronological(rows);
  if (!log.length) {
    return {
      revisions: 0, has_history: false,
      baseline_eta_port: null, baseline_eta_store: null,
      current_eta_port: null, current_eta_store: null,
      slip_port_days: null, slip_store_days: null,
      last_changed_at: null, worst_single_slip_days: null, improving: false,
    };
  }
  const first = log[0];
  const last = log[log.length - 1];
  const steps = log.filter((r) => r.kind !== "baseline");
  const slips = steps
    .map((r) => Math.max(r.slip_store_days ?? -Infinity, r.slip_port_days ?? -Infinity))
    .filter((n) => Number.isFinite(n));
  return {
    revisions: steps.length,
    has_history: true,
    baseline_eta_port: first.eta_port || null,
    baseline_eta_store: first.eta_store || null,
    current_eta_port: last.eta_port || null,
    current_eta_store: last.eta_store || null,
    slip_port_days: dayDelta(first.eta_port, last.eta_port),
    slip_store_days: dayDelta(first.eta_store, last.eta_store),
    last_changed_at: steps.length ? steps[steps.length - 1].observed_at : first.observed_at,
    worst_single_slip_days: slips.length ? Math.max(...slips) : null,
    // Pulled IN since the last revision. Worth distinguishing: a supplier
    // recovering is not the same as one that has stopped reporting.
    improving: steps.length > 0 && (steps[steps.length - 1].slip_store_days ?? 0) < 0,
  };
};

/**
 * One line an operator can read without opening the history.
 *
 * Deliberately states the movement, not a severity. Whether a slip matters
 * depends on float against the customer's date, which this module does not know
 * — saying "3 days late" here would be a claim it cannot support.
 */
export const describe = (summary) => {
  if (!summary?.has_history) return null;
  if (!summary.revisions) return "ETA unchanged since first reported";
  const n = summary.revisions;
  const times = n === 1 ? "once" : `${n} times`;
  const slip = summary.slip_store_days ?? summary.slip_port_days;
  if (slip == null) return `Revised ${times}`;
  if (slip === 0) return `Revised ${times}, back to the original date`;
  const dir = slip > 0 ? "later" : "earlier";
  return `Revised ${times}, now ${Math.abs(slip)}d ${dir} than first promised`;
};
