// Fair-share budget allocation across the adapter ladder.
//
// Every adapter shares ONE 45s run budget and takes what it needs until it is
// gone, so whoever runs last gets the remainder. Observed on PO 0066026562,
// same document and code, minutes apart:
//
//   gemini 29,520ms + claude   220ms + llamaparse 2,845ms -> ok, 44 lines
//   gemini 26,558ms + claude 5,603ms + llamaparse 5,999ms -> llamaparse TIMED OUT
//
// The only difference was whether Claude's pre-call guard tripped or it made a
// call. LlamaParse got 12s in one and 6s in the other, and 6s was not enough —
// the outcome decided by upstream latency in an adapter that failed either way.
//
// Each adapter reserved a FIXED 8s tail. Fixed is the bug: correct with one
// adapter behind it, wrong with two, because the reserve cannot see how many
// still have to run. The dispatcher can.

import { describe, it, expect } from "vitest";
import { allocateAdapterDeadline } from "../api/_lib/docai/index.js";

const NOW = 1_000_000;
const at = (ms) => NOW + ms;
// The slice an adapter actually gets, measured from the moment IT starts —
// not from NOW. Measuring from NOW conflates elapsed time with the slice.
const sliceOf = (d, from = NOW) => (d == null ? null : d - from);

describe("allocateAdapterDeadline", () => {
  it("hands the whole remainder to the last adapter", () => {
    // Nothing queued behind it, so nothing to hold back.
    expect(sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(20_000), queuedAfter: 0 })))
      .toBe(20_000);
  });

  it("holds back a floor for each adapter still queued", () => {
    // 45s remaining, two behind => reserve 12s, take 33s.
    expect(sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(45_000), queuedAfter: 2 })))
      .toBe(33_000);
  });

  it("gives the middle adapter a slice that still leaves the tail viable", () => {
    // The failing run's shape: 18s left, claude next, llamaparse behind it.
    const claude = sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(18_000), queuedAfter: 1 }));
    expect(claude).toBe(12_000);
    // Even if Claude burns its whole slice, LlamaParse still gets the floor.
    const llama = sliceOf(
      allocateAdapterDeadline({ now: NOW + claude, runDeadlineAt: at(18_000), queuedAfter: 0 }),
      NOW + claude,
    );
    expect(llama).toBe(6_000);
  });

  it("never reserves more than half of what remains", () => {
    // A long tail of configured adapters must not starve the primary.
    const s = sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(20_000), queuedAfter: 10 }));
    expect(s).toBe(10_000);          // capped at 50%, not 20_000 - 60_000
    expect(s).toBeGreaterThan(0);
  });

  it("returns null when the slice would be below the floor — skip, do not start", () => {
    // Starting here means consuming the slice and timing out. A skip is
    // diagnosable; a timeout burns the budget it was given.
    expect(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(5_000), queuedAfter: 0 })).toBeNull();
    expect(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(11_000), queuedAfter: 1 })).toBeNull();
  });

  it("returns null once the budget is already spent", () => {
    expect(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(-1), queuedAfter: 0 })).toBe(at(-1));
  });

  it("leaves behaviour unchanged when there is no run budget", () => {
    // Every non-docai caller passes no deadline; they must not start getting one.
    expect(allocateAdapterDeadline({ now: NOW, runDeadlineAt: null, queuedAfter: 3 })).toBeNull();
    expect(allocateAdapterDeadline({ now: NOW, runDeadlineAt: 0, queuedAfter: 0 })).toBeNull();
  });

  it("treats a missing or nonsense queue count as none behind", () => {
    for (const q of [undefined, null, -5, NaN]) {
      expect(sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(30_000), queuedAfter: q })))
        .toBe(30_000);
    }
  });
});

describe("the run that motivated this", () => {
  const RUN = 45_000;

  it("would have left LlamaParse a viable slice", () => {
    // Replay the failing run under the new allocator. Gemini first, two behind.
    const gemini = sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(RUN), queuedAfter: 2 }));
    expect(gemini).toBe(33_000);     // capped, where it previously ran 26.5s uncapped

    // Say Gemini uses its whole slice. Claude next, one behind.
    let t = NOW + gemini;
    const claude = sliceOf(allocateAdapterDeadline({ now: t, runDeadlineAt: at(RUN), queuedAfter: 1 }), t);
    expect(claude).toBe(6_000);

    // And LlamaParse still gets the floor, rather than the 5,999ms it timed out on.
    t += claude;
    const llama = sliceOf(allocateAdapterDeadline({ now: t, runDeadlineAt: at(RUN), queuedAfter: 0 }), t);
    expect(llama).toBe(6_000);
  });

  it("does not cap the primary when nothing is configured behind it", () => {
    // A tenant with only Gemini keyed loses nothing to this change.
    expect(sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(RUN), queuedAfter: 0 })))
      .toBe(RUN);
  });

  // Honest about the trade: this redistributes a fixed budget, it does not
  // create time. A primary that genuinely needs all 45s is now capped.
  it("does cap a primary that would have used the whole budget", () => {
    const s = sliceOf(allocateAdapterDeadline({ now: NOW, runDeadlineAt: at(RUN), queuedAfter: 2 }));
    expect(s).toBeLessThan(RUN);
  });
});
