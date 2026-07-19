# Anvil MCP tool surface for sales-order processing

Status: Phase 1 built (`feat/mcp-so-verify-tools`).

## Framing

"MCP for SO processing" means extending **Anvil's own** MCP server
(`src/api/mcp/server.js` → `_lib/erp-chat-tools.js`), not consuming a third
party's. Anvil already exposes tenant-scoped, RBAC'd, audited tools to the
operator copilot (`search_orders`, `search_customers`, `catalog_lookup`,
`get_quote_status`, …) and, via scoped tokens, to external MCP agents. The gap
was **verification/grounding** tools — the same signals the deterministic
extraction grounding pass (`docs/EXTRACTION_GROUNDING_DESIGN.md`) uses, now
callable on demand by an agent mid-conversation.

Each tool is a thin wrapper over logic that already exists, so there is no
duplicated business rule.

## Phase 1 — read / verify tools (this PR)

Added to `erp-chat-tools.js`, so they are automatically served to any MCP token
holding the matching read scope:

| Tool | Scope | Wraps | Returns |
|---|---|---|---|
| `verify_customer_gstin` | `read.customers` | `gstin.js` (`validateGstin`, `gstinStateCode`) + a `customers` lookup | `{ valid, verdict: known_customer / valid_unknown / invalid, matched, state_code }` |
| `resolve_item` | `read.inventory` | `hybrid-item-search` (`searchItemsHybrid`, lexical + semantic) | ranked `item_master` candidates with scores |
| `lookup_customer_parts` | `read.customers` | `item_customer_parts` + `item_master` | this customer's aliases → canonical part_no |

`resolve_item` is deliberately distinct from the existing `catalog_lookup`
(literal `ilike`): it uses the hybrid retriever so a PO line like "weld gun
contact tip 1.2mm" matches "TIP-CU-12", which literal search misses — the core
reconciliation problem.

A copilot session can now do: *"find PO 4500312200 → verify_customer_gstin →
resolve_item on each unmatched line → lookup_customer_parts for repeat aliases"*
— grounding the whole SO conversationally against Anvil's own data.

## Phase 2 — action tools (design)

Anvil already has the safe pattern for agent-initiated writes (PR2): `write.*`
tools are **propose-only** — they create an `action_proposals` row and return a
preview + single-use confirm token; a human confirms via `/api/copilot/confirm`
(approve-gated) to execute. MCP tokens need the explicit `write.*` scope
(default-deny). Phase 2 adds SO-processing actions on that rail:

- `apply_line_mapping` (`write.orders`) — snap a line to an `item_master` row
  (wraps the manual-map path).
- `set_order_customer` (`write.orders`) — pin `customer_id` (e.g. from a GSTIN
  match).
- `run_extraction` / `run_validation` / `send_for_review` /
  `request_correction` / `push_to_tally` — the existing state-machine handlers,
  exposed as proposals.

## Phase 3 — external-agent exposure (design)

Tighten scopes + per-token rate limits and issue read-only tokens to external
agents (e.g. a customer's procurement assistant checking order status via
`get_quote_status` / `search_orders`). Ties into the customer-portal plan.

## Design rules (mostly already enforced by the MCP server)

- Reuse existing endpoints/libs; the MCP layer is schemas + adapters only.
- Scopes + per-token RBAC (`dispatchErpChatTool` checks `opts.scopes`);
  `write.*` is default-deny.
- Writes go through propose → human-confirm (`action_proposals`), never silent.
- Audit every call (`mcpAudit`); tenant isolation via `eq("tenant_id", …)`.

## Relationship to the extraction grounding verifier (#262)

`verify_customer_gstin` / `resolve_item` are the **agent-invokable** version of
the same grounding. The **deterministic in-pipeline pass (#262) stays the
default** for automatic accuracy on every extraction; these tools let the copilot
(or an external agent) run the same checks interactively. One set of libs, two
entry points.
