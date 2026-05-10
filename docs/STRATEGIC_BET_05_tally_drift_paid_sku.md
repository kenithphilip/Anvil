# Strategic Bet 05: Tally drift reconciliation as paid SKU

> Source: research synthesis 2026-05-10. Companion to
> `docs/STRATEGIC_PLAN_2026_05.md` Bet 5.
> Status: research complete; engine shipped (PR #89); this bet is
> commercial packaging on top of working code.

## TL;DR

Productize Phase F.6 (the post-push Tally voucher reconciliation
engine shipped in PR #89) as a **paid add-on SKU**. Pricing: hybrid,
flat monthly fee + per-SO uplift overage. **Free for Growth tier
through 2026-12-31** as land-grab; **bundled at Enterprise**;
**Rs 2,000/mo + Rs 1.50/SO overage at Starter** as a loss-leader.

The competitive scan confirms **no Western IDP peer (Conexiom,
Rossum, Hyperscience) ships post-push voucher reconciliation as a
SKU.** BlackLine is the closest analogue at $77k+/yr platform commit.
TallyPrime 7.0's "smart reconciliation" is bank-statement matching,
not voucher-vs-source-document drift.

Effort: ~10 engineering days (one engineer, two weeks). Migration
`097`. The reconciler engine itself is shipped; this is wrapping it
in commercial packaging.

---

## 1. Research summary

### 1.1 Western IDP / AP automation peers

| Vendor | What they price | Reconciliation? |
|---|---|---|
| Conexiom | Annual SaaS per trading partner / per-doc / hybrid | 75+ pre-push validations; **no published post-push voucher reconciliation** |
| Rossum | Annual subscription by transaction count | Validation after extraction, before posting; **no post-push reconciliation** |
| BlackLine | $77k median, up to $340k/yr (Vendr) | The category-defining product for "match GL to bank/sub-ledger." Marketing copy: *"Exception Management flags discrepancies or unmatched transactions"* |
| FloQast | $30-120k/yr by tier; AutoRec / Tie Out / Flux Analysis as add-ons | Reconciliation is always an add-on, never baseline |
| Stampli / Tipalti | $250-1,500/mo bill-volume (Stampli), $149/mo basic + per-tx (Tipalti) | AP reconciliation, not productized as a separate SKU |
| Coupa | Bundled inside payments / treasury / Coupa Card | *"Payments are reconciled when posted, not when due"* - bundled, not separate |
| SAP Concur | Intelligent Audit + Detect by Oversight (paid, gated pricing) | Audit-readiness, not voucher-vs-ERP drift |

Sources: [Conexiom on getapp.com](https://www.getapp.com/operations-management-software/a/conexiom/),
[Rossum pricing](https://rossum.ai/pricing/),
[BlackLine reconciliations](https://www.blackline.com/products/financial-close/account-reconciliations/),
[BlackLine pricing analysis](https://www.numeric.io/blog/blackline-pricing),
[FloQast pricing](https://www.vendr.com/marketplace/floqast),
[Stampli vs Tipalti vs BILL](https://www.stampli.com/blog/ap-automation/tipalti-vs-bill/),
[Coupa intercompany reconciliation](https://www.coupa.com/blog/intercompany-reconciliation-and-netting/),
[SAP Concur Intelligent Audit](https://www.sap.com/products/spend-management/concur-expense-intelligent-audit.html).

### 1.2 Indian-market peers

| Vendor | What they ship | Voucher drift? |
|---|---|---|
| TallyPrime 7.0 | "Smart reconciliation" = bank-statement matching; Connected GST = GSTR-2A/2B match | **No first-party voucher-vs-source-document drift**. Silver Rs 22.5k lifetime / Rs 750/mo rental. |
| ClearTax / GSTrobo | GSTR-2A vs purchase register | GST reconciliation, not voucher drift. ClearTax ~Rs 40k/yr for 300 GSTINs / 3000 invoices |
| Tally Solutions partner ecosystem (TDLs) | Validation on Tally side | Not "compare what your IDP said with what Tally has" |

[TallyPrime 7.0 release notes](https://help.tallysolutions.com/release-notes-tallyprime-7-0/),
[ClearTax GST](https://www.techjockey.com/detail/cleartax-gst-software).

**Anvil is the only player (Western or Indian) shipping post-push
voucher reconciliation as a productized capability.**

### 1.3 Marketing positioning patterns

From BlackLine and FloQast hero copy:

- Formula: *"Find {drift / discrepancy / variance} before {audit /
  period close / month-end}."*
- Demo videos: 90-120 seconds, lead with a finding, end with a
  resolution.
- Customer-success metric that closes deals:
  *"$X of variance caught in the first {30, 60} days."*

---

## 2. Pricing model

| Tier | Tally Drift add-on |
|---|---|
| **Starter** | Rs 2,000/mo flat (loss-leader). Includes 200 reconciled SOs/mo; Rs 1.50/SO above |
| **Growth** | **Free through 2026-12-31** as land-grab. Then Rs 3,500/mo flat from 2027-01-01, including 1,000 SOs/mo; Rs 1.50/SO above |
| **Enterprise** | **Bundled.** No add-on, no per-SO uplift. Monthly QBR report is a sales asset |

Rationale:

- **Rs 1.50/SO uplift is the plan-doc primitive but pure-uplift is
  hard for the customer's CFO** to read - invoices fluctuate. Indian
  SMB CFOs sign flat far more readily than overage. Hybrid (flat +
  overage above included volume) gives both signals.
- **Free for Growth in 2026** because the Bet thesis is *defensibility
  from being the only player*. We need adoption logs and a
  $X-of-drift-caught metric to anchor every later pricing
  conversation. Once 30% of Growth customers run it, the conversion
  to Rs 3,500/mo is a renewal-meeting line, not a new-SKU sale.
- **Bundled at Enterprise** because the QBR report is the
  close-the-deal artifact. Nickel-and-diming Enterprise on this
  kills upsells of higher-margin add-ons (Voice AI, BYO LLM key).
- **Loss-leader at Starter** because Starter customers are most
  likely to defect to Tally + ClearTax + a spreadsheet. Showing
  drift on day 5 is what gets them to renew month 2.
- **Open question**: per-SO uplift on every reconciled voucher, or
  only on ones with drift? Recommendation: **every reconciled
  voucher** - matches the value (we did the work). Charging only on
  drift makes the customer want there to be drift (perverse).

### 2.1 Stripe SKU layout

Stripe deprecated `usage_records` on API 2025-03-31; meters are the
only forward-compatible primitive
([source](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage)).

- `prod_anvil_addon_drift_starter`: $24/mo + meter
  `tally_drift_so_overage` at $0.018/event over 200/mo.
- `prod_anvil_addon_drift_growth`: $0/mo until 2027-01-01, then
  $42/mo + same meter over 1,000/mo.
- `prod_anvil_addon_drift_enterprise`: included; not billed.

### 2.2 Razorpay SKU layout

Razorpay deprecated subscription-level Add-Ons; we use Usage Billing
on a dedicated plan
([Razorpay Subscriptions](https://razorpay.com/docs/payments/subscriptions/?preferred-country=IN)).

Three plans plus On Demand Add-on for the per-SO uplift.

---

## 3. Recommended approach

The reconciler engine is shipped in PR #89. What's left, in order:

1. **Gating**: a `tally_drift_addon_enabled` flag in
   `tenant_settings`. The cron drainer in
   `src/api/cron/tally-reconcile.js:20` filters tenant list by this
   flag. Manual `Run drift check` and `Reconcile now` buttons become
   locked-with-upsell when the flag is off.
2. **Onboarding**: first-run experience, monthly email, marketing
   surface.
3. **Billing**: meter writes on every drift run + Stripe / Razorpay
   product setup.

This is intentionally lean - the engine is done; this bet is
packaging.

---

## 4. Data model + migrations

**Migration `097_tally_drift_addon.sql`** (re-number if Bet 1/2/3/4
land first):

```sql
alter table tenant_settings
  add column if not exists tally_drift_addon_enabled boolean not null default false,
  add column if not exists tally_drift_addon_started_at timestamptz,
  add column if not exists tally_drift_addon_billing_plan text
    check (tally_drift_addon_billing_plan in ('starter','growth','enterprise','trial')),
  add column if not exists tally_drift_addon_stripe_subscription_id text,
  add column if not exists tally_drift_addon_razorpay_subscription_id text;

create table if not exists tally_drift_billing_meter (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reconciliation_run_id uuid references tally_reconciliation_runs(id) on delete set null,
  vouchers_reconciled int not null default 0,
  drift_caught_value_inr numeric(14,2) not null default 0,
  reported_to_stripe_at timestamptz,
  reported_to_razorpay_at timestamptz,
  stripe_meter_event_id text,
  razorpay_addon_id text,
  created_at timestamptz not null default now()
);

create index if not exists tally_drift_billing_meter_tenant_idx
  on tally_drift_billing_meter (tenant_id, created_at desc);
create index if not exists tally_drift_billing_meter_unreported_idx
  on tally_drift_billing_meter (tenant_id, reported_to_stripe_at, reported_to_razorpay_at)
  where reported_to_stripe_at is null and reported_to_razorpay_at is null;

alter table tally_drift_billing_meter enable row level security;
create policy "tally_drift_billing_meter_all" on tally_drift_billing_meter
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
```

`drift_caught_value_inr` is the marketing/sales-loaded number - sum
across the run: for `total_mismatch` use `abs(diff)`; for
`voucher_cancelled_in_tally` use the full voucher total. It feeds
the monthly report headline.

---

## 5. User-visible UX

### 5.1 Landing page feature card

`src/v3-app/screens/landing.tsx` `COVERAGE` block, new entry after
the existing `05 · finance` row:

```text
{ eb: "05.5 · finance", h: "Drift reconciliation",
  p: "Tally bridge is great. But what happens after you push? We
      check, every 30 minutes, that the voucher in Tally still
      matches the source PO. Cancelled? Altered? Total drift?
      You see it before your auditor does.",
  surf: ["Drift", "Findings", "Auto-fix", "Monthly report"] }
```

Plus a **Defensible Edge** panel above pricing:

> Find drift before your auditor does.
> Every voucher we push to Tally, we check 30 minutes later, and 30
> minutes after that. Totals, line counts, GSTIN, cancelled status.
> If anything moved, you know. With receipts. Available on Growth
> and above.

Screenshot list: drift findings table on `tally-reconcile.tsx`, SO
Workspace TallyTab banner, sample monthly PDF.

### 5.2 Pricing page row

`TIERS` block:
- Starter: `Drift reconciliation - Rs 2,000/mo add-on`.
- Growth: `Drift reconciliation - free through 2026-12-31`.
- Enterprise: `Drift reconciliation - included + monthly QBR report`.

### 5.3 First-run experience

When an operator flips the add-on on:

1. Modal: *"Drift reconciliation activated. We'll do a one-time scan
   of your last 30 days of pushed vouchers."* Single button "Run
   first scan."
2. Backend kicks `driftCheck(svc, { tenantId, scope: 'tenant_recent' })`
   synchronously, scope expanded to 30 days for first-run only.
3. Results page lands in `/v3/tally-reconcile`. If findings exist,
   the Drift findings card auto-opens and a banner says: *"We found
   {N} finding(s) covering Rs {X} of value. Walk through each
   below."* If clean: *"No drift found in your last 30 days. Nice."*

### 5.4 Monthly drift report email/PDF

Subject: `Anvil drift report · {tenant} · May 2026 · Rs {X} caught`.

Body sections:

- Headline tile: vouchers reconciled, vouchers drifted, Rs X drift
  value caught, Y auto-fixed, Z operator-resolved.
- Top 5 findings by severity, voucher number + finding kind +
  diff %.
- Audit-trail line: *"Every reconciliation run is in
  `tally_reconciliation_runs` with a UUID and operator name."*
- CTA: *"Forward this to your auditor."*

PDF rendered server-side via the existing invoice-PDF pipeline
(whatever path `invoice_pdf_downloaded` already uses).

---

## 6. Technical implementation plan

### 6.1 Migration

`097_tally_drift_addon.sql` (above).

### 6.2 Cron drainer gating

`src/api/cron/tally-reconcile.js:23`:

```js
const tenantsResp = await svc.from("tally_voucher_records")
  .select("tenant_id, tenant_settings!inner(tally_drift_addon_enabled)")
  .eq("status", "exported")
  .eq("tenant_settings.tally_drift_addon_enabled", true)
  .gte("created_at", since);
```

`src/api/tally/reconcile.js:71` (mode='drift_check' path): return
`402 Payment Required` when the flag is off, body
`{ error: { code: "addon_required", upgrade_url: "/billing/upgrade?addon=drift" } }`.

`mode='mark'` stays ungated - that's the legacy v1 button and is
part of base Tally.

### 6.3 Frontend gating

In `src/v3-app/screens/tally-reconcile.tsx`: fetch tenant settings;
if `tally_drift_addon_enabled` is false, the "Run drift check"
button becomes "Enable drift reconciliation" linking to the billing
upgrade screen. Findings/run cards replaced by an upsell card
(BlackLine-style: *"Anvil found Rs 4.2L of drift in pilot accounts
in the last 30 days. Yours could be similar."*).

Same for SO Workspace TallyTab `Reconcile now` button.

### 6.4 Stripe metered billing wiring

New `src/api/billing/stripe/drift-meter.js`. After every successful
`driftCheck` run in `src/api/_lib/tally-reconciler.js`, insert a
`tally_drift_billing_meter` row in the same transaction. New cron
`/api/cron/drift-meter` (every 60 min) drains unreported meter
rows to Stripe via `meter_events` (one event per row,
`payload.value = vouchers_reconciled`,
`payload.stripe_customer_id = stripe_account_id`). Store
`stripe_meter_event_id` on success.

Same pattern for Razorpay via the Add-on API on the active
subscription.

DB is source of truth, async drain to the meter, daily reconciliation
of count totals for billing audit.

### 6.5 Monthly drift report cron

New `/api/cron/tally-drift-report.js` running on day 1 at 09:00 IST.
For every tenant with the add-on enabled, aggregate the prior
month's runs + findings, render the PDF, send via the existing
email pipeline, write `audit_event` with
`action='drift_report_sent'`.

### 6.6 Outcomes wiring

`src/api/_lib/outcomes.js`:

```js
tally_recon_run:       "drift_check_run",
tally_drift_detected:  "drift_check_run",
tally_drift_resolved:  "drift_check_run",
```

New outcome `drift_check_run` so the customer-facing usage meter at
`/api/billing/usage` reflects reconciliation activity. Update
`docs/BILLING_OUTCOMES.md`.

### 6.7 Landing page changes

`src/v3-app/screens/landing.tsx` (TIERS block at line 273, COVERAGE
at line 253, new section between Coverage and Pricing per 5.1).

### 6.8 Admin upgrade flow

New row on `src/v3-app/screens/admin.tsx` subscription drawer to
flip `tally_drift_addon_enabled`. POST to `/api/billing/quote`
(already partial-scaffolded per `PRICING_STRATEGY.md:216`). Returns
price + checkout URL. The flag write itself is `recordAudit` with
`action='drift_addon_enabled'`.

---

## 7. Risks and open questions

- **Cannibalization**. Will Growth tenants see free bundled add-on
  as a reason to delay upgrading to Enterprise? Counter: the
  Enterprise *monthly QBR report* is the differentiator, not the
  engine. Hold the line on report-as-Enterprise-asset.
- **Pricing pushback**. Operators may say "this should be included."
  Counter with the BlackLine / FloQast comparison - every Western
  peer charges $30k-$340k/yr for this.
- **False-positive blowback**. Reconciler's `total_mismatch` fires
  on diff > 0.5% by default. Real-world tolerance for partial
  deliveries / discount adjustments is closer to 5%. The first
  month flags noise that isn't drift. Mitigation: ship a
  "tune your tolerance" wizard in the first-run experience that
  asks the operator three sample vouchers and sets
  `tally_recon_total_tolerance_pct` accordingly.
- **Auto-fix surprise**. Current `applyAutoFix` flips orders to
  `FAILED_TALLY_IMPORT` when Tally cancels the voucher. Customers
  running the add-on will see orders flip without warning.
  Mitigation: keep `tally_recon_auto_fix_enabled` defaulting to
  false (already shipped that way at migration `095:137`); the
  upgrade flow surfaces auto-fix as a separate explicit toggle.
- **Legal / audit copy**. The monthly report goes to the customer's
  auditor. Run `docs/SECURITY.md` and `docs/SOC2_CONTROLS.md`
  reviewers over the report template before shipping. Confirm the
  report doesn't claim *"we audited your books"* - it's *"we compared
  what we sent to what's there."*
- **Stripe meter migration timing**. Stripe deprecated legacy
  `usage_records` on API 2025-03-31. Use Meters from day 1; retrofit
  later is painful
  ([migration guide](https://docs.stripe.com/billing/subscriptions/usage-based-legacy/migration-guide)).
- **Razorpay Add-Ons deprecation**. Razorpay's classic Add-Ons
  feature was deprecated; we use Usage Billing on a dedicated plan
  instead. Fewer features available than Stripe meters.

---

## 8. Effort estimate

| Item | Eng days |
|---|---:|
| Migration 097 + RLS | 0.25 |
| Cron drainer + reconcile.js gating | 0.5 |
| Frontend gating in tally-reconcile.tsx + TallyTab | 0.75 |
| First-run experience modal + 30-day scope expansion | 0.75 |
| Stripe meter wiring (drift-meter cron + meter_events drain) | 1.5 |
| Razorpay subscription wiring | 1.0 |
| Monthly drift report cron + PDF template + email | 2.0 |
| Outcomes.js + BILLING_OUTCOMES.md + admin.tsx upgrade UI | 0.75 |
| Landing page feature card + pricing-row updates + Defensible Edge | 1.0 |
| QA, tolerance-tuning wizard, copy review | 1.5 |
| **Total** | **~10 days** (1 engineer, 2 weeks) |

---

## 9. Sources cited

VERIFIED:
- [Conexiom pricing - getapp.com](https://www.getapp.com/operations-management-software/a/conexiom/)
- [Conexiom - trustradius.com](https://www.trustradius.com/products/conexiom/pricing)
- [Rossum pricing](https://rossum.ai/pricing/)
- [BlackLine reconciliations](https://www.blackline.com/products/financial-close/account-reconciliations/)
- [BlackLine pricing analysis - numeric.io](https://www.numeric.io/blog/blackline-pricing)
- [FloQast pricing - vendr.com](https://www.vendr.com/marketplace/floqast)
- [FloQast pricing - numeric.io](https://www.numeric.io/blog/floqast-pricing)
- [Stampli vs Tipalti vs BILL](https://www.stampli.com/blog/ap-automation/tipalti-vs-bill/)
- [Coupa intercompany reconciliation](https://www.coupa.com/blog/intercompany-reconciliation-and-netting/)
- [SAP Concur Intelligent Audit](https://www.sap.com/products/spend-management/concur-expense-intelligent-audit.html)
- [TallyPrime 7.0 release notes](https://help.tallysolutions.com/release-notes-tallyprime-7-0/)
- [TallyPrime pricing - markitsolutions.in](https://www.markitsolutions.in/product/tally-prime)
- [ClearTax GST - techjockey.com](https://www.techjockey.com/detail/cleartax-gst-software)
- [GST reconciliation software](https://www.softwaresuggest.com/gst-reconciliation-software)
- [Stripe usage-based billing](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage)
- [Stripe meter migration guide](https://docs.stripe.com/billing/subscriptions/usage-based-legacy/migration-guide)
- [Razorpay Subscriptions](https://razorpay.com/docs/payments/subscriptions/?preferred-country=IN)
- [BlackLine reconciliation guide](https://www.numeric.io/blog/ultimate-guide-to-blackline-account-reconciliation)

Codebase paths cited:
- `src/api/_lib/tally-reconciler.js`
- `src/api/cron/tally-reconcile.js`
- `src/api/tally/reconcile.js`
- `src/api/cron/tick.js`
- `src/api/billing/usage.js`
- `src/api/_lib/outcomes.js`
- `src/v3-app/screens/landing.tsx`
- `src/v3-app/screens/so-workspace.tsx`
- `src/v3-app/screens/tally-reconcile.tsx`
- `supabase/migrations/095_tally_reconciliation.sql`
- `supabase/migrations/013_stripe.sql`
- `docs/PRICING_STRATEGY.md`
