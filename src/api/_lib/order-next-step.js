// The order's NEXT STEP: one button, chosen by a small pure workflow function
// (plan PR 12, docs/AGENT_READY_SO_FLOW.md section 6).
//
// The SO workspace used to hard-code its forward action ("send for review").
// The product is heading to a single-user flow, one engineer guided by an
// agent, with a second person only when the tenant's policy requires one.
// So the forward step is computed from:
//   status        the order's status
//   mode          "A" (Anvil pushes to Tally) or "B" (the team keys the SO
//                 into Tally by hand)
//   exceptions    the exceptions list (order-exceptions.js), with each row's
//                 blocks and agent_policy
//   config        the tenant workflow config (DEFAULT_WORKFLOW_CONFIG)
//   permissions   { write, approve, push } for the person looking. Missing
//                 means no: the button is never enabled on a guess.
//
// It returns { action, label, enabled, blockers[], notes[], transitions[] }:
//   action       a machine name (ACTIONS below)
//   label        the button's words
//   enabled      whether the button may be pressed now
//   blockers     why it may not: each names an exception (key, type, title)
//                or a missing permission
//   notes        what will stop a LATER step, named but not blocking now
//                (an unresolved blocking finding stops approval, and only an
//                approver can clear it, so it must not stop the engineer
//                from sending the order to that approver)
//   transitions  the EXISTING calls the action makes, in order
//
// The DEFAULT config is today's flow: an engineer sends a DRAFT for
// approval; an approver approves; Mode A pushes to Tally; Mode B keys it
// into Tally by hand. Nothing changes for anyone until a tenant sets
// another config.
//
// review: "solo" skips the second person by policy, and only when no
// human_only exception is open. Its label is "Confirm and generate SO" and
// it calls the existing transitions (send for review, approve with the
// payload hash, the SO PDF). The server still checks every one of them, the
// approve permission included. It is OFF: no tenant setting is read yet, and
// there is no screen to set it.
//
// PURE. No I/O.

export const WORKFLOW_REVIEW_MODES = Object.freeze(["approval", "solo"]);

export const DEFAULT_WORKFLOW_CONFIG = Object.freeze({
  version: 1,
  // approval  a second person approves (today)
  // solo      the engineer confirms; approval is skipped by policy only
  //           when no human_only exception is open
  review: "approval",
});

export const ACTIONS = Object.freeze([
  "submit_for_approval", "await_approval", "approve", "confirm_and_generate",
  "push_to_tally", "enter_in_tally", "none",
]);

// The defaults with a tenant's override. An unknown value is the default:
// a typo can never switch a tenant to solo.
export const resolveWorkflowConfig = (override = null) => {
  const o = override && typeof override === "object" ? override : {};
  return Object.freeze({
    version: DEFAULT_WORKFLOW_CONFIG.version,
    review: WORKFLOW_REVIEW_MODES.includes(o.review) ? o.review : DEFAULT_WORKFLOW_CONFIG.review,
  });
};

const ORDER = "/api/orders/{order_id}";
const T = Object.freeze({
  submit: { method: "PATCH", path: ORDER, body: { status: "PENDING_REVIEW" } },
  approve: { method: "PATCH", path: ORDER, body: { status: "APPROVED", approval: { payloadHash: "{payload_hash}" } } },
  soPdf: { method: "GET", path: "/api/orders/so_pdf?orderId={order_id}", body: null },
  push: { method: "POST", path: "/api/tally/push", body: { orderId: "{order_id}" } },
});

// Today an order is sent for approval from DRAFT only.
const SUBMITTABLE = new Set(["DRAFT"]);

const rowsOf = (exceptions) => (Array.isArray(exceptions) ? exceptions : (Array.isArray(exceptions?.rows) ? exceptions.rows : []));

const named = (r, reason) => ({ key: r.key, type: r.type, title: r.title, reason });

const permissionBlocker = (what) => ({ key: "permission:" + what, type: "permission", title: "Needs the " + what + " permission", reason: "permission" });

// The open rows that stop each step. Shadow rows never stop anything: they
// are shown to an admin to measure the terms check, not to act on.
const live = (rows) => rows.filter((r) => r && r.status !== "decided" && !r.shadow);

export const nextStep = ({ status = null, mode = "A", exceptions = null, config = null, permissions = null } = {}) => {
  const cfg = resolveWorkflowConfig(config);
  const can = { write: permissions?.write === true, approve: permissions?.approve === true, push: permissions?.push === true };
  const rows = live(rowsOf(exceptions));
  const sendBlockers = rows.filter((r) => r.blocks === "send").map((r) => named(r, "blocks_send"));
  const approvalBlockers = rows.filter((r) => r.blocks === "approval").map((r) => named(r, "blocks_approval"));
  const modeB = mode === "B";
  const out = (action, label, enabled, blockers = [], notes = [], transitions = []) =>
    ({ action, label, enabled: !!enabled, blockers, notes, transitions, review: cfg.review, mode: modeB ? "B" : "A" });

  if (cfg.review === "solo" && (SUBMITTABLE.has(status) || status === "PENDING_REVIEW")) {
    // Approval is skipped only when nothing open needs a person.
    const humanOnly = rows.filter((r) => r.agent_policy === "human_only").map((r) => named(r, "human_only"));
    const blockers = [...humanOnly];
    if (!can.write) blockers.push(permissionBlocker("write"));
    if (!can.approve) blockers.push(permissionBlocker("approve"));
    const transitions = [...(status === "PENDING_REVIEW" ? [] : [T.submit]), T.approve, T.soPdf];
    return out("confirm_and_generate", "Confirm and generate SO", blockers.length === 0, blockers, [], transitions);
  }

  if (SUBMITTABLE.has(status)) {
    const blockers = [...sendBlockers];
    if (!can.write) blockers.push(permissionBlocker("write"));
    return out("submit_for_approval", "Send for approval", blockers.length === 0, blockers, approvalBlockers, [T.submit]);
  }
  if (status === "PENDING_REVIEW") {
    if (!can.approve) return out("await_approval", "Waiting for approval", false, [], approvalBlockers, []);
    return out("approve", "Approve", approvalBlockers.length === 0, approvalBlockers, [], [T.approve]);
  }
  if (status === "APPROVED" || status === "FAILED_TALLY_IMPORT") {
    // Mode B: the push is refused (409); the team keys the SO in by hand.
    if (modeB) return out("enter_in_tally", "Mode B: enter the SO in Tally by hand", false, [], [], []);
    return out("push_to_tally", "Push to Tally", can.push, can.push ? [] : [permissionBlocker("push")], [], [T.push]);
  }
  return out("none", status ? "No next step (" + String(status).toLowerCase().replace(/_/g, " ") + ")" : "No next step", false, [], [], []);
};

// "Blocked by: <title>; <title>" for a person; the rows' keys are on the
// result for an agent.
export const blockerSentence = (step) => {
  const list = (step?.blockers || []).map((b) => b.title);
  if (!list.length) return "";
  return "Blocked by: " + list.slice(0, 3).join("; ") + (list.length > 3 ? "; and " + (list.length - 3) + " more" : "");
};
