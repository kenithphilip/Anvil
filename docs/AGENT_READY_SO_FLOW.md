# Agent-ready SO flow: the exceptions work queue

| | |
|---|---|
| Status | Built: the exceptions list and its hooks (plan PR 9), the delivery date read path (plan PR 10), the next-step function (plan PR 12). Not built: the agent runner, and the decisions table (plan PR 11). |
| Code | `src/api/_lib/order-exceptions.js`, `src/api/_lib/order-delivery-date.js` and `src/api/_lib/order-next-step.js` (all pure), `GET /api/orders/exceptions`, and the SO workspace's "Review and decide" view. |
| Migrations | None. |

## 1. Why

The product is heading to a single-user system: one sales engineer, guided by an AI agent, and a second person only when the tenant's policy requires one. The screens are built now so that they need no rework when the agent arrives.

The rule is simple. **The agent and the person read the same queue.** `GET /api/orders/exceptions` returns exactly the object the workspace renders. Nothing is computed only in the browser.

## 2. The response (version 1)

```
{
  version: 1,
  order_id, status,
  rows:     [row, ...],   open, severity warn or above: what needs a decision
  info:     [row, ...],   open, severity info: shown, nothing to decide
  decided:  [row, ...],   decided elsewhere; kept so nothing is lost
  counts:   { open, info, decided, blocking, by_severity, by_agent_policy },
  clean:    true when rows is empty,
  customer_match: { basis, label, po_name, master_name },
  terms_state:    on | shadow | hidden | off | unavailable,
  agent_policy:   the policy in force (section 5),
  delivery:       { shown, po, committed, suggestion } (section 4.1)
}
```

Bump `version` when a field changes meaning.

### 2.1 One row

| Field | Meaning |
|---|---|
| `key` | Stable id: `<type>|<subject>`. The same issue keeps its key across re-reads. A line's subject uses the PO's printed line number when there is one, else the grid index, plus the part number. A terms flag's subject is its clause, not its flag id, because a re-run check gives new flag ids. |
| `type` | A machine type from the enum (section 3). |
| `source`, `sources` | Where it comes from. When two sources report one issue, the row shows once and `sources` lists both. |
| `severity` | `critical`, `high`, `warn` or `info`. |
| `blocks` | `approval` when the server refuses approval until it is cleared. `send` when the order should not go for approval with it open (an undecided critical terms flag). Else `null`. |
| `status` | `open` or `decided`. |
| `title`, `detail` | Words for a person. |
| `payload` | The evidence as data: `subject` (kind, line index, flag id, customer id), `field`, `po_value`, `quote_value`, money (`delta_pct`, `amount`, `qty`), `evidence_refs` (PO page and box, quote number, extraction run, terms flag, finding). |
| `action` | Where in the existing screen it is resolved: a tab, a control, a grid line. |
| `resolution_options` | The fixed options for the type (section 4). |
| `agent_policy` | `propose`, `apply` or `human_only` (section 5). |

### 2.2 Shadow mode

Terms rows come from the terms read path and follow its rule. In shadow mode they are hidden, unless an admin passes `include_shadow=1`. Anyone else who asks gets 403. A shadow row is marked `shadow: true`, never blocks, and is always `human_only`.

## 3. The type enum

Every row's type is in `EXCEPTION_TYPES`. A type ending in `:*` is a family; the code follows the colon.

| Source | Types |
|---|---|
| reconciliation (the quote check) | `line_price_mismatch`, `line_qty_mismatch`, `line_description_mismatch`, `line_unmatched`, `line_reconcile_other`, `payment_terms_mismatch`, `incoterm_mismatch`, `incoterm_place_differs`, `incoterm_unconfirmed`, `quoted_not_ordered` |
| finding (`orders.rule_findings`) | `mod_bom_pending`, `line_count_shortfall`, `lines_changed_after_review`, `blocking_finding`, `finding:<code>` |
| anomaly (the rule library) | `anomaly:<rule>`, `anomaly_check_not_run` |
| extraction (the run and the background job) | `extraction_in_flight`, `extraction_no_lines`, `extraction_failed`, `extraction_low_confidence`, `extraction_fallback_parse`, `extraction_check:<code>` |
| terms (the terms check) | `terms_flag`, `terms_not_read` |
| customer (the match) | `customer_unmatched`, `customer_gstin_conflict`, `customer_low_confidence`, `customer_state_differs` |
| delivery_date (plan PR 10) | `delivery_date_conflict`, one row per rule: `committed_after_po_date`, `line_differs_from_header`, `date_in_past` |

Dedupe, one row per issue:

- a payment-terms or incoterm verdict and a terms flag on the same clause: the terms flag wins;
- the `-MOD` blocker in `rule_findings` and the reconcile's `mod_bom`: the finding wins;
- a line-count shortfall as an extraction anomaly and as a finding: the finding wins;
- an anomaly rule stored in `rule_findings` and in `anomaly_flags`: one row.

