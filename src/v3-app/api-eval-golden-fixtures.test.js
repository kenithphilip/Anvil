// CM P4 gating: the committed golden fixtures must each score at/above their
// baseline through the pure scorer + shape adapter — this is what the CI
// `eval:golden` gate enforces, mirrored here so a local `npm test` catches an
// accuracy regression too.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCase } from "../api/eval/score.js";
import { normalizedToScorable } from "../api/eval/eval-normalize.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "eval", "fixtures");
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
const load = (f) => JSON.parse(readFileSync(join(fixturesDir, f), "utf8"));

describe("golden fixtures", () => {
  it("has committed fixtures to gate on", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const fx = load(file);
    it(`${fx.id || file} scores at/above baseline`, () => {
      const scored = scoreCase(fx.expected, normalizedToScorable(fx.normalized));
      const baseline = typeof fx.baseline_score === "number" ? fx.baseline_score : 1;
      expect(scored.score).toBeGreaterThanOrEqual(baseline - 0.0005);
    });
  }

  it("the gate actually detects a regression (drops a line + wrong qty)", () => {
    const fx = load(files[0]);
    // Simulate a pipeline regression: drop one line and corrupt a qty.
    const broken = JSON.parse(JSON.stringify(fx.normalized));
    if (Array.isArray(broken.lines) && broken.lines.length) {
      if (broken.lines[0]) broken.lines[0].quantity = -999;
      broken.lines = broken.lines.slice(0, Math.max(0, broken.lines.length - 1));
    }
    const scored = scoreCase(fx.expected, normalizedToScorable(broken));
    const baseline = typeof fx.baseline_score === "number" ? fx.baseline_score : 1;
    expect(scored.score).toBeLessThan(baseline - 0.0005);   // would fail CI
  });
});
