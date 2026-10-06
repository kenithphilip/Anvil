// CM P4 gating: the committed golden fixtures must each score at/above their
// baseline through the pure scorer + shape adapter — this is what the CI
// `eval:golden` gate enforces, mirrored here so a local `npm test` catches an
// accuracy regression too.
//
// PR 4 (docs/EXTRACTION_QUALITY.md): fixtures now declare a `kind` and are read
// through that kind's scoring profile. The three PO fixtures declare no kind
// and must keep scoring exactly as they did. The non-PO fixtures each guard a
// field the old PO-only scorer dropped before scoring — which is why a defect
// in them used to score 1.000.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCase } from "../api/eval/score.js";
import { profileFor, toScorableFor, SCORABLE_KINDS } from "../api/eval/kind-profiles.js";
import { normalizedToScorable } from "../api/eval/eval-normalize.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "eval", "fixtures");
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
const load = (f) => JSON.parse(readFileSync(join(fixturesDir, f), "utf8"));
const scoreFixture = (fx, normalized) => {
  const profile = profileFor(fx.kind || "po");
  return scoreCase(fx.expected, toScorableFor(normalized || fx.normalized, profile), profile);
};

describe("golden fixtures", () => {
  it("has committed fixtures to gate on", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("covers more than purchase orders", () => {
    const kinds = new Set(files.map((f) => load(f).kind || "po"));
    expect(kinds.size).toBeGreaterThan(1);
    for (const k of kinds) expect(SCORABLE_KINDS).toContain(k);
  });

  for (const file of files) {
    const fx = load(file);
    it(`${fx.id || file} scores at/above baseline`, () => {
      const scored = scoreFixture(fx);
      const baseline = typeof fx.baseline_score === "number" ? fx.baseline_score : 1;
      expect(scored.score).toBeGreaterThanOrEqual(baseline - 0.0005);
    });
  }

  it("the PO fixtures score identically through the profile and the legacy adapter", () => {
    // The refactor must not move the number the CI gate has been enforcing.
    for (const file of files) {
      const fx = load(file);
      if (fx.kind && fx.kind !== "po") continue;
      const legacy = scoreCase(fx.expected, normalizedToScorable(fx.normalized));
      const viaProfile = scoreFixture(fx);
      expect(viaProfile.score).toBe(legacy.score);
      expect(viaProfile.checks.map((c) => c.name)).toEqual(legacy.checks.map((c) => c.name));
      expect(viaProfile.checks.map((c) => c.ok)).toEqual(legacy.checks.map((c) => c.ok));
    }
  });

  it("the gate actually detects a regression (drops a line + wrong qty)", () => {
    const fx = load(files[0]);
    // Simulate a pipeline regression: drop one line and corrupt a qty.
    const broken = JSON.parse(JSON.stringify(fx.normalized));
    if (Array.isArray(broken.lines) && broken.lines.length) {
      if (broken.lines[0]) broken.lines[0].quantity = -999;
      broken.lines = broken.lines.slice(0, Math.max(0, broken.lines.length - 1));
    }
    const scored = scoreFixture(fx, broken);
    const baseline = typeof fx.baseline_score === "number" ? fx.baseline_score : 1;
    expect(scored.score).toBeLessThan(baseline - 0.0005);   // would fail CI
  });

  // ── the defects the PO-only gate was structurally blind to ──────────
  //
  // Each of these corrupts ONE field and asserts two things: that the old
  // adapter scored it a clean 1.000, and that the gate now fails.

  it("catches a packing list whose weight basis flipped — the old gate scored it 1.000", () => {
    const fx = load("packing-list-weight-basis.json");
    const broken = JSON.parse(JSON.stringify(fx.normalized));
    broken.lines[0].weight_basis = "per_unit";   // a 2×–50× error on every shipping weight

    // What the gate used to do: read a packing list with the PO adapter.
    expect(scoreCase(fx.expected, normalizedToScorable(broken)).score).toBe(1);

    const scored = scoreFixture(fx, broken);
    expect(scored.score).toBeLessThan(1);
    expect(scored.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["line[0].weightBasis"]);
  });

  it("catches a packing list read in the wrong weight unit", () => {
    const fx = load("packing-list-weight-basis.json");
    const broken = JSON.parse(JSON.stringify(fx.normalized));
    broken.weight_uom = "lb";
    broken.lines.forEach((l) => { l.weight_uom = "lb"; });
    expect(scoreCase(fx.expected, normalizedToScorable(broken)).score).toBe(1);
    const failed = scoreFixture(fx, broken).checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("weightUom");
    expect(failed).toContain("line[0].weightUom");
  });

  it("catches a quote that lost its discounted price to the list price (the #462 defect)", () => {
    const fx = load("quote-two-price-columns.json");
    const broken = JSON.parse(JSON.stringify(fx.normalized));
    broken.lines[0].unitPrice = broken.lines[0].listUnitPrice;
    const scored = scoreFixture(fx, broken);
    expect(scored.score).toBeLessThan(1);
    expect(scored.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["line[0].rate"]);
  });

  it("catches an invoice pointed at the wrong PO — the join key the three-way match runs on", () => {
    const fx = load("invoice-po-reference.json");
    const broken = JSON.parse(JSON.stringify(fx.normalized));
    broken.po_reference = "PO-78";
    const scored = scoreFixture(fx, broken);
    expect(scored.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["poReference"]);
  });
});
