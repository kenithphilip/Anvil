// The order's execution stage (plan R-M1, C-9): _lib/order-stage.js derives
// one stage from the order row and the evidence the endpoint read, and
// _lib/order-next-step.js turns it into the next-step bar. Every stage from
// fixtures, in Mode A and Mode B. Invented ids; no real names.

import { describe, it, expect } from "vitest";
import { orderStage, STAGES, STAGE_LABELS, STAGE_COLUMNS } from "../api/_lib/order-stage.js";
import { nextStep, ACTIONS } from "../api/_lib/order-next-step.js";

const T0 = "2026-10-01T05:00:00.000Z";
const T_UPD = "2026-10-09T05:00:00.000Z";
const T_APPR = "2026-10-03T05:00:00.000Z";
const T_SENT = "2026-10-04T05:00:00.000Z";
const T_RET = "2026-10-02T05:00:00.000Z";
const HASH = "hash-v1";

const order = (over = {}) => ({
  id: "o-1", status: "DRAFT", created_at: T0, updated_at: T_UPD, approval: null, approved_at: null,
  payload_hash: HASH, correction_reason: null, correction_requested_at: null, tally_status: "idle",
  handoff_status: null, handoff_sent_at: null, handoff_payload: null, ...over,
});
const approved = (over = {}) => order({ status: "APPROVED", approval: { payloadHash: HASH }, approved_at: T_APPR, ...over });
const sent = (over = {}) => approved({ handoff_status: "sent", handoff_sent_at: T_SENT, handoff_payload: { payload_hash: HASH }, ...over });
const PDF = [{ document_id: "doc-so-1" }];
const B = { mode: "B" };

describe("the stage keys", () => {
  it("every stage has a label, and the stage columns cover what the stage reads", () => {
    for (const s of STAGES) expect(STAGE_LABELS[s]).toBeTruthy();
    expect(STAGE_LABELS.keyed_unverified).toBe("Keyed, unverified");
    expect(STAGE_LABELS.verified).toBe("Verified in ERP");
    // A row cut down to STAGE_COLUMNS gives the same stage as the whole row.
    const full = { ...sent(), result: { salesOrder: { lineItems: [{}] } }, po_number: "PO-1" };
    const cut = Object.fromEntries(STAGE_COLUMNS.map((c) => [c, full[c]]));
    expect(orderStage(cut, B)).toEqual(orderStage(full, B));
  });
});

describe("Mode A: Anvil pushes, and its push states are the ERP stages", () => {
  const cases = [
    [order(), "verifying", "sales_engineer", "submit_for_approval", T0, "orders.status"],
    [order({ status: "PENDING_REVIEW" }), "in_approval", "sales_manager", "approve", T_UPD, "orders.status"],
    [approved(), "approved", "sales_engineer", "push_to_tally", T_APPR, "orders.approved_at"],
    [approved({ status: "FAILED_TALLY_IMPORT" }), "approved", "sales_engineer", "push_to_tally", T_APPR, "orders.approved_at"],
    [approved({ status: "EXPORTED_TO_TALLY" }), "keyed", "sales_engineer", "verify_in_erp", T_UPD, "orders.status"],
    [approved({ status: "RECONCILED" }), "verified", null, "none", T_UPD, "orders.status"],
  ];
  for (const [o, stage, holder, next, since, ref] of cases) {
    it(o.status + " is " + stage, () => {
      expect(orderStage(o, { mode: "A" })).toEqual({ stage, since, evidence_ref: ref, holder_role: holder, next_action: next });
    });
  }

  it("ignores the Mode B handoff and keyed records", () => {
    expect(orderStage(sent({ tally_status: "imported" }), { mode: "A", erp_so: PDF }).stage).toBe("approved");
  });

  it("defaults to Mode A when no mode is given", () => {
    expect(orderStage(approved()).next_action).toBe("push_to_tally");
  });
});

