// Regression test for the systemic-issue audit gates.
//
// The audit runner is the long-term defense against the bug families
// that produced the recent reports (PRs #17, #19, #20, #21). This test
// asserts the gates stay green: any new code that introduces a
// PromiseLike .catch chain or a dead route must surface here before
// merge.
//
// Soft warnings (column drift) are not gated on — too noisy.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");

describe("systemic audits stay green", () => {
  it("no Supabase PromiseLike .catch chains exist", () => {
    const out = spawnSync(
      "node",
      [join(REPO_ROOT, "scripts/audit/promiselike-catch.mjs")],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    if (out.status !== 0) {
      throw new Error(
        "promiselike-catch audit found new offenders. Stdout:\n" +
        (out.stdout || "") + "\n" + (out.stderr || ""),
      );
    }
    expect(out.status).toBe(0);
  });

  it("audit runner exits 0 when only soft warnings remain", () => {
    const out = spawnSync(
      "node",
      [join(REPO_ROOT, "scripts/audit/run-all.mjs")],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    expect(out.status).toBe(0);
    expect(out.stdout || "").toMatch(/Hard gate failures:\s+0/);
  });
});
