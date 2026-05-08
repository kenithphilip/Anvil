# Pricing Strategy

> Status: approved May 2026. This is the pricing model the marketing
> page lands and the sales team quotes from. Revisit quarterly or
> after every 5 paid pilots, whichever comes first.

---

## TL;DR

Three-tier subscription with included sales-order volume + tiered
overage pricing, plus add-ons priced at marginal-cost-plus.

| Tier        | Monthly base | Included SOs / month | Overage / SO | Best fit                                   |
|-------------|--------------|----------------------|--------------|--------------------------------------------|
| Starter     | ₹14,990      |     200              | ₹39          | 1 location, < 200 SOs / month              |
| Growth      | ₹49,990      |   1,000              | ₹19          | 2-5 locations, 500-2000 SOs / month        |
| Enterprise  | ₹99,990+     |   5,000              | ₹9           | 5+ locations, 2000+ SOs / month, BAA req'd |

USD equivalents (rough, no currency arbitrage in pricing): Starter
$179, Growth $599, Enterprise $1,199+. Local-currency invoicing via
the existing Stripe + Razorpay paths.

Add-ons billed monthly:

- **WhatsApp send**: ₹0.50 per outbound message (Twilio passthrough +
  20% margin).
- **Voice AI minutes**: ₹15 / minute inbound, ₹25 / minute outbound
  (Vapi or Retell passthrough + 30% margin; outbound carries the
  TRAI + TCPA compliance overhead).
- **e-Way bill submissions**: NIC API passthrough at cost (₹2 / bill),
  no markup. This is a regulatory cost, not a profit line.
- **BYO LLM key**: -10% off the base tier when the customer brings
  their own Anthropic key. Encourages customers with internal AI
  governance to land without renegotiating the LLM line item.

---

## How we got here

### The unit economics

The cost per processed SO, computed from real production data:

- LLM tokens (Claude tool-use + Mistral OCR + Voyage embeddings):
  ~₹2.40 / SO at typical 18-line POs.
- Storage + Supabase + Vercel marginal cost: ~₹0.30 / SO.
- Email + WhatsApp + voice are billed separately (see add-ons).

**Marginal cost per SO ~ ₹2.70.**

The Starter overage at ₹39 / SO is a 14x markup; Growth at ₹19 is
7x; Enterprise at ₹9 is 3.3x. The compression is intentional: at
Enterprise volumes the customer is doing the integration work
themselves and the marginal-margin contribution reflects that.

### The value-creation per SO

A typical Indian industrial-distribution operator processes a PO
in roughly 9 minutes (the audit doc's own measurement, calibrated
against three pilot accounts). Operator fully-loaded cost is
~₹500 / hour (₹40k / month + benefits). 9 minutes saved is **₹75
of operator time per SO**.

Anvil captures 12-50% of that value at the per-SO price points
above. The reason this isn't 70%+ is that the operator still has
to approve the order (the platform is an assistant, not a
replacement) and the value to the customer is also in the lower
error rate and the audit trail, both of which are hard to price
per SO.

### Why three tiers, not five

Pricing complexity is a friction tax on the buyer. Three tiers is
the most common shape in B2B SaaS for a reason: it gives the
buyer one easy and one stretch option. Five-tier ladders signal
"we'll design the price for you in a 90-day procurement," which
delays the deal.

### Why include SOs in the base, not pure usage

Two reasons:

1. **Predictability for the buyer**. Indian SMBs will not approve
   an unbounded usage line item. A monthly ceiling with a known
   overage rate is the only way the CFO signs.
2. **Predictability for us**. Customer-CAC payback math depends
   on knowing the ARR per pilot to within a 20% band. Pure
   usage-based pricing on a 3-month SO-volume seasonal cycle
   makes ARR forecasting a lottery.

### Why add-ons are billed marginal-cost-plus

WhatsApp, voice minutes, and e-Way bill submissions are real
external API costs. Marking them up too aggressively gets the
customer's procurement to second-guess the whole subscription.
Marking them up too little leaves money on the table when a
customer scales 10x. Twilio / Vapi pass-through at 20-30% margin
is the standard B2B SaaS pattern (Twilio is itself reselling AWS
+ telco at 30%+).

### What about competitors

- **Salesforce Revenue Cloud / CPQ**: ~$75 / user / month + bolt-ons.
  Designed for inside-sales orgs at large enterprises. Anvil is a
  10x better fit for distributors who never adopted Salesforce in
  the first place; the pricing comparison is rarely apples-to-apples.
- **DealHub / PandaDoc / Conga CPQ**: $50-150 / user / month.
  Same buyer profile as Salesforce. Doesn't include the OCR /
  ERP bridge work Anvil does.
- **Tally / Busy / Marg**: ₹500-2,000 / user / month for the
  accounting platform itself. They are *adjacent* to us, not
  competitors; Anvil sits on top and pushes vouchers in.
