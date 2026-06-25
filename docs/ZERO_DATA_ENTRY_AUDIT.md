# Zero Data Entry Audit — "the keystroke is the enemy"

Status: **Reference / parked plan** (2026-06-25). Assessment only — no code
changed. Use this to sequence future "remove the keystroke" work.

**Principle.** Data should enter Anvil by INGESTION — file/Excel/CSV import,
email, OCR/DocAI, voice, ERP/API sync, or **auto-derivation from the record
that came before it** — not by humans typing into forms.

## Verdict

Anvil has a strong ingestion *spine*; where data rides a pipeline it is
exemplary. The failure mode is not missing capability — it is that records
which should be **born from an upstream event are instead typed by hand.**
Rough split: ~40% zero-entry, ~30% hybrid, ~30% manual, and almost all of the
manual third is the same fixable pattern (auto-derivation not wired).

## Where it already embodies the principle (do not rebuild)

- **Document / pipeline spine:** `intake`, `email` triage, `bom-import`
  (gold standard — drop a file, origin/header/hierarchy auto-detected),
  `extraction-review`, `marketplace`, `duplicates`, `customer-duplicates`,
  `anomaly`. Human = triage, not typist.
- **Computed / auto-derived:** `home`, `sales-ops`, `forecasts`, `graph`,
  `cost`, `delays`, `inventory-planning`/`exceptions`, `invoices` (from
  orders), the whole **Tally** sync, `treds`.
- **Auto-registration:** `customers` appear from orders/email/BOM.

## Three recurring anti-patterns (the findings)

1. **Records typed instead of auto-derived from the record before them** —
   the biggest leak: `opps` (should come from an accepted quote), `projects`
   (from a won opp / received PO), `inventory-allocations` (from order
   schedule lines), `source-pos` (from supplier PO email / planning release),
   `einvoice` / `eway-bills` (pre-fill from order/shipment), `agents` (pick an
   order card, not type a UUID).
2. **Master data with no bulk path** — `inventory-suppliers`, `leads`, most
   of `admin`'s 20+ CRUD tabs (only item-master + customer-parts have CSV).
   `leads` especially should be email-to-lead.
3. **Field/judgment capture with no voice/OCR** — `service-visits`,
   `car` reports. Candidates for voice-to-text / photo-OCR on mobile; CAR
   auto-seeded from a flagged defect/return.

## Scorecard

| Group | Zero-entry | Hybrid | Manual |
|---|---|---|---|
| Workflows | home, intake, approvals, pipeline, sales-ops | quotes, so-intake, so-workspace | internal-sos |
| Sales | — | — | leads, opps, projects, shipments |
| Procurement | bom-import, delays, inv-planning, inv-exceptions | spares, inv-plans, logistics | source-pos, allocations, suppliers |
| Finance | tally(push+masters), invoices, cost, treds | reconcile, credit-notes, recurring | einvoice, eway-bills |
| Sustainability | brsr-buyer-dashboard | — | brsr-supplier |
| Data | customers, customer-duplicates, forecasts, graph | items | — |
| Service | — | amc | service-visits, car |
| Quality/Comms/Admin | marketplace, anomaly, email, duplicates, audit | studio, extraction-review, comms, voice | evals, agents, security, admin |

## Highest-leverage wins (ranked)

1. **Auto-derive the core chain** — accepted quote → opportunity → project,
   and order schedule-lines → allocations. (Spec below.)
2. **Pre-fill compliance docs** — e-invoice, e-way, credit-note lines from the
   order/shipment. 11–15 keystrokes → ~0.
3. **Email-to-lead** + supplier-PO-email → source-PO (rides the inbound email
   rail; see the parked Outlook/Graph plan).
4. **Voice/OCR field capture** for service-visits + CAR (reuse the Voice
   screen + DocAI).
5. **Import-first admin** — CSV/sync for suppliers, holidays, lead-times, FX.

Every win reuses machinery that already exists (the `invoices`-from-orders
auto-derive pattern, the inbound email pipeline, DocAI, the Voice screen, the
CSV importers). This is wiring, not greenfield.

---

## First candidate spec — quote → opportunity → project auto-derivation

Dead-center in the lead → opportunity → quote → PO flow, and the cleanest
example of anti-pattern #1. Today `opps` and `projects` are both 4–5-field
forms; they should be byproducts of events that already happen.

Reuse the existing precedent: `quotes/send.js` already arms `agent_goals` and
upserts `customer_part_numbers` on send — i.e. the codebase already does
"side-effects on a quote lifecycle transition." We extend the same hook.

### Behavior

- **Quote ACCEPTED → Opportunity.** When a quote flips to ACCEPTED (portal
  accept-token or manual), if it is not already tied to an opportunity,
  auto-create one in a won/committed stage, copying customer, amount
  (grand_total), currency, and back-linking quote_id. If the quote was
  created *from* an opp (the existing opp→quote line copy), just advance that
  opp's stage instead of creating a duplicate.
- **Opportunity WON (or quote ACCEPTED) → Project.** Auto-create a project
  (code from a sequence, name from customer + opp/quote ref, customer_id,
  phase=initiation, value) when none is linked. Idempotent on
  (tenant, source_quote_id) so re-firing never duplicates.
- **Order schedule-lines → allocations** (sibling win): when an order is
  approved, derive `inventory_allocations` from its schedule lines instead of
  manual entry.

### Guard rails (so it stays efficient, not noisy)

- **Idempotent + back-linked** — every derived record carries its source id
  (`source_quote_id` / `source_opportunity_id`); creation is a no-op if one
  exists. No duplicates on retry.
- **Propose vs auto** — default to *auto-create* for opp (low-risk, internal)
  and *propose* for project (so PM owns the project shell), using the existing
  `action_proposals` propose→confirm rail. Tunable per tenant later.
- **Audit** — stamp `recordAudit` with the derivation source so the chain is
  explainable.
- **Never blocks** — derivation is a post-commit side-effect of the lifecycle
  transition; it never sits in front of accepting a quote.

### Touch points (where to wire)

- `src/api/quotes/*` lifecycle (the ACCEPTED transition; mirror the
  `armQuoteAgentGoals` / customer-part upsert hook already there).
- `src/api/sales/opportunities.js` (create + stage advance; stage-event
  capture already exists).
- Projects create path (`src/api/projects/*` or admin) — add a derive helper.
- A small pure `_lib/derive-chain.js` (decide create-vs-advance, build the
  records) with unit tests — same shape as `_lib/bom-ingest.js`.

### Net effect

`opps` and `projects` stop being data-entry screens for the common path and
become review/exception surfaces (like `customers` already is) — two whole
forms removed from the happy path, and the funnel analytics get cleaner stage
events for free.
