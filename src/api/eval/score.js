// CM P4: the golden scorer — PURE (no DB / no supabase / no auth), so the CI
// regression gate (scripts/eval/golden-gate.mjs) and the offline re-scorer can
// import it without dragging in the request stack. Compares an `expected`
// golden against an `actual` extraction, both in the flat "order" vocabulary
// (poNumber, poDate, customer, grandTotal, lineItems:[{partNo,qty,rate,hsn}]);
// use eval-normalize.js to get there from a salesOrder or a raw normalized.

const eq = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const nearlyEq = (a, b, tol) => {
  const av = Number(a) || 0;
  const bv = Number(b) || 0;
  if (!av && !bv) return true;
  return Math.abs(av - bv) <= Math.max(0.01, Math.abs(bv) * (tol || 0.005));
};

export const scoreCase = (expected, actual) => {
  const checks = [];
  let pass = 0;
  let fail = 0;
  const expect = (name, ok) => {
    checks.push({ name, ok });
    if (ok) pass++; else fail++;
  };
  if (expected.poNumber !== undefined) expect("poNumber", eq(expected.poNumber, actual && actual.poNumber));
  if (expected.poDate !== undefined) expect("poDate", eq(expected.poDate, actual && actual.poDate));
  if (expected.customer !== undefined) expect("customer", eq(expected.customer, actual && actual.customer));
  if (expected.grandTotal !== undefined) expect("grandTotal", nearlyEq(expected.grandTotal, actual && actual.grandTotal));
  if (expected.lineItems) {
    const expLines = expected.lineItems || [];
    const actLines = (actual && actual.lineItems) || [];
    expect("lineItemCount", expLines.length === actLines.length);
    // Match each expected line to a DISTINCT actual line (no reuse), so one
    // actual line can't satisfy several expected lines and inflate recall.
    const usedActual = new Set();
    expLines.forEach((expLine, idx) => {
      let candIdx = -1;
      for (let i = 0; i < actLines.length; i++) {
        if (usedActual.has(i)) continue;
        const l = actLines[i];
        if (eq(l.partNo || l.sellerPartNo, expLine.partNo)
            || eq(l.itemName || l.tallyItemName, expLine.itemName || expLine.partNo)) {
          candIdx = i;
          break;
        }
      }
      const candidate = candIdx >= 0 ? actLines[candIdx] : null;
      if (candidate) usedActual.add(candIdx);
      expect("line[" + idx + "].partNo", !!candidate);   // per-line recall
      if (candidate) {
        if (expLine.qty !== undefined) expect("line[" + idx + "].qty", nearlyEq(expLine.qty, candidate.qty));
        if (expLine.rate !== undefined) expect("line[" + idx + "].rate", nearlyEq(expLine.rate, candidate.rate));
        if (expLine.hsn !== undefined) expect("line[" + idx + "].hsn", eq(expLine.hsn, candidate.hsnCode || candidate.hsn));
      }
    });
    // Precision: every actual line should map to an expected line. Unmatched
    // actual lines are extras / hallucinations — a recall-only scorer rewards
    // a model that over-extracts, so penalise them explicitly.
    if (actLines.length) {
      expect("line_precision", actLines.length - usedActual.size === 0);
    }
  }
  return { pass, fail, total: pass + fail, score: pass + fail === 0 ? 0 : pass / (pass + fail), checks };
};