- **Vendor-specific portals (NetSuite, SAP, etc.)**: free with
  the ERP, but require the customer to already own the ERP. Many
  Anvil targets are ERP-curious distributors who stayed on Tally
  because the SAP migration is a multi-quarter project.

The closest competitive surface is **internal back-office automation
teams** at the customer (one engineer maintaining a custom
Excel-to-Tally bridge). Those cost the customer ~₹1.2 lakh / month
loaded. Anvil at Growth tier is ~₹50k / month and replaces 80% of
that headcount's quote-to-cash work.

### Why per-seat is not the unit of pricing

Distributor sales teams are typically 4-12 people, but only 1-2
people are the heavy quote-to-cash operators. Charging per seat
either over-prices the small team or undervalues the heavy
operator. Per-SO scales with the actual volume of work the
platform automates.

### What the customer gets at each tier

#### Starter (₹14,990 / month)

- 200 SOs / month included, ₹39 / SO overage.
- 1 location / 1 GSTIN.
- Up to 5 operator users + unlimited approvers.
- All core extraction + anomaly detection + audit log + Tally
  bridge.
- Email + 1 chat channel (WhatsApp via the customer's number).
- Standard SLA: 99.0% uptime, 1 business-day support.

Best fit: a single-shop distributor moving from spreadsheet +
email to a real platform.

#### Growth (₹49,990 / month)

Everything in Starter plus:

- 1,000 SOs / month included, ₹19 / SO overage.
- Up to 5 locations / multi-GSTIN.
- Up to 20 operator users.
- Multi-ERP push (Tally + 1 of: NetSuite, SAP, D365, Acumatica,
  Prophet 21, IFS, Oracle Fusion, Ramco, etc.).
- Full channel set (email + WhatsApp + Slack + Teams).
- Anomaly engine + duplicate detection + customer health score.
- Custom approval thresholds + multi-tier sign-off.
- 99.5% uptime SLA, 4-hour support response, named CSM at 250+
  SOs / month run rate.

Best fit: regional distributor with 2-5 locations and a small
ops team.

#### Enterprise (₹99,990+ / month, custom)

Everything in Growth plus:

- 5,000 SOs / month included, ₹9 / SO overage (negotiable).
- Unlimited locations + GSTINs.
- Unlimited operator users.
- All ERP pushes (17 connectors).
- Voice AI (inbound + outbound) at the add-on rate.
- BYO LLM key (-10% off base when used).
- Dedicated tenant pod (private Supabase region, optional).
- SOC 2 + ISO 27001 evidence package + signed BAA / DPA.
- 99.9% uptime SLA, 1-hour support response, dedicated CSM,
  quarterly executive business review.

Best fit: multi-state distributor or one whose compliance team
requires a BAA.

---

## Things we explicitly do not price for

- **Pilot setup / onboarding**: zero charge for the first 30
  days. Customers run at most 200 SOs through the platform and
  decide. We have not yet had a pilot that decided to pull out
  after a 30-day window; the conversion math says we earn this
  back inside the first 60 days of a subscription.
- **Custom ERP connectors**: out of scope, not for sale. If a
  customer asks for a custom adapter, that is a partnership
  conversation, not a pricing-page line item.
- **Vertical packs**: included in the base tier when they
  exist. The Industrial Pumps + Bearings + HVAC + MRO + Machine
  Tools + Process Instrumentation packs ship as configuration,
  not separately licensed code.
- **Data migration**: included in onboarding. Customers walk
  away from competitors when they get nickel-and-dimed for
  master-data import.

---

## Roll-out plan for the marketing page

1. Land the three-tier card grid on `landing.tsx` below the
   pillars block. Each card shows the included-SO ceiling, the
   per-SO overage rate, and the headline differentiator.
2. Add an FAQ block that answers the seven hard questions
   buyers ask: "what if I exceed the SO ceiling," "what
   counts as an SO," "what's not included," "do you offer a
   trial," "how does the BYO-LLM-key discount work," "can I
   cancel," "what's the refund policy."
3. Land an `/api/billing/quote` admin endpoint that takes
   (tier, expected_volume, ERPs, addons) and returns the
   monthly total. Sales engineers call this from the
   subscription drawer in admin.tsx. Phase 7 work, not a
   landing-page change.
4. Stripe + Razorpay product catalogue: create three
   recurring SKUs per tier (USD + INR + AED) with overage
   metering. The metered-overage line items wire to the
   existing usage-meter cron worker.

---

## Review cadence

- **Quarterly**: are pilots clustering at the Starter ceiling
  (200 SOs)? If yes, raise to 250 and re-test conversion.
- **After every 5 paid pilots**: did we leave money on the
  table at Growth? If 60%+ of Growth customers exceed 1,500
  SOs, raise the included volume and the base.
- **Annually**: are LLM token costs trending down? Anthropic
  + Mistral price reductions of 30-50% per generation are
  typical. Pass half of any cost reduction to the customer
  to keep the win-rate up; keep half as margin.
