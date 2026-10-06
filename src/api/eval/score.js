// CM P4: the golden scorer — PURE (no DB / no supabase / no auth), so the CI
// regression gate (scripts/eval/golden-gate.mjs) and the offline re-scorer can
// import it without dragging in the request stack.
//
// PR 4 (docs/EXTRACTION_QUALITY.md) made it PROFILE-DRIVEN. It used to hardcode
// one vocabulary — purchase order: poNumber, poDate, customer, grandTotal, and
// lines of { partNo, qty, rate, hsn }. Because every check is guarded by
// `if (expected.X !== undefined)`, a fixture for any other kind of document did
// not fail; it silently scored the two or three fields it happened to share and
// passed. A packing list with a corrupted weight_basis — a 2× error on every
// shipping weight in the container — scored 1.000.
//
// Now the field set comes from a per-kind profile (eval/kind-profiles.js). The
// `po` profile reproduces the previous behaviour exactly: same fields, same
// order, same identity rule, same check names, so the committed fixtures and
// the CI gate do not move. Pass `profile` to score any other kind.

import { profileFor } from "./kind-profiles.js";

const eq = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const nearlyEq = (a, b, tol) => {
  const av = Number(a) || 0;
  const bv = Number(b) || 0;
  if (!av && !bv) return true;
  return Math.abs(av - bv) <= Math.max(0.01, Math.abs(bv) * (tol || 0.005));
};
const cmp = (field, a, b) => (field.compare === "number" ? nearlyEq(a, b) : eq(a, b));

// Read the actual side of a field, honouring any alias the profile declares
// (the PO profile's hsn also answers to hsnCode on a raw line).
const actualValue = (field, line) => {
  if (!line) return undefined;
  if (field.actualAlias) {
    for (const k of field.actualAlias) {
      if (line[k] !== undefined && line[k] !== null && line[k] !== "") return line[k];
    }
  }
  return line[field.key];
};

export const scoreCase = (expected, actual, profile) => {
  const p = profile || profileFor("po");
  const exp = expected || {};
  const checks = [];
  let pass = 0;
  let fail = 0;
  const expect = (name, ok, extra) => {
    checks.push({ name, ok, ...(extra || {}) });
    if (ok) pass++; else fail++;
  };

  for (const f of p.header) {
    if (exp[f.key] === undefined) continue;
    expect(f.key, cmp(f, exp[f.key], actual && actual[f.key]));
  }

  if (exp.lineItems) {
    const expLines = exp.lineItems || [];
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
        const hit = p.identity.rules.some((rule) => {
          const av = rule.actual.map((k) => l[k]).find((v) => v !== undefined && v !== null && v !== "");
          const ev = rule.expected.map((k) => expLine[k]).find((v) => v !== undefined && v !== null && v !== "");
          return eq(av, ev);
        });
        if (hit) { candIdx = i; break; }
      }
      const candidate = candIdx >= 0 ? actLines[candIdx] : null;
      if (candidate) usedActual.add(candIdx);
      // per-line recall. `identity: true` lets a caller compute recall without
      // parsing the check name, which differs per profile.
      expect("line[" + idx + "]." + p.identity.name, !!candidate, { identity: true });
      if (candidate) {
        for (const f of p.line) {
          if (expLine[f.key] === undefined) continue;
          expect("line[" + idx + "]." + f.key, cmp(f, expLine[f.key], actualValue(f, candidate)));
        }
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
