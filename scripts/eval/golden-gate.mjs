#!/usr/bin/env node
/*
 * CM P4 gating: the golden-set REGRESSION GATE (runs in CI via `npm run
 * eval:golden`, after `npm test`).
 *
 * Loads the committed golden fixtures (scripts/eval/fixtures/*.json) — each a
 * { expected, normalized, baseline_score } triple representing a real PO format
 * — renames the frozen pipeline `normalized` into the scorer vocabulary and
 * scores it against the human-verified `expected`. Exits non-zero if ANY
 * fixture scores below its committed baseline, so a change that breaks the
 * scorer, the shape adapter, or the extraction line/customer contract fails the
 * build instead of silently degrading extraction accuracy.
 *
 * Deterministic + offline (no DB, no LLM): it re-scores frozen output, so it
 * guards the scoring + normalization surface. Live model/pipeline regressions
 * are covered separately by the cron re-score over the real corpus.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCase } from "../../src/api/eval/score.js";
import { normalizedToScorable } from "../../src/api/eval/eval-normalize.js";

const TOLERANCE = 0.0005; // float slack; a real regression drops score far more.
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
if (!files.length) {
  console.error("eval:golden — no fixtures found in " + fixturesDir + " (nothing to gate).");
  process.exit(1);
}

let regressions = 0;
let scoreSum = 0;
const width = Math.max(...files.map((f) => f.replace(/\.json$/, "").length), 8);

console.log("eval:golden — scoring " + files.length + " golden fixture(s)\n");
for (const file of files) {
  const fx = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  const actual = normalizedToScorable(fx.normalized);
  const scored = scoreCase(fx.expected, actual);
  const baseline = typeof fx.baseline_score === "number" ? fx.baseline_score : 1;
  const regressed = scored.score < baseline - TOLERANCE;
  scoreSum += scored.score;
  if (regressed) regressions++;
  const id = (fx.id || file.replace(/\.json$/, "")).padEnd(width);
  console.log(
    "  " + id + "  score=" + scored.score.toFixed(3) +
    "  baseline=" + baseline.toFixed(3) +
    "  (" + scored.pass + "/" + scored.total + ")  " +
    (regressed ? "REGRESSED" : "ok"),
  );
  if (regressed) {
    for (const c of scored.checks.filter((c) => !c.ok)) console.log("      ✗ " + c.name);
  }
}

const avg = scoreSum / files.length;
console.log("\n  aggregate avg score = " + avg.toFixed(3));

if (regressions) {
  console.error("\neval:golden FAILED — " + regressions + " fixture(s) regressed below baseline.");
  process.exit(1);
}
console.log("\neval:golden PASSED — no accuracy regressions.");
