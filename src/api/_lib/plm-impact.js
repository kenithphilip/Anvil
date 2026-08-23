// Which engineering changes actually touch us.
//
// plm/sync pulls ECOs from Windchill or Arena into plm_changes on every cron
// tick. Nothing has ever read that table — one reference in the whole
// codebase, the upsert that fills it — so a supplier releasing a change
// against a part we buy produced a row and no consequence. The sync burned the
// API call, wrote the record, and told nobody.
//
// An ECO is only interesting when it names a part we hold. A Windchill
// instance carries changes for the supplier's entire catalogue, and alerting
// on all of them is the fastest way to have the alerts turned off. So the
// intersection is the whole feature: affected_parts against what we actually
// have in item_master.
//
// Pure — no I/O — so the matching is testable on its own and the caller owns
// the queries.

// The comparison key.
//
// trim + uppercase, the same convention quote-ingest uses to resolve a part_no
// against item_master. Deliberately NOT stripping punctuation or spaces:
// "AB-1042-7" and "AB10427" may well be different parts, and a matcher that
// guesses they are the same raises an alert about a part nobody has.
export const partKey = (s) => String(s == null ? "" : s).trim().toUpperCase();

// Every distinct part named across a batch of changes, as keys — what the
// caller needs for a single bounded `.in("part_no", …)` lookup rather than one
// query per change.
export const affectedPartKeys = (changes) => {
  const keys = new Set();
  for (const c of changes || []) {
    const parts = Array.isArray(c?.affected_parts) ? c.affected_parts : [];
    for (const p of parts) {
      const k = partKey(p);
      if (k) keys.add(k);
    }
  }
  return [...keys];
};

// Pair each change with the parts it names that we actually hold.
//
// `knownParts` is whatever item_master returned — an array of part numbers or
// a Set of keys. Changes matching nothing are dropped, not returned with an
// empty list: the caller's job is to alert, and "this ECO affects none of your
// parts" is not an alert.
//
// The ORIGINAL spelling is what comes back in `matched`, not the key, because
// this ends up in front of a person who has to find the part on a drawing.
export const matchChangesToParts = (changes, knownParts) => {
  const known = knownParts instanceof Set
    ? knownParts
    : new Set((Array.isArray(knownParts) ? knownParts : []).map(partKey).filter(Boolean));
  const out = [];
  for (const c of changes || []) {
    const parts = Array.isArray(c?.affected_parts) ? c.affected_parts : [];
    const matched = [];
    const seen = new Set();
    for (const p of parts) {
      const k = partKey(p);
      // A change listing the same part twice is one impact, not two.
      if (!k || seen.has(k) || !known.has(k)) continue;
      seen.add(k);
      matched.push(p);
    }
    if (matched.length) out.push({ change: c, matched });
  }
  return out;
};

// One line a person can act on, for the notification body.
//
// Names the ECO the way the source system does, so it can be looked up there,
// and lists the parts rather than counting them — "affects 3 of your parts" is
// a number; "affects TWS-BODY-02" is a thing to go and check. Capped, because
// an ECO can name hundreds and a notification is not a report.
export const describeImpact = ({ change, matched }, opts = {}) => {
  const cap = Math.max(1, Number(opts.maxParts) || 8);
  const shown = matched.slice(0, cap);
  const rest = matched.length - shown.length;
  const ref = change?.eco_number || change?.external_id || "(unnumbered)";
  const status = change?.status ? " [" + change.status + "]" : "";
  const when = change?.effective_date ? " effective " + change.effective_date : "";
  return ref + status + when + " — " + change?.title
    + " — affects " + shown.join(", ") + (rest > 0 ? " and " + rest + " more" : "");
};
