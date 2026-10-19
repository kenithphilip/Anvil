// The NEXT STEP workflow function (plan PR 12): _lib/order-next-step.js. The
// default config is today's flow, label and transition alike; "solo" skips
// the second person only when no human_only exception is open. Invented
// fixtures; rows come from the real exceptions builder where it matters.

import { describe, it, expect } from "vitest";
import {
  nextStep, DEFAULT_WORKFLOW_CONFIG, resolveWorkflowConfig, WORKFLOW_REVIEW_MODES, ACTIONS, blockerSentence,
} from "../api/_lib/order-next-step.js";
import { buildOrderExceptions } from "../api/_lib/order-exceptions.js";

const ALL = { write: true, approve: true, push: true };
const ENGINEER = { write: true, approve: false, push: false };

const row = (over) => ({
  key: "line_qty_mismatch|line:i0:A", type: "line_qty_mismatch", title: "L1 A: quantity differs from the quote",
  severity: "warn", blocks: null, shadow: false, status: "open", agent_policy: "propose", ...over,
});
const criticalTerms = row({ key: "terms_flag|clause:LD_PENALTY", type: "terms_flag", title: "Liquidated damages: only the PO states it", severity: "critical", blocks: "send", agent_policy: "human_only" });
const modBlocker = row({ key: "mod_bom_pending|finding:MOD_QUOTE_BOM_PENDING", type: "mod_bom_pending", title: "Gun modification: final BOM outstanding", severity: "critical", blocks: "approval", agent_policy: "human_only" });

describe("the default config is today's flow", () => {
  it("is approval, version 1", () => {
    expect(DEFAULT_WORKFLOW_CONFIG).toEqual({ version: 1, review: "approval" });
    expect(WORKFLOW_REVIEW_MODES).toEqual(["approval", "solo"]);
    expect(resolveWorkflowConfig(null)).toEqual(DEFAULT_WORKFLOW_CONFIG);
  });

  // status, mode, permissions -> action, label, enabled, the existing calls
  const TABLE = [
    ["DRAFT", "A", ENGINEER, "submit_for_approval", "Send for approval", true, [{ method: "PATCH", path: "/api/orders/{order_id}", body: { status: "PENDING_REVIEW" } }]],
    ["DRAFT", "B", ENGINEER, "submit_for_approval", "Send for approval", true, [{ method: "PATCH", path: "/api/orders/{order_id}", body: { status: "PENDING_REVIEW" } }]],
    ["PENDING_REVIEW", "A", ENGINEER, "await_approval", "Waiting for approval", false, []],
    ["PENDING_REVIEW", "A", ALL, "approve", "Approve", true, [{ method: "PATCH", path: "/api/orders/{order_id}", body: { status: "APPROVED", approval: { payloadHash: "{payload_hash}" } } }]],
    ["APPROVED", "A", ALL, "push_to_tally", "Push to Tally", true, [{ method: "POST", path: "/api/tally/push", body: { orderId: "{order_id}" } }]],
    ["APPROVED", "B", ALL, "enter_in_tally", "Mode B: enter the SO in Tally by hand", false, []],
    ["FAILED_TALLY_IMPORT", "A", ALL, "push_to_tally", "Push to Tally", true, [{ method: "POST", path: "/api/tally/push", body: { orderId: "{order_id}" } }]],
    ["BLOCKED", "A", ALL, "none", "No next step (blocked)", false, []],
    ["RECONCILED", "A", ALL, "none", "No next step (reconciled)", false, []],
    ["CANCELLED", "B", ALL, "none", "No next step (cancelled)", false, []],
  ];
  for (const [status, mode, permissions, action, label, enabled, transitions] of TABLE) {
    it(status + " in Mode " + mode + ": " + label, () => {
      const s = nextStep({ status, mode, exceptions: [], permissions });
      expect(s).toMatchObject({ action, label, enabled, transitions, review: "approval", mode });
      expect(ACTIONS).toContain(s.action);
    });
  }

  it("never enables on a guess: no permissions given means disabled", () => {
    const s = nextStep({ status: "DRAFT", exceptions: [] });
    expect(s.enabled).toBe(false);
    expect(s.blockers).toEqual([{ key: "permission:write", type: "permission", title: "Needs the write permission", reason: "permission" }]);
    expect(nextStep({ status: "APPROVED", mode: "A", permissions: ENGINEER }).enabled).toBe(false);
  });
});

