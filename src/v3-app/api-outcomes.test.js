// Tests for the audit-action -> billable-outcome mapping. The map is
// the source of truth for what gets metered, so it's worth pinning the
// shape: every outcome has a label, a unit price, and a stable order.

import { describe, it, expect } from "vitest";
import {
  ACTION_TO_OUTCOME,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  OUTCOME_UNIT_PRICE_CENTS,
  outcomeFor,
} from "../api/_lib/outcomes.js";

describe("outcomes mapping", () => {
  it("every value in ACTION_TO_OUTCOME is in OUTCOME_ORDER", () => {
    const known = new Set(OUTCOME_ORDER);
    for (const outcome of Object.values(ACTION_TO_OUTCOME)) {
      expect(known.has(outcome)).toBe(true);
    }
  });

  it("every outcome has a label", () => {
    for (const id of OUTCOME_ORDER) {
      expect(typeof OUTCOME_LABELS[id]).toBe("string");
      expect(OUTCOME_LABELS[id].length).toBeGreaterThan(0);
    }
  });

  it("every outcome has a non-zero unit price", () => {
    for (const id of OUTCOME_ORDER) {
      const cents = OUTCOME_UNIT_PRICE_CENTS[id];
      expect(typeof cents).toBe("number");
      expect(cents).toBeGreaterThan(0);
    }
  });

  it("outcomeFor returns null for unknown actions", () => {
    expect(outcomeFor("never_ever_used_action")).toBeNull();
    expect(outcomeFor("")).toBeNull();
    expect(outcomeFor(null)).toBeNull();
  });

  it("outcomeFor returns a known outcome for a billable action", () => {
    expect(outcomeFor("create_order")).toBe("order_processed");
    expect(outcomeFor("tally_push")).toBe("order_pushed");
    expect(outcomeFor("comm_send")).toBe("communication_sent");
  });
});