A terms flag that was already decided closes the reconcile's copy of the same clause as `decided`. A resolved finding closes its copies the same way.

## 4. Resolution options

The vocabulary: `accept_po_value`, `accept_quote_value`, `request_amendment`, `reject_line`, `reject_term`, `not_a_deviation`, `set_value`, `map_item`, `add_line`, `run_check`, `confirm`, `change_customer`, `update_master`, `use_new_lines`, `cancel_extraction`.

Each option names how it is applied today:

- `kind: "endpoint"`: the existing call (method, path, body) and the control that makes it. Braces are filled from the payload: `{order_id}`, `{line_index}`, `{line_number}`, `{code}`, `{field}`.
- `kind: "not_available_yet"`: what is missing.

| Type | Options (applied by) |
|---|---|
| `line_price_mismatch` | `accept_po_value` (not yet: no decision record), `accept_quote_value` (PATCH the line's rate), `request_amendment` (not yet), `set_value` (PATCH the rate) |
| `line_qty_mismatch` | the same, on `qty` |
| `line_description_mismatch` | `accept_po_value` (not yet), `accept_quote_value`, `set_value` (PATCH the description) |
| `line_unmatched` | `map_item` (PATCH `_mapped_item`), `set_value`, `reject_line` (PATCH without the line), `request_amendment` (not yet) |
| `payment_terms_mismatch` | `accept_po_value`, `request_amendment` (both not yet) |
| `incoterm_*` | `accept_po_value` (not yet), `set_value` (PATCH `incoterm_code`), `request_amendment` (not yet) |
| `quoted_not_ordered` | `add_line` (PATCH with a quote_variance line), `request_amendment`, `confirm` (not yet) |
| `mod_bom_pending`, `line_count_shortfall`, `blocking_finding` | `confirm` (PATCH `resolve_finding`, approve permission), `run_check` (POST `/api/docai/extract`) |
| `lines_changed_after_review` | `use_new_lines` (PATCH the lines from the finding's `pending_lines`), `confirm` (PATCH `resolve_finding`, approve permission). The background writeback raises it when it lands on an order past DRAFT (plan C-2). It holds the new lines and blocks approve and push. |
| `extraction_in_flight` | `cancel_extraction` (PATCH `/api/orders/extraction_jobs/{job_id}`, API only; refused once the job is merging). It blocks `send` while a background job is queued or running. |
| `anomaly:*` | `confirm` (not yet), `set_value`, `run_check` (POST `/api/anomaly/compute`) |
| `anomaly_check_not_run` | `run_check` (POST `/api/anomaly/compute`, then PATCH `rule_findings`) |
| `extraction_*` | `run_check` (POST `/api/docai/extract`), `confirm` (not yet), `set_value` where a line is named |
| `terms_flag` | `accept_po_value`, `request_amendment`, `reject_term`, `not_a_deviation` (POST `/api/orders/terms_decide`) |
| `terms_not_read` | `run_check` (POST `/api/orders/terms_check`) |
| `customer_unmatched`, `customer_low_confidence` | `change_customer` (not yet: `customer_id` is not in the PATCH allowlist, plan PR 7), `confirm` (not yet) |
| `customer_gstin_conflict`, `customer_state_differs` | `update_master` (POST `/api/customers`), `confirm` (not yet) |
| `delivery_date_conflict` | `accept_suggested_date` and `set_value` (PATCH `committed_delivery_date`, the Header fields tab), `request_amendment` (not yet) |

"Not yet" options become real when plan PR 11 stores decisions.

### 4.1 The delivery date (plan PR 10)

`src/api/_lib/order-delivery-date.js` is the one read path.

- **Two dates.** The PO's date (what the customer asks for) and the committed date (ours, `orders.committed_delivery_date`). The response's `delivery` block carries both, and `shown`: the one date the summary shows, with its source (`po_header`, `po_line`, `committed`, `none`).
- **A line's due date** (SO PDF and Excel, one helper): our schedule, then the PO line's date, then the PO header's date, then the committed date.
- **The suggestion** for the committed date is a structure, never applied by itself (owner decision 7 is open):

```
{ value: "2026-11-30", source: "po_header" | "po_line" | "po_description",
  rule: "po_header_date" | "earliest_po_line_date" | "delivery_date_in_description",
  confidence: "high" (a PO header or line date) | "low" (otherwise),
  applies_via: { PATCH /api/orders/{order_id}, body committed_delivery_date } }
```

It rides on each `delivery_date_conflict` row's payload and in `delivery.suggestion`. The option `accept_suggested_date` sets the committed date to it through the existing Header fields save.

## 5. The agent policy

`agentPolicyFor(row, policy)` is pure. The defaults are data (`DEFAULT_AGENT_POLICY`). A tenant setting can override any key later through `resolveAgentPolicy`; no setting is read today, and no migration is added.

| Key | Default | Meaning |
|---|---|---|
| `human_only_severities` | `high`, `critical` | A person decides anything this serious. |
| `money_tolerance` | 2% or 10,000 per line | A deviation above either bound is a person's decision (owner decision 4's suggested default). |
| `manager_terms_severities` | `high`, `critical` | Terms flags that decision 2 reserves for a sales manager or admin. A clause whose tenant policy sets `accept_requires` is reserved too. |
| `apply_types` | `anomaly_check_not_run`, `terms_not_read` | Housekeeping an agent may simply do: re-run a read-only check. |
| `otherwise` | `propose` | Everything else is proposed to the engineer. An override can tighten this to `human_only`; it can never be `apply`. |

The rules, in order:

1. a shadow row, a blocking row, or a severity in `human_only_severities`: `human_only`;
2. a money deviation above `money_tolerance`: `human_only`;
3. a terms flag reserved for a manager: `human_only`;
4. a type in `apply_types`: `apply`;
5. otherwise: `propose`.

A price difference inside the tolerance is `warn`; above it, `high`.

## 6. The next step

The workspace's forward button is no longer hard-coded. `nextStep({ status, mode, exceptions, config, permissions })` in `src/api/_lib/order-next-step.js` (pure) returns:

```
{ action, label, enabled, blockers[], notes[], transitions[], review, mode }
```

- `blockers`: why the button is disabled. Each names an exception (`key`, `type`, `title`) or a missing permission.
- `notes`: what stops a later step, named but not blocking now. An unresolved blocking finding stops approval, and only an approver clears it, so it must not stop the engineer from sending the order to that approver.
- `transitions`: the existing calls the action makes, in order.
- Permissions that are missing count as "no". The button is never enabled on a guess.
- Shadow rows and decided rows never block.

### 6.1 The workflow config

`DEFAULT_WORKFLOW_CONFIG = { version: 1, review: "approval" }`. An unknown value reads as the default, so a typo can never switch a tenant to solo. No tenant setting is read yet, and there is no screen to set one.

### 6.2 The default (today's flow)

| Status | Mode | Action | Label | Enabled when | Existing call |
|---|---|---|---|---|---|
| DRAFT | A or B | `submit_for_approval` | Send for approval | write, and no `blocks: "send"` row | PATCH `/api/orders/{id}` `{ status: PENDING_REVIEW }` |
| PENDING_REVIEW | A or B | `await_approval` | Waiting for approval | never (no approve permission) | none |
| PENDING_REVIEW | A or B | `approve` | Approve | approve, and no `blocks: "approval"` row | PATCH `{ status: APPROVED, approval.payloadHash }` |
| APPROVED, FAILED_TALLY_IMPORT | A | `push_to_tally` | Push to Tally | push permission | POST `/api/tally/push` |
| APPROVED, FAILED_TALLY_IMPORT | B | `enter_in_tally` | Mode B: enter the SO in Tally by hand | never (a push is refused in Mode B) | none |
| any other | | `none` | No next step (status) | never | none |

The workspace shows the button in a bar pinned to the foot of the screen while the order is under review, with an optional note to the approver. The note is stored in `preflight_payload.submit_note` (already on the PATCH allowlist) and shown on the Approval tab.

### 6.3 Solo mode (off)

`review: "solo"` skips the second person by policy, and only when no `human_only` exception is open.

| Status | Action | Label | Enabled when | Existing calls |
|---|---|---|---|---|
| DRAFT | `confirm_and_generate` | Confirm and generate SO | no open `human_only` row, write and approve | PATCH `PENDING_REVIEW`, PATCH `APPROVED` with the payload hash, GET `/api/orders/so_pdf` |
| PENDING_REVIEW | `confirm_and_generate` | Confirm and generate SO | the same | PATCH `APPROVED`, GET `/api/orders/so_pdf` |

Each open `human_only` row is a named blocker. The server checks every transition as today, the approve permission included. After approval, solo changes nothing: Mode A pushes, Mode B keys the SO into Tally by hand.

## 7. Not built

- **The agent runner.** Nothing reads the queue and acts on it yet.
- **The decisions table** (plan PR 11, migration 264, `order_exception_decisions`), with `decided_by_kind` (`person` or `agent`) on each decision. Until it exists, every "not yet" option has no place to be recorded, and the card is read-only.
- **A tenant setting for the workflow config and the agent policy.** Both are data with documented defaults; nothing reads an override yet, and no migration is added.
- **The server-side anomaly run** (plan PR 8). Until it exists, an order whose rules never ran carries `anomaly_check_not_run`, whose option is the existing "run validation" button.
