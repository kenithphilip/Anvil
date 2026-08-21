// Comparing supplier bids that are not in the same currency.
//
// supplier_rfq/matrix.js crowned the winner with
//
//     priced.reduce((a, b) => a.unit_price < b.unit_price ? a : b)
//
// across cells that each carry their own `currency` column — sitting on the
// same row, unread. A JPY bid beat a USD bid on the digits alone, and the
// operator saw a winner badge with no indication that the comparison was
// meaningless. For an importer buying from JP, KR and CN suppliers, that is
// not an edge case; it is the normal shape of an RFQ.
//
// PURE. The caller supplies the rate table.

const n = (v) => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export const normCcy = (c) => (c ? String(c).trim().toUpperCase() : null);

// Convert to the comparison base. A rate of 1 for the base itself; otherwise
// whatever the caller looked up. Returns null when no rate is known — the
// caller must NOT fall back to the raw number, which is the original bug.
export const toBase = (amount, ccy, base, rates) => {
  const a = n(amount);
  if (a == null) return null;
  const from = normCcy(ccy) || base;
  if (from === base) return a;
  const r = n(rates?.[from]);
  return r == null ? null : a * r;
};

// Rank the cells of one RFQ line.
//
// Returns the cells annotated with their base-currency value, plus a verdict
// about whether a winner could honestly be chosen.
//
// THE RULE THAT MATTERS: if any priced cell cannot be converted, NO winner is
// crowned. Picking among the convertible subset would quietly answer a
// different question than the one asked — "cheapest of the ones we could
// price" wearing the label "cheapest".
export const rankCells = (cells, { base = "INR", rates = {} } = {}) => {
  const priced = [];
  const unconvertible = [];

  const annotated = (cells || []).map((c) => {
    const price = n(c.unit_price);
    if (price == null) return { ...c, unit_price_base: null, winner: false };
    const ccy = normCcy(c.currency) || base;
    const converted = toBase(price, ccy, base, rates);
    const cell = {
      ...c,
      currency: ccy,
      unit_price_base: converted == null ? null : Math.round(converted * 10000) / 10000,
      // The basis, so an operator can see WHY one bid beat another rather
      // than trusting a badge.
      fx_rate_used: ccy === base ? 1 : (n(rates?.[ccy]) ?? null),
      winner: false,
    };
    if (converted == null) unconvertible.push(ccy);
    else priced.push(cell);
    return cell;
  });

  if (unconvertible.length) {
    return {
      cells: annotated,
      winner: null,
      comparable: false,
      reason: "missing_fx_rate",
      missing_rates: [...new Set(unconvertible)],
      base,
    };
  }
  if (!priced.length) {
    return { cells: annotated, winner: null, comparable: false, reason: "no_priced_quotes", missing_rates: [], base };
  }

  const best = priced.reduce((a, b) => (a.unit_price_base <= b.unit_price_base ? a : b));
  best.winner = true;

  // A tie on price is a real outcome and the operator should decide it, not
  // discover that whichever row was parsed first silently won.
  const tied = priced.filter((c) => c.unit_price_base === best.unit_price_base);
  return {
    cells: annotated,
    winner: best.vendor_id ?? null,
    comparable: true,
    reason: null,
    tied: tied.length > 1 ? tied.map((c) => c.vendor_id) : [],
    missing_rates: [],
    base,
    // Flagged, not decided: the cheapest bid may also be the slowest, and
    // ranking on price alone cannot see that.
    slowest_is_cheapest: (() => {
      const withLead = priced.filter((c) => n(c.lead_time_days) != null);
      if (withLead.length < 2) return false;
      const maxLead = Math.max(...withLead.map((c) => Number(c.lead_time_days)));
      return n(best.lead_time_days) != null && Number(best.lead_time_days) === maxLead;
    })(),
  };
};

// Which currencies a set of quotes needs a rate for.
export const currenciesNeeded = (quotes, base = "INR") => {
  const out = new Set();
  for (const q of quotes || []) {
    const c = normCcy(q?.currency);
    if (c && c !== base) out.add(c);
  }
  return [...out];
};
