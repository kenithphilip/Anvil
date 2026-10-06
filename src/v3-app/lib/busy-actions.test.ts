// The SO workspace could say THAT something was running, never WHICH.
//
// One `busy` boolean drove eleven handlers, so the loading banner read
// "Extracting" whether you pressed Approve, Validate or Push to Tally, and the
// extract button read "extracting…" while an approval was in flight. Six labels
// lying at once, all from the same missing distinction.

import { describe, it, expect } from "vitest";
import { BUSY_ACTIONS, busyLabel, busyVerb } from "./busy-actions";

describe("busyLabel", () => {
  it("names the action that is actually running", () => {
    expect(busyLabel("approve")).toBe("Approving");
    expect(busyLabel("push")).toBe("Pushing to Tally");
    expect(busyLabel("validate")).toBe("Validating");
  });

  // The reported bug.
  it("does not say Extracting for a non-extraction action", () => {
    for (const a of Object.keys(BUSY_ACTIONS) as Array<keyof typeof BUSY_ACTIONS>) {
      if (a !== "extract") expect(busyLabel(a)).not.toBe("Extracting");
    }
  });

  it("still says Extracting for extraction", () => {
    expect(busyLabel("extract")).toBe("Extracting");
  });

  it("falls back to Working rather than rendering an id or blank", () => {
    expect(busyLabel(null)).toBe("Working");
    expect(busyLabel("not_an_action" as any)).toBe("Working");
  });
});

describe("busyVerb", () => {
  it("changes only the button whose own action is running", () => {
    // Approving must not make the extract button claim to be extracting.
    expect(busyVerb("approve", "extract", "run extraction")).toBe("run extraction");
    expect(busyVerb("approve", "approve", "Approve")).toBe("approving…");
  });

  it("leaves every idle button at its resting caption", () => {
    expect(busyVerb(null, "extract", "run extraction")).toBe("run extraction");
    expect(busyVerb(null, "push", "push to Tally")).toBe("push to Tally");
  });

  it("preserves a caption computed by the caller", () => {
    // The extract button's idle text carries the selected engine.
    expect(busyVerb(null, "extract", "run with gemini")).toBe("run with gemini");
    expect(busyVerb("extract", "extract", "run with gemini")).toBe("extracting…");
  });

  it("is unaffected by an unmapped running action", () => {
    expect(busyVerb("nope" as any, "extract", "run extraction")).toBe("run extraction");
  });
});

describe("the label table itself", () => {
  const entries = Object.entries(BUSY_ACTIONS);

  it("covers every action the workspace can start", () => {
    // Every setBusy call site in so-workspace.tsx.
    expect(Object.keys(BUSY_ACTIONS).sort()).toEqual([
      "approve", "bulk_add", "cancel", "clear_lines", "correct", "delete_line",
      "extract", "push", "reconcile", "resolve_finding", "review", "validate",
    ]);
  });

  it("gives every action a distinct banner label", () => {
    // Two actions sharing a label reintroduces the ambiguity, quietly.
    const labels = entries.map(([, v]) => v.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives every action a distinct button verb", () => {
    const verbs = entries.map(([, v]) => v.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
  });

  it("formats button verbs as lowercase with an ellipsis", () => {
    for (const [, v] of entries) {
      expect(v.verb).toMatch(/…$/);
      expect(v.verb[0]).toBe(v.verb[0].toLowerCase());
    }
  });

  it("formats banner labels as title case with no ellipsis", () => {
    // LoadingState renders its own animation and elapsed timer beside this, so
    // a trailing ellipsis reads as a second, stalled one.
    for (const [, v] of entries) {
      expect(v.label).not.toMatch(/[.…]$/);
      expect(v.label[0]).toBe(v.label[0].toUpperCase());
    }
  });
});
