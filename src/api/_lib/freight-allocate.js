// Turning one awarded freight bid into a per-unit cost per part.
//
// Anvil awards a real ocean bid against a consolidation (migration 145) and
// then prices customer quotes with a hand-typed shipping figure, because
// nothing ever carried the awarded number across. This is the arithmetic that
// carries it.
//
// THE BASIS PROBLEM, AND WHY IT IS NOT WEIGHT.
//
// The obvious apportionment is by weight — heavy things cost more to ship.
// item_master.weight_kg and volume_cbm exist for exactly that (migration 145)
// and are EMPTY: 1,000 items sampled from live data, zero with either. Nor is
// that a data-entry backlog — no screen, importer or endpoint in the repo can
// write them, so no operator could supply one if they wanted to. The container
// estimator that depends on them returns recommended_mode "none" for every
// real plan.
//
// Asking operators to key in weights would be a data-entry campaign against a
// master of thousands of parts, which is the opposite of how this product is
// supposed to work. So the allocator ranks the bases it can actually get and
// uses the best one AVAILABLE, rather than the best one imaginable — and it
// always says which it used, because "freight by weight" and "freight by
// value" are different commercial statements and the second must never be
// mistaken for the first.
//
// As weight arrives — from a packing list, a supplier quote that states one, a
// drawing whose material and dimensions imply it — coverage rises and the
// allocator upgrades itself with no change here and no operator action.

const num = (v) => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// Best first. Each returns a positive magnitude per line, or null when that
// line cannot supply it.
export const BASES = Object.freeze([
  {
    code: "weight",
    label: "gross weight",
    of: (l) => {
      if (!l) return null;
      const w = num(l.weight_kg ?? l.weightKg);
      const q = num(l.qty ?? l.quantity);
      return w != null && q != null && w > 0 && q > 0 ? w * q : null;
    },
  },
  {
    code: "volume",
    label: "shipped volume",
    of: (l) => {
      if (!l) return null;
      const v = num(l.volume_cbm ?? l.volumeCbm);
      const q = num(l.qty ?? l.quantity);
      return v != null && q != null && v > 0 && q > 0 ? v * q : null;
    },
  },
  {
    code: "value",
    label: "line value",
    of: (l) => {
      if (!l) return null;
      const direct = num(l.line_amount ?? l.amount ?? l.extended);
      if (direct != null && direct > 0) return direct;
      const rate = num(l.unit_price ?? l.rate ?? l.unitPrice);
      const q = num(l.qty ?? l.quantity);
      return rate != null && q != null && rate > 0 && q > 0 ? rate * q : null;
    },
  },
  {
    code: "quantity",
    label: "unit count",
    of: (l) => {
      if (!l) return null;
      const q = num(l.qty ?? l.quantity);
      return q != null && q > 0 ? q : null;
    },
  },
]);

// Which basis can carry EVERY line.
//
// Deliberately all-or-nothing per basis. A part-weight allocation that silently
// falls back to value for the lines missing a weight would load the costed
// parts twice and under-load the rest — a number that is wrong in a way nobody
// can see. Better to drop to a basis that covers everyone and say so.
export const chooseBasis = (lines, prefer = null) => {
  const rows = Array.isArray(lines) ? lines : [];
  if (!rows.length) return { basis: null, reason: "no_lines" };
  const order = prefer ? [BASES.find((b) => b.code === prefer), ...BASES.filter((b) => b.code !== prefer)].filter(Boolean) : BASES;
  for (const b of order) {
    const vals = rows.map((l) => b.of(l));
    if (vals.every((v) => v != null) && vals.reduce((a, v) => a + v, 0) > 0) {
      return { basis: b.code, label: b.label, reason: null };
    }
  }
  return { basis: null, reason: "no_common_basis" };
};

// Allocate `total` across `lines`.
//
// Returns per-line share and per-unit cost, plus the basis used. The per-unit
// figure is what the price composition's `shipping` component wants: it is a
// per_unit adder in base currency (migration 135).
export const allocateFreight = (total, lines, opts = {}) => {
  const amount = num(total);
  const rows = Array.isArray(lines) ? lines : [];
  const chosen = chooseBasis(rows, opts.prefer || null);

  if (amount == null || amount <= 0) {
    return { ok: false, reason: "no_awarded_amount", basis: null, lines: [], total: amount ?? null };
  }
  if (!chosen.basis) {
    // Reported, not guessed. Splitting evenly across lines would be a fifth
    // basis nobody chose.
    return { ok: false, reason: chosen.reason, basis: null, lines: [], total: amount };
  }

  const fn = BASES.find((b) => b.code === chosen.basis).of;
  const weights = rows.map((l) => fn(l));
  const sum = weights.reduce((a, v) => a + v, 0);

  let running = 0;
  const out = rows.map((l, i) => {
    const share = i === rows.length - 1
      // Last line takes the remainder so the parts always sum to the awarded
      // total. Rounding each independently loses paise, and a freight cost
      // that does not reconcile to the invoice is worse than an uneven one.
      ? r2(amount - running)
      : r2((weights[i] / sum) * amount);
    running = r2(running + share);
    const qty = num(l?.qty ?? l?.quantity) || 0;
    return {
      part_no: l?.part_no || l?.partNumber || null,
      qty,
      basis_value: r6(weights[i]),
      share,
      // What the pricing profile consumes.
      per_unit: qty > 0 ? r6(share / qty) : null,
    };
  });

  return {
    ok: true,
    total: amount,
    basis: chosen.basis,
    basis_label: chosen.label,
    currency: opts.currency || null,
    lines: out,
    // Stated so a consumer can label the number honestly rather than implying
    // a precision the basis does not have.
    approximate: chosen.basis === "value" || chosen.basis === "quantity",
  };
};