describe("blockers are named from the exceptions", () => {
  it("an undecided critical terms flag blocks sending, and is named", () => {
    const s = nextStep({ status: "DRAFT", exceptions: { rows: [row({}), criticalTerms] }, permissions: ENGINEER });
    expect(s.enabled).toBe(false);
    expect(s.blockers).toEqual([{ key: criticalTerms.key, type: "terms_flag", title: "Liquidated damages: only the PO states it", reason: "blocks_send" }]);
    expect(blockerSentence(s)).toBe("Blocked by: Liquidated damages: only the PO states it");
  });

  it("an approver-only blocker does not stop the engineer sending; it is named as a note", () => {
    const s = nextStep({ status: "DRAFT", exceptions: [modBlocker], permissions: ENGINEER });
    expect(s).toMatchObject({ action: "submit_for_approval", enabled: true, blockers: [] });
    expect(s.notes.map((n) => n.title)).toEqual(["Gun modification: final BOM outstanding"]);
  });

  it("the same blocker stops the approver's approve, and is named", () => {
    const s = nextStep({ status: "PENDING_REVIEW", exceptions: [modBlocker], permissions: ALL });
    expect(s).toMatchObject({ action: "approve", enabled: false });
    expect(s.blockers.map((b) => b.key)).toEqual([modBlocker.key]);
  });

  it("a send blocker still open at review stops approve too, as the server does (plan C-3)", () => {
    const s = nextStep({ status: "PENDING_REVIEW", exceptions: [criticalTerms, modBlocker], permissions: ALL });
    expect(s).toMatchObject({ action: "approve", enabled: false });
    expect(s.blockers.map((b) => [b.key, b.reason])).toEqual([[criticalTerms.key, "blocks_send"], [modBlocker.key, "blocks_approval"]]);
    // Someone without approve sees both as notes on the step they wait for.
    const waiting = nextStep({ status: "PENDING_REVIEW", exceptions: [criticalTerms], permissions: ENGINEER });
    expect(waiting).toMatchObject({ action: "await_approval", enabled: false, blockers: [] });
    expect(waiting.notes.map((n) => n.key)).toEqual([criticalTerms.key]);
  });

  it("shadow rows and decided rows never block", () => {
    const s = nextStep({ status: "DRAFT", exceptions: [{ ...criticalTerms, shadow: true }, { ...criticalTerms, status: "decided" }], permissions: ENGINEER });
    expect(s.enabled).toBe(true);
  });

  it("names the first three and counts the rest", () => {
    const many = [1, 2, 3, 4, 5].map((i) => ({ ...criticalTerms, key: "k" + i, title: "T" + i }));
    expect(blockerSentence(nextStep({ status: "DRAFT", exceptions: many, permissions: ENGINEER }))).toBe("Blocked by: T1; T2; T3; and 2 more");
    expect(blockerSentence(nextStep({ status: "DRAFT", exceptions: [], permissions: ENGINEER }))).toBe("");
  });
});

describe("solo (off by default)", () => {
  const SOLO = { review: "solo" };

  it("with no human_only exception: Confirm and generate SO, through the existing calls", () => {
    const s = nextStep({ status: "DRAFT", exceptions: [row({ agent_policy: "propose" }), row({ key: "x", agent_policy: "apply" })], config: SOLO, permissions: ALL });
    expect(s).toMatchObject({ action: "confirm_and_generate", label: "Confirm and generate SO", enabled: true, review: "solo", blockers: [] });
    expect(s.transitions).toEqual([
      { method: "PATCH", path: "/api/orders/{order_id}", body: { status: "PENDING_REVIEW" } },
      { method: "PATCH", path: "/api/orders/{order_id}", body: { status: "APPROVED", approval: { payloadHash: "{payload_hash}" } } },
      { method: "GET", path: "/api/orders/so_pdf?orderId={order_id}", body: null },
    ]);
    // From PENDING_REVIEW it skips the send.
    expect(nextStep({ status: "PENDING_REVIEW", exceptions: [], config: SOLO, permissions: ALL }).transitions.map((t) => t.body?.status || t.method))
      .toEqual(["APPROVED", "GET"]);
  });

  it("with a human_only exception: blocked, and the exception is named", () => {
    const priced = buildOrderExceptions({
      order: {
        id: "o-solo", status: "DRAFT", customer_id: "c", preflight_payload: { last_validated_at: "2026-10-01" },
        result: {
          salesOrder: { lineItems: [{ partNumber: "SP-1", qty: 10, rate: 150, _match: { verdict: "price_mismatch", part_no: "SP-1" } }] },
          quoteReconciliation: { flags: [{ part_no: "SP-1", verdict: "price_mismatch", po_rate: 150, quote_rate: 100, price_delta_pct: 50, po_qty: 10 }] },
        },
      },
    });
    const s = nextStep({ status: "DRAFT", exceptions: priced, config: SOLO, permissions: ALL });
    expect(s).toMatchObject({ action: "confirm_and_generate", label: "Confirm and generate SO", enabled: false });
    expect(s.blockers).toEqual([{ key: "line_price_mismatch|line:i0:SP-1", type: "line_price_mismatch", title: "L1 SP-1: price differs from the quote", reason: "human_only" }]);
  });

  it("still needs the approve permission, since it uses the approval transition", () => {
    const s = nextStep({ status: "DRAFT", exceptions: [], config: SOLO, permissions: ENGINEER });
    expect(s.enabled).toBe(false);
    expect(s.blockers.map((b) => b.key)).toEqual(["permission:approve"]);
  });

  it("an unknown config value is the default, never solo", () => {
    expect(resolveWorkflowConfig({ review: "SOLO" }).review).toBe("approval");
    expect(resolveWorkflowConfig({ review: "auto" }).review).toBe("approval");
    expect(nextStep({ status: "DRAFT", exceptions: [], config: { review: "yes" }, permissions: ALL }).label).toBe("Send for approval");
    expect(resolveWorkflowConfig({ review: "solo" }).review).toBe("solo");
  });

  it("does not apply after approval: the Tally step is the same as today", () => {
    expect(nextStep({ status: "APPROVED", mode: "B", config: SOLO, permissions: ALL })).toMatchObject({ action: "enter_in_tally", enabled: false });
  });
});