describe("Mode B: the clerk keys the SO, and Anvil reads the evidence", () => {
  it("approved and not handed off: the engineer hands it off", () => {
    expect(orderStage(approved(), B)).toEqual({ stage: "approved", since: T_APPR, evidence_ref: "orders.approved_at", holder_role: "sales_engineer", next_action: "send_handoff" });
  });

  it("a failed or unconfigured handoff is not a handoff", () => {
    expect(orderStage(approved({ handoff_status: "failed" }), B).next_action).toBe("send_handoff");
    expect(orderStage(approved({ handoff_status: "not_configured" }), B).next_action).toBe("send_handoff");
  });

  it("handoff after approval: the clerk holds it from the send", () => {
    expect(orderStage(sent(), B)).toEqual({ stage: "handed_off", since: T_SENT, evidence_ref: "orders.handoff_status", holder_role: "operator", next_action: "enter_in_tally" });
  });

  it("handoff before approval: still in approval, then handed off once approved", () => {
    const early = order({ status: "PENDING_REVIEW", handoff_status: "sent", handoff_sent_at: T_SENT, handoff_payload: { payload_hash: HASH } });
    expect(orderStage(early, B).stage).toBe("in_approval");
    expect(orderStage({ ...early, status: "APPROVED", approval: { payloadHash: HASH }, approved_at: T_APPR }, B).stage).toBe("handed_off");
  });

  it("keyed needs the approval too: a Tally SO PDF on an order in approval keeps it in approval", () => {
    expect(orderStage(order({ status: "PENDING_REVIEW" }), { ...B, erp_so: PDF }).stage).toBe("in_approval");
    expect(orderStage(order({ tally_status: "imported" }), B).stage).toBe("verifying");
  });

  it("a Tally SO PDF attached: keyed, with the document as the evidence", () => {
    expect(orderStage(sent(), { ...B, erp_so: PDF })).toEqual({ stage: "keyed", since: T_UPD, evidence_ref: "order_documents:doc-so-1", holder_role: "sales_engineer", next_action: "verify_in_erp" });
    // The entry proves the order reached the clerk, whatever rail carried it.
    expect(orderStage(approved(), { ...B, erp_so: PDF }).stage).toBe("keyed");
  });

  it("manual exit with no PDF: keyed, unverified, until a PDF arrives", () => {
    const manual = sent({ tally_status: "imported", so_voucher_no: "SO-9" });
    expect(orderStage(manual, B)).toEqual({ stage: "keyed_unverified", since: T_UPD, evidence_ref: "orders.tally_status", holder_role: "sales_engineer", next_action: "attach_erp_so" });
    expect(orderStage(manual, { ...B, erp_so: PDF }).stage).toBe("keyed");
  });

  it("a clean three-way check: verified in ERP, and nothing is owed", () => {
    expect(orderStage(sent({ tally_status: "reconciled" }), { ...B, erp_so: PDF })).toEqual({ stage: "verified", since: T_UPD, evidence_ref: "orders.tally_status", holder_role: null, next_action: "none" });
  });
});

describe("returned, revised, received and cancelled", () => {
  it("returned for correction: the engineer fixes it, from the time of the return", () => {
    expect(orderStage(order({ correction_reason: "Wrong ship-to", correction_requested_at: T_RET }))).toEqual({ stage: "returned", since: T_RET, evidence_ref: "orders.correction_reason", holder_role: "sales_engineer", next_action: "submit_for_approval" });
    // Sent again: in approval, whatever reason it still carries.
    expect(orderStage(order({ status: "PENDING_REVIEW", correction_reason: "Wrong ship-to" })).stage).toBe("in_approval");
  });

  it("revised after handoff: the edit clears the approval, so it is verified again", () => {
    // The edit (orders/[id].js) clears the approval and keeps the status.
    const edited = sent({ approval: null, payload_hash: "hash-v2" });
    expect(orderStage(edited, { ...B, erp_so: PDF })).toEqual({ stage: "verifying", since: T_UPD, evidence_ref: "orders.approval", holder_role: "sales_engineer", next_action: "resubmit_for_approval" });
    // Approved again: the clerk keyed the old lines, so the handoff goes again.
    const reapproved = { ...edited, approval: { payloadHash: "hash-v2" } };
    expect(orderStage(reapproved, { ...B, erp_so: PDF })).toMatchObject({ stage: "approved", evidence_ref: "orders.handoff_payload", next_action: "resend_handoff" });
    expect(orderStage({ ...reapproved, tally_status: "reconciled" }, B).next_action).toBe("resend_handoff");
  });

  it("a sent handoff that stored no hash cannot show it matches, so it asks for a re-send", () => {
    expect(orderStage(sent({ handoff_payload: null }), B).next_action).toBe("resend_handoff");
  });

  it("revised in Mode A: verified and sent for approval again, not pushed", () => {
    expect(orderStage(approved({ approval: null }), { mode: "A" }).next_action).toBe("resubmit_for_approval");
  });

  it("received: a background extraction is still reading the PO", () => {
    const job = { id: "job-1", created_at: T_RET };
    expect(orderStage(order(), { extraction_job: job })).toEqual({ stage: "received", since: T_RET, evidence_ref: "extraction_jobs:job-1", holder_role: "system", next_action: "wait_for_extraction" });
  });

  it("cancelled ends it at any point, in both modes", () => {
    for (const mode of ["A", "B"]) {
      expect(orderStage(sent({ status: "CANCELLED", tally_status: "imported" }), { mode, erp_so: PDF })).toEqual({ stage: "cancelled", since: T_UPD, evidence_ref: "orders.status", holder_role: null, next_action: "none" });
    }
  });

  it("a known approver role holds the approval; BLOCKED has no forward step", () => {
    expect(orderStage(order({ status: "PENDING_REVIEW" }), { approver_role: "finance" }).holder_role).toBe("finance");
    expect(orderStage(order({ status: "BLOCKED" }))).toMatchObject({ stage: "verifying", next_action: "none" });
  });
});

