// An order carrying a line_count_shortfall could not be approved, and could not
// be unblocked from anywhere.
//
// The server has had the escape hatch since the blocker was introduced —
// PATCH { resolve_finding: { code, note } } on src/api/orders/[id].js,
// permissioned on "approve", audited as order_finding_resolved, and described
// in its own comment as "the escape hatch that guarantees no stuck order".
//
// Nothing in the client ever called it. Approve returned 409
// ORDER_HAS_UNRESOLVED_BLOCKER telling the operator to "Resolve it first", and
// no screen offered any way to do that. The order was permanently trapped.
//
// (src/v3-app/components/SOWorkspaceOrderPanels.tsx has a resolveFinding, but it
// calls tally.resolveFinding — Tally drift findings via /api/tally/reconcile.
// Different feature, different table; it was never this escape hatch.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isUnresolvedBlocker, firstUnresolvedBlocker, hasUnresolvedBlocker } from "../api/_lib/blocking-findings.js";

const workspace = readFileSync("src/v3-app/screens/so-workspace.tsx", "utf8");
const server = readFileSync("src/api/orders/[id].js", "utf8");

describe("the workspace can reach the escape hatch", () => {
  it("PATCHes resolve_finding with the finding's code", () => {
    // The regression: this call existed nowhere in the client.
    expect(workspace).toMatch(/resolve_finding:\s*\{\s*code,/);
    expect(workspace).toContain("orders?.update?.(o.id, {");
  });

  it("sends the note the server records in the audit trail", () => {
    expect(workspace).toMatch(/note:\s*resolveNote/);
  });

  it("offers the control only to a user who can approve", () => {
    // The server requires "approve"; a button that always 403s is worse than
    // no button, because it looks like the way out and is not.
    expect(workspace).toContain("!canApprove ?");
    expect(workspace).toMatch(/needs an approver to clear/);
  });

  it("uses the SERVER's blocking predicate rather than a copy", () => {
    // A UI that disagreed with the gate about what blocks would either offer a
    // button that 409s or hide the only way out of a trapped order.
    expect(workspace).toContain('from "../../api/_lib/blocking-findings.js"');
    expect(workspace).toContain("isBlockingFinding(f)");
  });

  it("does not confuse this with the Tally drift resolver", () => {
    // Different feature entirely; conflating them is how the gap survived review.
    expect(workspace).not.toMatch(/tally\?\.resolveFinding/);
  });
});

describe("the server contract the UI now depends on", () => {
  it("still accepts resolve_finding and requires approve", () => {
    expect(server).toContain("body.resolve_finding");
    expect(server).toMatch(/requirePermission\(ctx, "approve"\)/);
  });

  it("still audits the override", () => {
    // Clearing a safety gate must leave a trail naming who and why.
    expect(server).toContain("order_finding_resolved");
  });

  it("still 404s an unknown code rather than silently doing nothing", () => {
    expect(server).toMatch(/No unresolved finding/);
  });

  it("still blocks approval while a blocker is unresolved", () => {
    expect(server).toContain("ORDER_HAS_UNRESOLVED_BLOCKER");
  });
});

describe("isUnresolvedBlocker — what the UI now shows a button for", () => {
  const shortfall = (over = {}) => ({ code: "line_count_shortfall", detail: "declared 12, extracted 9", ...over });

  it("treats an unresolved line_count_shortfall as blocking", () => {
    expect(isUnresolvedBlocker(shortfall())).toBe(true);
  });

  it("stops treating it as blocking once resolved", () => {
    // The button must disappear after the operator clears it.
    expect(isUnresolvedBlocker(shortfall({ resolved: true }))).toBe(false);
  });

  it("treats an explicit blocks:true finding as blocking", () => {
    expect(isUnresolvedBlocker({ code: "whatever", blocks: true })).toBe(true);
  });

  it("does NOT block on an ordinary error-severity advisory", () => {
    // Deliberately narrow — over-trapping would turn every advisory into a
    // approval-blocking dead end.
    expect(isUnresolvedBlocker({ code: "price_variance", severity: "ERROR" })).toBe(false);
  });

  it.each([null, undefined, "nope", 42])("is safe on %p", (v) => {
    expect(isUnresolvedBlocker(v)).toBe(false);
  });

  it("finds the first blocker in a mixed list", () => {
    const list = [{ code: "price_variance" }, shortfall(), { code: "other", blocks: true }];
    expect(firstUnresolvedBlocker(list).code).toBe("line_count_shortfall");
    expect(hasUnresolvedBlocker(list)).toBe(true);
    expect(hasUnresolvedBlocker([{ code: "price_variance" }])).toBe(false);
  });
});
