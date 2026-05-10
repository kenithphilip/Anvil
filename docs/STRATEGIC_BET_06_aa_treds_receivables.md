# Strategic Bet 06: AA + TReDS receivables loop

> Source: research synthesis 2026-05-10. Companion to
> `docs/STRATEGIC_PLAN_2026_05.md` Bet 6.
> Status: research complete; **gated on partner onboarding** (FIU
> + TReDS) before code work proceeds beyond migration + sandbox.

## TL;DR

Plug **Account Aggregator** (RBI's open-banking framework) and
**TReDS** (Trade Receivables Discounting System) into the Anvil
dunning + customer-portal loop. When a tenant's invoice is overdue,
offer the tenant (the **supplier**) an AA-mediated discount through
a TReDS partner; cash settles T+1 to T+2.

**Anvil cannot become an FIU directly** (per RBI Master Direction:
FIU must be RBI / SEBI / IRDAI / PFRDA-regulated). Anvil integrates
as a **TSP** under a partner FIU's licence.

Recommended partners: **Setu** (multi-AA gateway, Embed UI) +
**M1xchange** (highest TReDS throughput in 2026).

Targets: 5% of overdue invoices discounted via TReDS within 6
months. AA consent rate >60% on prompt.

Effort: ~36 dev days plus ~10-12 weeks calendar gated on partner
onboarding. Migration `097`.

---

## 1. Research summary

### 1.1 Account Aggregator framework state (May 2026)

- AA = RBI consent-driven open-banking framework. Brokers data
  between FIPs (banks) and FIUs (lenders) through licensed
  NBFC-AAs.
- H1 FY26: ~Rs 1.47 lakh cr loans across 1.5 cr loans
  (~Rs 24,000 cr/month, up from ~Rs 14,000 cr in H2 FY25).
- 16 NBFC-AA licences issued. Active set with meaningful FIP
  coverage: **Anumati (Perfios), CAMS Finserv, OneMoney, Finvu
  (Cookiejar), NADL (NeSL), Setu AA, Protean SurakshAA**. Top
  by FIP coverage: Anumati (~80+), CAMS (~70+), OneMoney (~65+),
  Finvu (~60+), NADL (~60+).

### 1.2 FIU eligibility (decisive)

Per [RBI Master Direction (2016, amended through 2024)](https://www.rbi.org.in/Scripts/BS_NBFCNotificationView.aspx?Id=10598)
and the [Oct-2023 reciprocity circular](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12537):

> An FIU must be regulated by RBI, SEBI, IRDAI or PFRDA.

**Anvil is unregulated SaaS. The only legal path is to integrate as
a TSP** that builds the consent + fetch UX on behalf of an FIU
partner (the TReDS platform itself, or a financier). A TSP needs no
NBFC-AA licence. Implementation cost: TSP setup fee + per-consent /
per-fetch.

### 1.3 TReDS state (May 2026)

Three RBI-licensed platforms:

- **M1xchange** (Mynd Solutions): crossed Rs 1 lakh cr throughput in
  10 months of FY26. Targeting Rs 1.25-1.30 lakh cr FY26, Rs 1.75
  lakh cr FY27. 70+ financiers, 70k MSMEs.
- **RXIL** (SIDBI + NSE JV): 27,500+ MSMEs, $12.65B cumulative.
- **Invoicemart / A.TReDS** (Axis Bank + mjunction).

Industry-wide TReDS financing FY26: ~Rs 3.5 lakh cr.

Discount rates: **8-12% p.a. for AAA buyers, 13-21% p.a. for weaker
buyers**, set via competitive auction. Settlement T+1 / T+2 to
seller. MSME pays no platform fee; buyer pays small platform
commission (~10-25 bps).

### 1.4 Union Budget 2026-27 reforms (verified)

- TReDS mandated as the settlement platform for **all** CPSE
  purchases from MSMEs.
- **GeM-TReDS integration** lets financiers see government purchase
  data directly.
- CGTMSE-backed invoice discounting and TReDS-receivables
  securitisation introduced.
- M1xchange CEO publicly guides ~40% volume surge from these reforms.

### 1.5 Compliance

- DPDP Act 2023 § 6: consent must be "free, specific, informed,
  unconditional and unambiguous, with clear affirmative action."
- AA framework natively satisfies this; closest pre-existing
  template for DPDP Consent Manager obligations per Sahamati.
- Records retention: 7 years from consent or withdrawal.

---

## 2. Vendor / partner recommendation

**AA aggregator**: **Setu (multi-AA gateway via Setu's FIU rails)**.
- Most documented multi-AA gateway. Single FIU API across Anumati /
  CAMS / OneMoney / Finvu / NADL.
- Hosted consent UI (Setu Embed) we drop in.
- Setu AA is RBI-licensed, but the gateway product is what Anvil
  consumes.
- Pricing: volume-tier negotiated (Finvu reference: Rs 20-30 per
  data fetch).
- Phase 2: switch to / add Finvu after volume hits ~50k consents
  per month.

**TReDS platform**: **M1xchange**.
- Highest 2026 throughput.
- 70+ active financiers (RXIL / Invoicemart smaller pools).
- 10-minute digital onboarding.
- Channel-partner / TSP onboarding team.
- Add **RXIL** in Phase 2 (NSE / SIDBI distribution gives strength
  in CPSE-adjacent buyers post-budget).
- Skip Invoicemart in v1.

---

## 3. Recommended approach for Anvil

### 3.1 Who initiates and when

The **supplier** (the Anvil tenant). TReDS factoring lets the
seller of an invoice get paid early; the buyer is a passive
accept-the-invoice party.

Three triggers, increasing assertiveness:

1. **DPD >= 15** (days past due): dunning email tier `firm` includes
   a tenant-facing CTA *"Get paid today via TReDS - supplier
   portal."* Email subject unchanged; small banner at the foot.
2. **DPD >= 30**: separate operator-side push notification + Slack
   to the supplier tenant: *"3 invoices > Rs X lakh eligible for
   TReDS auction."*
3. **Tenant-initiated**: any time, from the invoice detail screen
   "Discount this invoice" button.

### 3.2 What flows where

1. Supplier clicks "Discount via TReDS" on an invoice. Anvil checks
   the buyer's PAN / GSTIN matches a TReDS-onboarded corporate
   (`treds_eligible_buyers` table refreshed nightly from M1xchange).
2. If yes, Anvil opens an **AA consent screen** (Setu Embed)
   requesting the supplier's bank account statements (last 6
   months); financiers want this for credit decisions. Scope:
   deposit accounts only. Purpose: *"Working capital - TReDS
   factoring."* Consent TTL: 30 days, single fetch.
3. Anvil pushes the invoice to M1xchange via API: invoice number,
   amount, GST IRN (Anvil already has this from the einvoice flow),
   buyer GSTIN, due date. M1xchange opens an auction.
4. Buyer accepts the invoice on M1xchange (out-of-band; mandatory).
   If buyer is not a TReDS member, flow falls back to an email
   *"request your buyer to onboard to TReDS."*
5. Auction completes within 1-4 hours; M1xchange returns the winning
   bid (rate, financier name).
6. Supplier sees: *"Best offer: 11.4% p.a., Rs 9,87,400 net of
   Rs 12,600 discount, settled T+1 to your bank ending 4521."*
   Accept / decline.
7. On accept: financier disburses to supplier T+1; original invoice
   in Anvil flips status to `discounted_via_treds` (NOT to `paid` -
   the buyer still owes the financier on the original due date).
8. Anvil writes `audit_events` rows: AA consent grant, TReDS
   submission, accept/decline.

### 3.3 Buyer-side soft nudge

When a buyer hits the customer portal pay-now page on a discounted
invoice: *"Paid to your supplier on DD/MM via TReDS. You owe
Rs X to <financier> by <due date>."* Soft nudge for the buyer to
onboard themselves to TReDS.

---

## 4. Data model + migrations

**Migration `097_aa_treds.sql`** (re-number if Bet 1/2/3/4 lands
first). Four tables, all RLS-scoped on `tenant_id`.

```sql
-- tenant_settings: AA + TReDS partner config
alter table tenant_settings
  add column if not exists aa_provider text check (aa_provider in ('setu','finvu','none')) default 'none',
  add column if not exists aa_client_id_enc bytea,
  add column if not exists aa_client_secret_enc bytea,
  add column if not exists aa_creds_iv bytea,
  add column if not exists aa_fiu_partner_id text,
  add column if not exists treds_provider text check (treds_provider in ('m1xchange','rxil','invoicemart','none')) default 'none',
  add column if not exists treds_member_id text,
  add column if not exists treds_api_key_enc bytea,
  add column if not exists treds_api_secret_enc bytea,
  add column if not exists treds_creds_iv bytea,
  add column if not exists treds_min_invoice_inr numeric(14,2) default 100000,
  add column if not exists treds_auto_offer_dpd int default 15;

create table if not exists aa_consents (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id),
  invoice_id uuid references invoices(id),
  party_kind text not null check (party_kind in ('supplier','buyer')),
  consent_handle text not null,
  consent_id text,
  status text not null check (status in ('pending','active','revoked','expired','rejected','failed')),
  fi_types text[] not null,
  purpose_code text not null,
  expires_at timestamptz,
  granted_at timestamptz,
  revoked_at timestamptz,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, consent_handle)
);
create index if not exists aa_consents_invoice_idx on aa_consents (tenant_id, invoice_id);
create index if not exists aa_consents_status_idx on aa_consents (tenant_id, status);

create table if not exists treds_offers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  treds_platform text not null,
  external_factoring_id text not null,
  buyer_gstin text not null,
  amount_inr numeric(14,2) not null,
  due_date date,
  auction_status text not null check (auction_status in ('submitted','buyer_pending','live','won','no_bid','rejected','withdrawn','expired')),
  best_rate_bps int,
  best_financier_name text,
  net_amount_inr numeric(14,2),
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, treds_platform, external_factoring_id)
);
create index if not exists treds_offers_invoice_idx on treds_offers (tenant_id, invoice_id);
create index if not exists treds_offers_status_idx on treds_offers (tenant_id, auction_status);

create table if not exists treds_discounts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  offer_id uuid not null references treds_offers(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  financier_name text not null,
  rate_bps int not null,
  amount_inr numeric(14,2) not null,
  net_to_supplier_inr numeric(14,2) not null,
  platform_fee_inr numeric(14,2),
  settlement_at timestamptz,
  status text not null check (status in ('disbursed','settled','failed','reversed')),
  utr text,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, offer_id)
);
create index if not exists treds_discounts_invoice_idx on treds_discounts (tenant_id, invoice_id);

alter table invoices
  add column if not exists discounted_via_treds_at timestamptz;
```

RLS policies mirror the shape from `020_razorpay.sql` and
`022_customer_portal.sql`.

---

## 5. User-visible UX

### 5.1 Tenant onboarding (settings/integrations screen)

Two new cards under "India rails":

- **Account Aggregator**: pick provider, paste FIU credentials,
  test consent flow.
- **TReDS**: pick platform, paste M1xchange member ID + API key,
  set `treds_min_invoice_inr` and `treds_auto_offer_dpd`.

Both cards mirror the existing Razorpay card pattern from
`admin.tsx`.

### 5.2 Per-invoice flow (operator-side, in `invoices.tsx`)

New "Discount via TReDS" button visible when:
- currency = INR,
- buyer GSTIN present,
- invoice unpaid AND DPD >= threshold OR operator explicitly opens.

Click opens a slideover:
1. AA consent picker.
2. Consent confirmation (Setu Embed iframe).
3. TReDS submission summary.
4. Live auction status (polled every 30s).
5. Accept-best-bid CTA.

### 5.3 Customer-portal pay-now page

`api/portal/pay.js` + the rendered HTML in `view.js`:
- When invoice is `discounted_via_treds`, swap the Pay-Now CTA for
  *"This invoice has been factored. Pay <financier> by <date>"* with
  the financier's UTR / IFSC details.
- When invoice is overdue and buyer is not yet a TReDS member: show
  a small "Tip for buyers" panel: *"Your supplier offers TReDS.
  Onboard at m1xchange.com to settle MSME invoices faster."*
  Informational only.

Note: there is no `src/v3-app/screens/customer-portal.tsx` in the
current branch - the portal is server-rendered through
`api/portal/view.js` and a generic SPA chunk. Visible UI changes
land in the portal payload + the SPA shell.

### 5.4 Operator dashboard (new screen `treds.tsx`)

Tabs: Active offers, Settled, Declined.

Headline KPIs: total discounted volume, average rate, share of
overdue invoices funded, time-to-cash distribution. Same chart
patterns as `cost.tsx`.

### 5.5 Dunning email update

`dunning-drafter.js` gets a new optional context field
`treds_offer_url`. When present and tier >= firm, drafter prepends:

> If the delay is on your end, we can offer a TReDS-financed early-
> pay option - reply EARLY-PAY and we will send the link.

Opt-in, low-pressure, preserves the buyer-facing tone.

---

## 6. Technical implementation plan

### 6.1 New module `src/api/aa/`

- `aa/_lib/client.js`: provider-abstract HTTP client (Setu primary,
  Finvu adapter shim). Reuses `safeFetch` and the secrets pattern
  from `razorpay-client.js`. Public surface: `requestConsent`,
  `pollConsent`, `fetchData`, `verifyWebhook`.
- `aa/consent.js`: POST handler from operator UI; creates
  `aa_consents` row with `status=pending`, returns redirect URL
  for Setu Embed.
- `aa/callback.js`: receives Setu redirect with `consent_handle`,
  flips status to active, optionally triggers data fetch.
- `aa/webhook.js`: Setu callbacks for consent state changes
  (revoked / expired). HMAC-verified, idempotent.

### 6.2 New module `src/api/treds/`

- `treds/_lib/client.js`: M1xchange first; RXIL adapter scaffold.
  Surface: `submitFactoring`, `getAuctionStatus`, `acceptBestBid`,
  `withdrawOffer`. Webhook handler for status pushes.
- `treds/offer.js`: POST submit invoice; creates `treds_offers` row.
- `treds/accept.js`: POST accept best bid; creates
  `treds_discounts` row, sets `invoices.discounted_via_treds_at`,
  writes `audit_events`.
- `treds/list.js`: GET operator listing; joins offers + discounts.
- `treds/eligible_buyers.js`: nightly cache refresh of buyer GSTINs
  that are TReDS-active.

### 6.3 Cron updates

- `cron/daily.js`: refresh `treds_eligible_buyers` from M1xchange
  `GET /v1/buyers`. Poll `treds_offers` rows in
  `auction_status in ('submitted','buyer_pending','live')`.
- `agents/_handlers/ar_collect.js`: gain a guard up top - if invoice
  has `discounted_via_treds_at`, return `mark_complete` with
  `reason: 'treds_factored'`. Set `treds_offer_url` for the drafter
  when tenant has TReDS configured and tier in {firm, final}.

### 6.4 Customer-portal changes

- `api/portal/pay.js`: short-circuit when invoice is
  `discounted_via_treds`; return 409 with
  `{ code: 'INVOICE_FACTORED', financier, financier_account, due_at }`.
- `api/portal/view.js`: include `discounted_via_treds_at` and
  financier details on `kind=invoices`.
- Portal SPA: financier-pay copy block in the existing portal SPA
  chunk (no separate `customer-portal.tsx`).

### 6.5 Audit + RLS

Every consent grant, fetch, offer-submit, discount-accept records
an `audit_events` row through `recordAudit` with `object_type` in
{`aa_consent`, `treds_offer`, `treds_discount`}. Migration adds
these to the audit object-type CHECK if it has one.

---

## 7. Risks and open questions

- **AA partnership lead time**. Setu onboarding for a TSP integrating
  with a downstream FIU partner: ~6-8 weeks (Sahamati certification
  audit on the integrating FIU's behalf, UAT in Setu sandbox, prod
  activation). Anvil cannot be the FIU; we wire the consent under
  M1xchange's FIU registration (or a financier-FIU). **Confirm
  M1xchange will host Anvil as TSP under their FIU before scoping
  the build.**
- **TReDS API access tier**. M1xchange has APIs for corporates and
  channel partners; depth varies. Need NDA + commercial agreement.
- **Buyer-side onboarding**. TReDS auctions only run if buyer has
  accepted the invoice on the platform; offer is conditional on
  buyer being a TReDS corporate. Cache must be reliable.
- **DPDP compliance review**. Privacy review of the AA fetch -
  purpose strings, retention, consent withdrawal UX. 7-year
  retention.
- **Reciprocity**. RBI Oct-2023 circular: any FIU that holds
  financial information must also offer FIP. Anvil holds invoices
  but is not an FIU; reciprocity applies to the partner FIU, not
  Anvil. Confirm in legal review.
- **Pricing pass-through**. If we charge tenants for AA consents
  (Rs 20-30 per fetch from Finvu) + tenant-tier markup, we need a
  billing line. Watch margin once volume hits 1000s of consents/
  month.
- **Customer-portal SPA**. No dedicated `customer-portal.tsx` in
  the branch - portal is server-rendered. Visible UI changes touch
  the portal payload + the SPA shell, not a dedicated screen file.

---

## 8. Effort estimate

| Track | Code days | External / lead-time |
|---|---:|---|
| AA module (consent + fetch + webhooks) | 8 | + 6-8 wk FIU partnership + Sahamati certification |
| TReDS module (M1xchange) | 7 | + 4-6 wk M1xchange channel-partner onboarding |
| RXIL adapter (phase 2) | 4 | + 4 wk |
| Migration `097_aa_treds.sql` + RLS | 1 | - |
| Operator UI (settings, invoice slideover, `treds.tsx`) | 6 | - |
| Dunning + portal integration | 3 | - |
| Tests (unit + e2e against sandbox) | 5 | - |
| Privacy / DPDP review + audit-events sweep | 2 | + 2 wk legal |
| **Total** | **~36 dev days (single eng)** | **~10-12 calendar weeks gated on partner onboarding** |

Practical: kick off M1xchange + AA-via-FIU-partner conversations on
day 1; build sandbox + DB layer in parallel; production rollout
10-12 weeks out.

---

## 9. Sources cited

- [Sahamati - FIU eligibility](https://sahamati.org.in/financial-information-user-fiu/)
- [Sahamati - join the AA network](https://sahamati.org.in/how-to-join-the-account-aggregator-network-to-share-and-access-financial-data/)
- [Sahamati - active AA list](https://sahamati.org.in/account-aggregators/)
- [Sahamati - FIP/FIU/TSP roles](https://sahamati.org.in/tsp/fip-fiu-tsp/)
- [AA H1 FY26 ~Rs 1.47 lakh cr loans (Sahamati / News Patrolling)](https://newspatrolling.com/account-aggregator-ecosystem-facilitates-monthly-loan-disbursements-of-%E2%82%B924000-crore-in-h1fy26/)
- [SMEStreet - AA H1 FY26 Rs 1.47 lakh cr](https://smestreet.in/banking/finance/account-aggregator-lending-reaches-147-lakh-crore-in-h1-fy26-11074801)
- [Sahamati - DPDP impact on AA](https://sahamati.org.in/impact-of-dpdp-act-2023-on-aa-ecosystem/)
- [Live AA + FIP coverage state (CASParser, May 2026)](https://casparser.in/blog/state-of-account-aggregator-2026/)
- [HyperVerge - best AAs](https://hyperverge.co/blog/best-account-aggregators/)
- [Setu AA gateway](https://setu.co/data/financial-data-apis/account-aggregator/)
- [Setu Embed AA docs](https://docs.setu.co/data/account-aggregator/embed-setu-aa)
- [Setu multi-AA gateway docs](https://docs.setu.co/data/account-aggregator/multi-aa-gateway)
- [Finvu pricing reference](https://finanjo.com/account-aggregator/finvu-account-aggregator)
- [M1xchange Rs 1 lakh cr in 10 months FY26](https://www.m1xchange.com/m1xchange-crosses-rs-1-lakh-crore-annual-throughput-in-10-months/)
- [M1xchange CEO on TReDS budget reforms](https://www.m1xchange.com/treds-related-budget-announcements-to-give-major-boost-to-volumes-m1xchange-ceo-says/)
- [RXIL official site](https://www.rxil.in/)
- [RXIL union-budget 2026 commentary](https://www.rxil.in/union-budget-2026-strengthening-msmes-through-equity-capital-and-treds-reform/)
- [Invoicemart](https://www.invoicemart.com/)
- [Karbon Card - TReDS platforms compared](https://www.karboncard.com/blog/treds-platforms-in-india-compared-rxil-m1xchange)
- [Union Budget 2026-27 TReDS reforms](https://redfortcapital.com/treds-2026-27-big-push-budget-reforms-msme-credit-securitisation/)
- [DPDP Act consent definition (DPO India)](https://www.dpo-india.com/Blogs/consent-management-india-dpdp-act/)
- [Tsaaro - Consent Manager obligations under DPDP](https://tsaaro.com/blogs/consent-managers-under-the-dpdp-act-and-dpdp-rules-2025-functions-obligations-and-governance)
- Codebase: `src/api/_lib/razorpay-client.js`, `src/api/agents/_handlers/ar_collect.js`, `src/api/portal/pay.js`, `src/api/portal/view.js`, `src/api/_lib/pay-link.js`, `src/api/_lib/audit.js`, `supabase/migrations/020_razorpay.sql`, `supabase/migrations/022_customer_portal.sql`.
