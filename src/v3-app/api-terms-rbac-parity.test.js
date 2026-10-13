// The two terms-decision actions are registered in BOTH tables with the same
// roles: the server's SERVER_ACTIONS (auth.js) and the client's ACTIONS
// (rbac.ts). hasAction allows any action it does not know, so a missing or
// misspelt entry would let every role decide (docs/SO_TERMS_AND_HANDOFF_SCOPE.md
// 6.2, Appendix A5). And owner decision 2, role by role, as the rules apply it.

import { describe, it, expect } from "vitest";
import { SERVER_ACTIONS, hasAction } from "../api/_lib/auth.js";
import { ACTIONS } from "./lib/rbac";
import { mayDecide, DECISIONS, nextDecidedAt, historyByFlag } from "../api/_lib/terms/decisions.js";

describe("the newest decision is the current one", () => {
  it("a decision in the same millisecond as the last one still sorts after it", () => {
    const now = new Date("2026-10-12T09:00:00.000Z");
    const prior = [{ id: "d1", flag_id: "f", decided_at: "2026-10-12T09:00:00.000Z" }];
    const at = nextDecidedAt(prior, now);
    expect(at).toBe("2026-10-12T09:00:00.001Z");
    expect(historyByFlag([...prior, { id: "d2", flag_id: "f", decided_at: at }]).get("f").map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(nextDecidedAt([], now)).toBe(now.toISOString());
  });
});

const ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer", "design_engineer", "design_manager", "customer_support"];

describe("order.terms_decide and order.terms_accept_high: server and client parity", () => {
  for (const [action, roles] of [
    ["order.terms_decide", ["sales_engineer", "sales_manager", "admin"]],
    ["order.terms_accept_high", ["sales_manager", "admin"]],
  ]) {
    it(action + " is registered in both tables with the same roles", () => {
      expect(SERVER_ACTIONS[action]).toBeInstanceOf(Set);
      expect([...SERVER_ACTIONS[action]].sort()).toEqual([...roles].sort());
      expect([...ACTIONS[action]].sort()).toEqual([...roles].sort());
    });

    it(action + " admits exactly those roles on the server", () => {
      const admitted = ROLES.filter((role) => hasAction({ role }, action));
      expect(admitted.sort()).toEqual([...roles].sort());
      expect(hasAction({ role: "sales_manager", anonymous: true }, action)).toBe(false);
    });
  }
});

describe("decision 2, role by role", () => {
  // [role, severity] -> the decisions that role may make.
  const ALL = [...DECISIONS];
  const DECIDE_ONLY = ["request_amendment", "reject_term"];
  const cases = [
    ["sales_engineer", "info", ALL],
    ["sales_engineer", "warn", ALL],
    ["sales_engineer", "high", DECIDE_ONLY],
    ["sales_engineer", "critical", DECIDE_ONLY],
    ["sales_manager", "critical", ALL],
    ["admin", "critical", ALL],
    ["finance", "warn", []],
    ["viewer", "info", []],
  ];
  for (const [role, severity, expected] of cases) {
    it(role + " on a " + severity + " flag", () => {
      expect(DECISIONS.filter((d) => mayDecide({ role }, d, severity))).toEqual(expected);
    });
  }
});
