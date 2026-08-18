// Provisional ("-MOD") part numbers, and what makes a BOM final.
//
// A quote for a gun MODIFICATION is priced before engineering has issued the
// real part numbers, so its lines carry provisional codes with a -MOD suffix.
// The rule, from the requirement: a FINAL BOM is one where no part carries the
// -MOD suffix. Until design supplies that, the order is priced against parts
// that do not yet exist.
//
// This is the first part-number shape rule in the codebase — item_master.part_no
// and bom_lines.part_no have no CHECK constraint and no application-level
// validation, and the only existing part-shape code answers a different
// question (looksLikePartCode: "is this token codey", PART_NO_PATTERNS: "which
// spare category is this"). So the rule is defined here, once, and everything
// derives from it rather than each caller re-implementing a suffix test.
//
// Nothing is stored. Whether a quote is a modification quote, and whether a BOM
// is final, are both answered by looking at the parts — so the answer cannot
// drift from the evidence the way a persisted flag would.

// Matches a -MOD suffix, optionally numbered: X-MOD, X-MOD2, X-MOD-3, X_MOD.
//
// Deliberately NOT a substring test. "BRACKET-MODULE" and "MOD-PLATE-7" are
// ordinary part numbers, and treating either as provisional would block an
// order that has nothing wrong with it. The suffix must END the part number,
// and what follows MOD may only be digits or a digit separator.
const MOD_SUFFIX = /[-_]MOD(?:[-_]?\d+)?$/i;

const norm = (v) => String(v == null ? "" : v).trim();

/** Is this part number provisional — i.e. awaiting a final number from design? */
export const isProvisionalPart = (partNo) => {
  const s = norm(partNo);
  return s ? MOD_SUFFIX.test(s) : false;
};

/**
 * The final part number a provisional one is standing in for, or null.
 *
 * Only the suffix is removed — no attempt is made to guess anything else. This
 * is a convenience for display ("TNA-16-04-MOD → TNA-16-04"), NOT a resolution:
 * the real final number comes from design and may differ entirely.
 */
export const baseOfProvisional = (partNo) => {
  const s = norm(partNo);
  if (!MOD_SUFFIX.test(s)) return null;
  const base = s.replace(MOD_SUFFIX, "");
  return base || null;
};

const partOf = (l) => norm(l?.part_no ?? l?.partNumber ?? l?.partNo ?? l?.item_code);

/** Every distinct provisional part in a set of lines, in first-seen order. */
export const provisionalParts = (lines) => {
  const seen = new Set();
  const out = [];
  for (const l of lines || []) {
    const p = partOf(l);
    if (!p || !isProvisionalPart(p)) continue;
    const key = p.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
};

/**
 * Is this a gun-MODIFICATION quote?
 *
 * Derived from the lines rather than declared. order_mode 'SPARES_ASSEMBLY'
 * exists but is picked by hand on the intake screen BEFORE any extraction runs,
 * so it cannot answer this — and a hand-set flag would go stale the moment the
 * lines changed.
 */
export const isModificationQuote = (lines) => provisionalParts(lines).length > 0;

/**
 * Is a BOM final? A BOM is final when it has lines and none of them is
 * provisional.
 *
 * `complete` distinguishes "final" from "there is no BOM yet": an empty BOM has
 * no -MOD parts either, and calling that final would clear the block on an
 * order nobody has engineered.
 */
export const isFinalBom = (lines) => {
  const list = Array.isArray(lines) ? lines : [];
  const pending = provisionalParts(list);
  return {
    complete: list.length > 0,
    final: list.length > 0 && pending.length === 0,
    pending_parts: pending,
    total_parts: list.length,
  };
};

/** The blocking finding raised while an order is priced against provisional parts. */
export const MOD_BOM_FINDING_CODE = "mod_quote_bom_pending";

/**
 * The rule_findings entry for an order whose quoted parts are still
 * provisional, or null when there is nothing to raise.
 *
 * `blocks: true` puts it through the same gate as an extraction shortfall —
 * approval and ERP push refuse until it is resolved — and #449's Reconcile-tab
 * control is what clears it once design has supplied the final numbers.
 */
export const modBomFinding = (lines, opts = {}) => {
  const pending = provisionalParts(lines);
  if (!pending.length) return null;
  const shown = pending.slice(0, 8);
  return {
    code: MOD_BOM_FINDING_CODE,
    rule_id: MOD_BOM_FINDING_CODE,
    severity: "ERROR",
    blocks: true,
    detail:
      `${pending.length} quoted part${pending.length === 1 ? "" : "s"} still provisional (-MOD): `
      + shown.join(", ") + (pending.length > shown.length ? `, +${pending.length - shown.length} more` : "")
      + ". A final BOM from design is needed before this order can be approved.",
    suggested_fix: "Obtain the final BOM from the design team and re-extract, or resolve this finding if the provisional numbers are intentional.",
    pending_parts: pending,
    source_quote_number: opts.sourceQuoteNumber || null,
  };
};
