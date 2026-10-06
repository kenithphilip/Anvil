// planDensityChunking: the shared "row-windowable, and does it belong in the
// background" decision used by the sync path, the background-eligibility check
// and the job worker, so all three agree.

import { describe, it, expect } from "vitest";
import { planDensityChunking, __consts__ } from "../api/_lib/docai/density-plan.js";

const ON = { docai_density_chunk_enabled: true };

const denseText = (n) => {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`  ${i}   ADAPTER   TNA-16-04-${i}   85159000   5 Nos 660 3300`);
  return ["PRICE QUOTATION", "TO: Fiat India Automobiles Limited", "",
    " Item  Part Name  PARTS NO.  HSN CODE  Qty Unit  Unit Price  Amount", "",
    ...rows, "", "Terms: ex-works"].join("\n");
};

describe("planDensityChunking", () => {
  it("refuses when the flag is off, the kind is wrong, or there is no text", () => {
    expect(planDensityChunking({ kind: "quote", bodyText: denseText(80), settings: {} }).reason).toBe("flag_off");
    expect(planDensityChunking({ kind: "invoice", bodyText: denseText(80), settings: ON }).reason).toBe("kind_not_eligible");
    expect(planDensityChunking({ kind: "quote", bodyText: null, settings: ON }).reason).toBe("no_body_text");
  });

  it("refuses a sparse table", () => {
    const out = planDensityChunking({ kind: "quote", bodyText: denseText(5), settings: ON });
    expect(out.eligible).toBe(false);
    expect(out.reason).toBe("not_dense_enough");
  });

  it("plans windows for a dense table and keeps a modest one SYNC", () => {
    // 60 items / 25 per window = 3 windows, within the sync budget.
    const out = planDensityChunking({ kind: "quote", bodyText: denseText(60), settings: ON });
    expect(out.eligible).toBe(true);
    expect(out.itemCount).toBe(60);
    expect(out.windowCount).toBe(3);
    expect(out.needsBackground).toBe(false);
    expect(out.plan.windows.length).toBe(3);
  });

  it("sends a document just OVER the sync budget to the background (no dead zone)", () => {
    // 80 items = 4 windows > 3. Before the budget was lowered this stayed sync,
    // could not finish in the run deadline, was not adopted because incomplete,
    // and -- never flagged large -- was never enqueued either: the exact
    // failure this feature exists to remove.
    const out = planDensityChunking({ kind: "quote", bodyText: denseText(80), settings: ON });
    expect(out.windowCount).toBe(4);
    expect(out.needsBackground).toBe(true);
  });

  it("routes a table with more windows than the sync budget to the BACKGROUND", () => {
    // 300 items / 25 = 12 windows > 6 -> background. This is the case the page
    // threshold (40 pages) is blind to: dense but page-few.
    const out = planDensityChunking({ kind: "quote", bodyText: denseText(300), settings: ON });
    expect(out.eligible).toBe(true);
    expect(out.windowCount).toBe(12);
    expect(out.needsBackground).toBe(true);
  });

  it("is deterministic — the worker re-derives the SAME windows every tick", () => {
    // Load-bearing: the worker persists no window text, it re-plans per tick.
    const text = denseText(120);
    const a = planDensityChunking({ kind: "po", bodyText: text, settings: ON });
    const b = planDensityChunking({ kind: "po", bodyText: text, settings: ON });
    expect(b.windowCount).toBe(a.windowCount);
    expect(b.plan.windows.map((w) => w.text)).toEqual(a.plan.windows.map((w) => w.text));
  });

  it("exposes the sync window budget", () => {
    expect(__consts__.SYNC_WINDOW_BUDGET).toBeGreaterThan(0);
  });
});
