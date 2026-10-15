# Agent-ready SO flow: the exceptions work queue

| | |
|---|---|
| Status | Built: the exceptions list and its hooks (plan PR 9). Not built: the agent runner, and the decisions table (plan PR 11). |
| Code | `src/api/_lib/order-exceptions.js` (pure), `GET /api/orders/exceptions`, the "Needs decision" card in the SO workspace. |
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
  agent_policy:   the policy in force (section 5)
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
| finding (`orders.rule_findings`) | `mod_bom_pending`, `line_count_shortfall`, `blocking_finding`, `finding:<code>` |
| anomaly (the rule library) | `anomaly:<rule>`, `anomaly_check_not_run` |
| extraction (the run) | `extraction_no_lines`, `extraction_failed`, `extraction_low_confidence`, `extraction_fallback_parse`, `extraction_check:<code>` |
| terms (the terms check) | `terms_flag`, `terms_not_read` |
| customer (the match) | `customer_unmatched`, `customer_gstin_conflict`, `customer_low_confidence`, `customer_state_differs` |

Dedupe, one row per issue:

- a payment-terms or incoterm verdict and a terms flag on the same clause: the terms flag wins;
- the `-MOD` blocker in `rule_findings` and the reconcile's `mod_bom`: the finding wins;
- a line-count shortfall as an extraction anomaly and as a finding: the finding wins;
- an anomaly rule stored in `rule_findings` and in `anomaly_flags`: one row.

A terms flag that was already decided closes the reconcile's copy of the same clause as `decided`. A resolved finding closes its copies the same way.

## 4. Resolution options

The vocabulary: `accept_po_value`, `accept_quote_value`, `request_amendment`, `reject_line`, `reject_term`, `not_a_deviation`, `set_value`, `map_item`, `add_line`, `run_check`, `confirm`, `change_customer`, `update_master`.

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
| `anomaly:*` | `confirm` (not yet), `set_value`, `run_check` (POST `/api/anomaly/compute`) |
| `anomaly_check_not_run` | `run_check` (POST `/api/anomaly/compute`, then PATCH `rule_findings`) |
| `extraction_*` | `run_check` (POST `/api/docai/extract`), `confirm` (not yet), `set_value` where a line is named |
| `terms_flag` | `accept_po_value`, `request_amendment`, `reject_term`, `not_a_deviation` (POST `/api/orders/terms_decide`) |
| `terms_not_read` | `run_check` (POST `/api/orders/terms_check`) |
| `customer_unmatched`, `customer_low_confidence` | `change_customer` (not yet: `customer_id` is not in the PATCH allowlist, plan PR 7), `confirm` (not yet) |
| `customer_gstin_conflict`, `customer_state_differs` | `update_master` (POST `/api/customers`), `confirm` (not yet) |

"Not yet" options become real when plan PR 11 stores decisions.

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

## 6. Not built

- **The agent runner.** Nothing reads the queue and acts on it yet.
- **The decisions table** (plan PR 11, migration 264, `order_exception_decisions`), with `decided_by_kind` (`person` or `agent`) on each decision. Until it exists, every "not yet" option has no place to be recorded, and the card is read-only.
- **The server-side anomaly run** (plan PR 8). Until it exists, an order whose rules never ran carries `anomaly_check_not_run`, whose option is the existing "run validation" button.