describe("the next-step bar reads the stage", () => {
  const perms = { write: true, approve: true, push: true };
  const step = (o, ev) => nextStep({ status: o.status, mode: ev?.mode || "A", permissions: perms, stage: orderStage(o, ev) });

  it("has an answer at every stage, and every next action is a next-step action", () => {
    const fixtures = [
      [order(), {}], [order({ correction_reason: "x" }), {}], [order(), { extraction_job: { id: "j", created_at: T0 } }],
      [order({ status: "PENDING_REVIEW" }), {}], [approved(), {}], [approved(), B], [sent(), B],
      [sent({ tally_status: "imported" }), B], [sent(), { ...B, erp_so: PDF }], [sent({ tally_status: "reconciled" }), B],
      [approved({ status: "EXPORTED_TO_TALLY" }), {}], [order({ status: "CANCELLED" }), {}], [approved({ approval: null }), B],
    ];
    const seen = new Set();
    for (const [o, ev] of fixtures) {
      const st = orderStage(o, ev);
      seen.add(st.stage);
      expect(ACTIONS).toContain(st.next_action);
      const s = step(o, ev);
      expect(ACTIONS).toContain(s.action);
      expect(s.label).toBeTruthy();
    }
    expect([...seen].sort()).toEqual([...STAGES].sort());
  });

  it("Mode B after approval names the handoff, the Tally entry and the PDF; none of them runs from here", () => {
    expect(step(approved(), B)).toMatchObject({ action: "send_handoff", enabled: false, transitions: [] });
    expect(step(sent(), B)).toMatchObject({ action: "enter_in_tally", enabled: false });
    expect(step(sent({ tally_status: "imported" }), B)).toMatchObject({ action: "attach_erp_so", label: "Keyed, unverified: attach the Tally SO PDF", enabled: false });
    expect(step(sent(), { ...B, erp_so: PDF })).toMatchObject({ action: "verify_in_erp", enabled: false });
  });

  it("verified and cancelled say so", () => {
    expect(step(sent({ tally_status: "reconciled" }), B)).toMatchObject({ action: "none", label: "No next step (Verified in ERP)" });
    expect(step(order({ status: "CANCELLED" }), {})).toMatchObject({ action: "none", label: "No next step (Cancelled)" });
  });

  it("revised: back to DRAFT, then for approval again, never a push without an approval", () => {
    const s = step(approved({ approval: null }), { mode: "A" });
    expect(s).toMatchObject({ action: "resubmit_for_approval", enabled: true });
    expect(s.transitions.map((t) => t.body.status)).toEqual(["DRAFT", "PENDING_REVIEW"]);
    expect(nextStep({ status: "APPROVED", stage: orderStage(approved({ approval: null })), permissions: { approve: true } }).enabled).toBe(false);
    // A failed import cannot go back to DRAFT, so the step is named and off.
    const failed = approved({ status: "FAILED_TALLY_IMPORT", approval: null });
    expect(step(failed, {})).toMatchObject({ action: "resubmit_for_approval", enabled: false });
  });

  it("before approval, and with no stage, the status still decides", () => {
    expect(step(order(), {})).toMatchObject({ action: "submit_for_approval", enabled: true });
    expect(step(order({ status: "PENDING_REVIEW" }), {})).toMatchObject({ action: "approve", enabled: true });
    expect(step(approved(), {})).toMatchObject({ action: "push_to_tally", enabled: true });
    expect(nextStep({ status: "APPROVED", mode: "B", permissions: perms })).toMatchObject({ action: "enter_in_tally" });
  });
});
