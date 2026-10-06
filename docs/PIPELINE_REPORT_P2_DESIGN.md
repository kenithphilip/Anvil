# Pipeline Conversion Report — P2 design (DRAFT)

Status: **draft for review** (2026-08-07). Follows P1 (uploaded quote-revision tracking, PR #381 / migration 203). Not yet built — this is the plan.

## 1. Purpose & audience

Sales managers and the sales head need a **standardized** pipeline view — replacing per-team Outlook + ad-hoc Excel — that answers, on a **daily / weekly / monthly** basis:

> Of the quotes/inquiries we sent, how many became **sales orders processed**, and how many became **sales completed (payment received)** — in count and in value — and where is it stalling?

Primary users: `sales_manager` / `sales_head` (see everything); a `sales_engineer` sees their own numbers. It reads the three real events already in the system and lines them up over time.

## 2. The core data reality (read this first — it shapes everything)

The three funnel stages live in three different tables, and **the top of the funnel is not hard-linked to the bottom.** Verified against the schema:

| Funnel stage | Source of truth | "Counts when…" |
|---|---|---|
| **Quote / inquiry sent** | `opportunity_quotes` (migration 203, P1) | `status = 'sent'`, bucket by `sent_at`; value = `amount` |
| **Sales order processed** | `orders` (001) | `status = 'APPROVED'` (`approved_at` set); downstream `EXPORTED_TO_TALLY` / `RECONCILED` are still "processed" |
| **Sale completed (paid)** | `invoices` (012) | `status = 'paid'` (`paid_at`, `paid_amount`); an order has **0..N** invoices (progress invoicing) |

**The attribution gap (the key design constraint):**

- `opportunity_quotes` has **no `order_id` / `invoice_id`** — only `opportunity_id` + `customer_id`. So an uploaded quote revision has **no direct edge** to the SO it became or the invoice that was paid.
- The revenue chain hangs off the *other*, generated-quote table: `quotes`(068) `.opportunity_id` → `orders.quote_id` → `invoices.order_id`. Our P1 "quotes sent" signal is the uploaded `opportunity_quotes`, which does **not** populate that chain.
- `orders` has **no `opportunity_id`** at all. The only opportunity link is the 2-hop `orders.quote_id → quotes.opportunity_id`, which is `NULL` for direct-PO / voice / WhatsApp orders.

**Consequence:** a literal "this specific quote → this specific paid invoice" join is not reliably available today. The report is therefore designed around **two computation modes** (§5), and recommends one small schema bridge (§6, P2b) to make precise attribution possible.

## 3. What to report (metrics)

Per period (day / week / month), per tenant, sliceable by **owner** (sales engineer) and **customer / tier**:

- **Quotes sent** — count + Σ value of `opportunity_quotes.status='sent'`; plus # distinct opportunities quoted, # distinct customers, and **avg revisions per opportunity** (max `version` depth = negotiation churn).
- **Orders processed** — count + Σ value of `orders` reaching `APPROVED` (by `approved_at`).
- **Sales completed (paid)** — count + Σ `paid_amount` of `invoices.status='paid'` (by `paid_at`); show **partial** collection too (`status='partial'`).
- **Conversion ratios** (period-level): orders/quotes, paid/orders, paid/quotes — in both count and value.
- **Cycle times** (medians): quote-sent → order-approved; order-approved → paid (AR days).
- **Open / stalled** — the actionable list: **quotes sent with no order yet**, aged into buckets (0–7 / 8–30 / 31–60 / 60+ days). This is the manager's follow-up worklist.

### Report views (frontend, in `sales-ops.tsx`)
1. **Trend** — 3 series (quotes / orders / paid) over the chosen granularity, value + count toggle.
2. **Conversion funnel** — quotes → orders → paid for the selected window, with ratios.
3. **Rep leaderboard** — per sales engineer: quotes sent, orders, paid, win-rate, median cycle.
4. **Stalled quotes** — the aged "no order yet" worklist, drill-down to the opportunity.

## 4. Definitions / edge cases

- **"Processed"** = `orders.status IN ('APPROVED','EXPORTED_TO_TALLY','RECONCILED')`, threshold event = first `APPROVED` (`approved_at`). `DRAFT/PENDING_REVIEW/BLOCKED/DUPLICATE/REUSED/CANCELLED/FAILED_TALLY_IMPORT` are **not** processed.
- **"Paid"** = canonical definition from `applyPayment` / `src/api/_lib/payments.js`; use `invoices.status='paid'` and `paid_amount` (includes TDS postings via `payment_records`). An order with **zero** invoices has no paid signal — correct (nothing billed yet).
- **Value currency**: amounts are multi-currency (`amount_currency`, `invoices` currency). Report in INR using the same FX convention as existing analytics; expose raw currency in drill-down.
- **Superseded quotes**: count a "quote sent" event per revision that was actually sent, but for **cohort** conversion collapse to the opportunity (don't double-count one deal because it had 4 revisions).

## 5. Two computation modes

**(a) Aggregate trend — always correct, no join.** Three independent per-period time series + period-level ratios. This is the robust default and satisfies "compare quotes sent vs orders processed vs sales completed over time." Ships in P2a.

**(b) Cohort attribution — opportunity-grain.** For quotes sent in a period, follow the **opportunity** to a won order + paid invoices, to compute *true* cohort conversion ("of quotes sent in July, X% became orders, Y% got paid"). Uses the opportunity bridges that DO exist (`quotes.converted_order_id`, `opportunities.related_quote_id`, and — after P2b — `orders.opportunity_id`). Direct-PO orders with no opportunity link are reported as an explicit **"unattributed"** bucket rather than silently dropped.

Both modes are shown; the UI labels cohort conversion as "attributed" and surfaces the unattributed share so the number is honest.

## 6. Phased plan

### P2a — the report (live compute, no schema change)
- New handler `GET /api/analytics/pipeline?granularity=day|week|month&from=&to=&owner_id=&customer_id=`, **cloning the live-compute + tenant-scope pattern of `src/api/analytics/ops_kpis.js`** (bounded window ≤365d).
- Pure compute helper `computePipelineConversion()` beside `src/api/_lib/ops-kpis.js` (I/O-free, unit-tested): takes rows of `opportunity_quotes` (sent), `orders` (approved), `invoices` (paid) + the opportunity bridges, returns per-period aggregates + opportunity-grain cohort + stalled list.
- Client `analytics.pipeline(q)`; new **Pipeline** view in `src/v3-app/screens/sales-ops.tsx` (reuse the existing KPI/trend primitives already used by funnel/ops_kpis).
- RBAC: `requirePermission(ctx,'read')`; managers/head (APPROVER/ADMIN roles) see all reps, a `sales_engineer` is scoped to `sent_by = ctx.user.id` / `opportunity.owner_id = ctx.user.id`.
- Tests mirroring `api-ops-kpis.test.js` / `api-analytics-funnel.test.js`.

### P2b — precision + scale (recommended follow-up)
- **Migration: add `orders.opportunity_id uuid references opportunities(id)`** (nullable, indexed), **backfilled** from `orders.quote_id → quotes.opportunity_id` where present. This is the single highest-leverage change: it makes **every** order attributable to an opportunity (fixing the direct-PO blind spot) and turns cohort conversion into a real key-join. Optionally also `opportunity_quotes.converted_order_id` for quote-revision-level precision.
- **Materialize `analytics_pipeline_daily`** (`tenant_id, day, owner_id, quotes_sent_count/value, orders_processed_count/value, paid_count/value, …`, `unique(tenant_id, day, owner_id)`), refreshed by a `refreshPipeline()` materializer that mirrors `refreshFunnel` in `src/api/_lib/funnel-analytics.js`, hooked into the existing cron drain `POST /api/analytics/refresh`. Endpoint reads the rollup for long ranges; live-computes for short windows. Needed only when live compute over a year gets slow.

## 7. Reuse map (don't build from scratch)
- Endpoint shape / tenant-scope / window param: `src/api/analytics/ops_kpis.js`, `funnel.js`, `winloss.js`.
- Cron-all-tenants vs manual refresh: `src/api/analytics/refresh.js`.
- Compute helpers + median/percentile: `src/api/_lib/ops-kpis.js`, `src/api/_lib/funnel-analytics.js`.
- Canonical "is-paid" (incl. TDS): `src/api/_lib/payments.js` (`applyPayment`).
- Rollup-table conventions (idempotent upsert, RLS via `current_tenant_ids()`): migrations 034 / 140 (note: new tables use the 203-era `current_tenant_ids()` helper).
- Client + screen: `src/client/anvil-client.js` analytics namespace (:435–439); `src/v3-app/screens/sales-ops.tsx`.

## 8. Dependencies & rollout
- ⚠️ **Depends on migration 203 being applied to the live DB** — `opportunity_quotes` is the "quotes sent" source; the report is empty/500s until 203 is run (203 is still pending manual apply, along with 200–202). Any P2b rollup table + `orders.opportunity_id` also apply **manually**.
- No auto-migrate on deploy — every migration here is manual.

## 9. Open questions for review
1. **Scope P2a alone first, or P2a + the `orders.opportunity_id` bridge together?** Recommendation: ship P2a (aggregate + opportunity-grain cohort) for the manager dashboard now; do the `orders.opportunity_id` bridge as a fast follow — it's a ~1-migration change that materially improves every conversion number and future report.
- 2. **"Inquiry" vs "quote"**: the request says "quote or inquiry status." Do inquiries (pre-quote leads / IndiaMART inbound) count as a separate top-of-funnel stage, or only sent quotes? Current design counts **sent quotes**; leads/inquiries can be added as a 0th stage from `leads` if wanted.
3. **Value normalization**: confirm the INR FX convention to use for mixed-currency deals (match `ops_kpis`?).
4. **Materialize now or later**: live compute is fine to start; add `analytics_pipeline_daily` when ranges/perf demand it.
