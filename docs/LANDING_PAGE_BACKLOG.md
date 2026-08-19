# Landing page — audit and backlog

**Audited** 2026-08-19 against `main`, the live page at `https://anvil-flame.vercel.app/#/connect`
(`/` and `#/connect` render the same screen), and the codebase.
**Source** `src/v3-app/screens/landing.tsx` (1,588 lines).

Stated intent for the page, from the owner:

> show that Anvil helps reduce sales admin tasks and more efficiency and automation using AI and
> AI agentic automation to speed things up — and not to be another ERP or CRM.

Everything below was verified by opening the file or running the live page. Claims that turned out
to be **fine** are recorded too, so nobody re-litigates them.

---

## 0. The one-line problem

The page is selling ERP middleware. The word **ERP appears 49 times** and **connector 26 times**;
**agent appears 5 times**, **autonomous once**, and the phrase **"sales admin" zero times**. The
headline is literally *"Your customer wrote X. **Your ERP wants** Y."*, and the first `<h2>` after
the hero is *"Already speaks your stack"* — a 40-logo scrolling marquee. A prospect's first
impression is an integration layer for ERPs, which is the exact reading the owner wants to avoid.

---

## 1. Must fix before a prospect sees it

### 1.1 — Every "Book a demo" points at a domain we may not own · **BLOCKER · verify today**

Five CTAs are `mailto:hello@anvil.app` (`landing.tsx:742, 785, 1461, 1517`, plus
`mailto:hello@anvil.app` in the connectors copy at `:1501`). The product is deployed at
`anvil-flame.vercel.app`, and **no `anvil.app` domain is configured anywhere in the repo** —
`vercel.json` has no alias or domain block, and the only other `anvil.app` references are aspirational
strings in `docs/`.

If `anvil.app` is not ours, every inbound demand-gen email is delivered to a third party or bounces.
This is not a code fix — **confirm domain ownership first**, then either point the CTAs at a real
inbox or replace them (see 1.2).

> A prior audit already flagged the mailto pattern:
> `docs/audits/2026_05_11_product_deep_dive/01-landing-onboarding.md:55`.

### 1.2 — A mailto is not lead capture · **HIGH**

Even on a domain we own, `mailto:` opens the visitor's mail client. Visitors on a machine with no
mail client configured get nothing at all, and we get no record: no lead row, no CRM, no timestamp,
no source attribution. There is no demo-booking system of any kind in the repo.

**Do:** a real form posting to an endpoint that writes a row, plus an autoresponder. Do not route it
through the internal comms rail until that rail is fixed — queued communications currently drain
only from an unscheduled cron.

### 1.3 — "GDPR / DPDP — COMPLIANT" · **HIGH legal risk**

A self-asserted COMPLIANT badge with no supporting machinery. Verified absent: no DPA, no
data-processing agreement text, no subject-access-request path, no right-to-erasure endpoint, no
published retention policy, no sub-processor list.

**Replace with:** `GDPR / DPDP — DPA available on request` (once one exists), or drop the badge.

### 1.4 — "SOC 2 Type II — IN PROGRESS" and "ISO 27001 — IN PROGRESS" · **HIGH legal risk**

"In progress" states to a buyer that an auditor is engaged and a Type II observation window is
running. What exists is `SECURITY.md` and an internal `SECURITY_AUDIT_2026_05.md` — real work, but
an internal audit, not a certification engagement. The compliance programme is a *backlog item*.

**Replace with:** `SOC 2 Type II — planned` / `Controls mapped, audit not yet engaged`, or move both
to a roadmap line. Buyers forgive "not yet"; they do not forgive discovering "in progress" meant
"intended".

### 1.5 — "Data residency — IN · EU · US" · **HIGH**

No region configuration exists — nothing in `vercel.json`, nothing in the Supabase config, no
region-routing code. This is one deployment in one region.

**Replace with:** state the actual region, and offer residency as a roadmap item for enterprise.

### 1.6 — "Cryptographically chained via the audit-events table" · **MEDIUM, overstated**

`audit_events` carries a per-row `payload_hash` (`001_init.sql:333`) and is genuinely append-only —
migration `058_audit_events_append_only.sql` drops the four mutation-permitting policies so UPDATE
and DELETE are forbidden at the database layer for anyone holding a tenant JWT. Exports are
HMAC-signed. **There is no `prev_hash`**, so rows are not chained to each other.

**Replace with:** *"Append-only at the database layer, HMAC-signed on export, NDJSON-replayable."*
That is both true and stronger-sounding than the current wording, because it names the mechanism.

### 1.7 — "18 ERPs" in the hero, "17" everywhere else · **LOW, but it is in the first paragraph**

`landing.tsx` hero prose says 18; the stat bar and connector section say 17. Pick one.

---

## 2. Verified as TRUE — do not "fix" these

- **Passkeys are real.** Four server endpoints exist and are routed:
  `auth/passkey/register_begin|register_finish|auth_begin|auth_finish` (`router.js:73-76`, `:892-893`).
  TOTP/MFA is real too (`src/api/_lib/totp.js`, `src/api/auth/mfa.js`).
- **Pricing is on the page** — ₹14,990 / ₹49,990 / from ₹99,990 per month (`landing.tsx:370-396`).
- **Self-serve signup exists** — `src/api/auth/signup.js`, routed at `/auth/signup`, with a
  "Create your account" mode in `signin.tsx`.
- **The 17 ERP client files are real code**, 77–218 lines each, each making actual HTTP calls — not
  empty stubs. See §3.1 for the honest caveat.
- **Mobile layout does not break.** Measured at 375px: `document.scrollWidth === 375`, no horizontal
  page scroll. The 40-logo marquee is correctly contained.

---

## 3. Overstated rather than false

### 3.1 — "CURRENTLY SHIPPING INTEGRATIONS · 17 ERPS"

Seventeen `*-client.js` adapters exist with real fetch calls. But only **Tally** has supporting
infrastructure — `tally-build-voucher.js`, `tally-enqueue.js`, `tally-reconciler.js`,
`tally-voucher-type.js` — and only Tally has a live customer. The other sixteen are credible
adapter shells that have most likely never run against a live tenant instance.

"Currently shipping" implies production traffic. **Suggest:** *"Tally Prime in production. Sixteen
more adapters built and ready to certify against your instance."* That is honest, and for a
prospect on Tally it is a stronger claim than a wall of logos.

### 3.2 — The DocAI engine list is out of date

The page lists Reducto, Azure DI, Unstructured, Mistral OCR, Claude. The pipeline's actual
`DEFAULT_PROVIDER_ORDER` is `gemini, docling, marker, unstructured, azure_di, reducto, claude` —
**Gemini is the primary adapter and is missing from the page**, while docling and marker are absent
too. Update the list to match the code.

### 3.3 — "A sales engineer spends 22 minutes on every PO"

No measurement behind this number anywhere in the repo, and — more importantly — **the page never
states the after-number.** A before-figure with no after-figure is the one statistic a prospect
cannot act on. Anvil's own console mock shows `ELAPSED 8m 03s`, which undersells: that is the
pipeline's own elapsed time, not the human's.

**Do:** instrument it. `cycle_time` already exists in the live ops KPIs, and the governed metric
catalog (`src/api/_lib/metrics/catalog.js`) is the honest place to source a real number with
provenance. Until then, label it as an estimate.

---

## 4. Page health — two live defects

### 4.1 — The intended typography loads for nobody · **MEDIUM**

`src/v3-app/styles.css:9` does
`@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans...")`, and the app's own CSP
(`vercel.json:29`) is `style-src 'self' 'unsafe-inline' https://rsms.me`. The browser blocks it —
confirmed live in the console. There is no local `@font-face` for IBM Plex, and `index.html` only
preloads **Inter** from rsms.me. Every visitor without IBM Plex already installed sees the whole app
in a fallback font, including the serif in the hero.

This is the same trap as the "no CDN scripts" rule, in stylesheet form.

**Fix:** self-host the three IBM Plex families (`@fontsource/ibm-plex-*`) and `@font-face` them from
`'self'`. Prefer this over widening the CSP — a page claiming GDPR compliance should not be shipping
every visitor's IP to Google Fonts.

### 4.2 — The public marketing page polls authenticated APIs forever · **MEDIUM**

Measured on the live page: `/api/audit?limit=50`, `/api/orders?limit=200`, `/api/fx/rates` and
`/api/health` are called **every 30 seconds indefinitely** (7 rounds over 238s, 30,021 ms interval).
The first three return **401** for an anonymous visitor.

A prospect who leaves the tab open for ten minutes generates ~80 serverless invocations, ~60 of them
401s. It costs money, it fills the logs with auth failures that mask real ones, and
`GET /api/orders?limit=200` firing from a marketing page looks careless to anyone who opens
devtools. **Gate the poller on an authenticated session.**

---

## 5. The positioning rewrite

### What is wrong

| signal | count in `landing.tsx` |
|---|---|
| "ERP" | 49 |
| "connector" | 26 |
| "agent" | 5 |
| "autonomous" | 1 |
| "sales admin" | **0** |

The hero eyebrow is `QUOTE-TO-CASH · INDUSTRIAL DISTRIBUTORS`; the subhead calls Anvil an *"AI-native
quote-to-cash console"*. **"Console" and "quote-to-cash" are category words that place Anvil inside
the ERP/CRM aisle rather than beside it.** The headline's second line is *"Your ERP wants
MTR-37-IE3-B3-4P"* — the page's single most prominent sentence contains the word we are trying not
to be.

### What to do

1. **Cut the ERP marquee from above the fold.** Move "Already speaks your stack" below the
   how-it-works section. It is a *reassurance*, not a *proposition* — it answers "will this fit?",
   which is question three, not question one. A 40-logo wall in position two says "we are middleware".
2. **Lead with the work removed, not the systems touched.** The proposition is hours of sales-admin
   deleted; the ERP list is the footnote that makes it safe.
3. **Name the agents.** The repo has real autonomous machinery — cron-driven monitors, an auto-send
   reaper, the anomaly engine, the copilot with a governed metric catalog. The page mentions "agent"
   five times and describes a *pipeline a human drives*. Here the page **undersells** what is built.
4. **Keep the operator gate as a selling point.** Stage 05 ("Drafts only. A human presses ↵") is
   exactly right for this buyer and should stay prominent — autonomy that cannot be overruled is a
   fear, not a feature.

### Proposed hero — finished copy, not a description

> **eyebrow** — SALES-ADMIN AUTOMATION · MANUFACTURERS & INDUSTRIAL DISTRIBUTORS
>
> **headline** — Your sales engineer spends 22 minutes keying in every PO.
> **Anvil gives that back.**
>
> **subhead** — Anvil reads the purchase order, matches every line to your catalogue, checks it
> against the quote you actually sent, flags the price that is 10× the last twelve invoices, and
> drafts the sales order. Your engineer approves it. Nothing posts without them.
>
> **support line** — Not an ERP. Not a CRM. It works on top of the ones you already run.

That last line does the job the owner asked for, explicitly, in the place a prospect actually reads.

---

## 6. The missing story

**Forecast-driven procurement is absent from the page.** "forecast" appears three times: once inside
a nav-label list, once as a fake inbox subject in the console mock, and nowhere as a proposition.

Per the internal competitive review, this — opportunities → probabilistic demand → BOM-exploded
raw-material preorder → freight bidding — is the one thing on the roadmap that **no ERP or CRM
vendor can say**, and it is the answer to "what is uniquely Anvil?".

Right now, re-read the page and ask which sentence a Zoho or SAP rep could not also say. There isn't
one. That is the finding.

---

## 7. Ordered work

| # | item | size | kind | notes |
|---|---|---|---|---|
| 1 | Confirm `anvil.app` ownership; fix or replace all 5 mailto CTAs | small | **decision** | blocks everything else in demand-gen |
| 2 | Remove or requalify SOC 2 / ISO / GDPR / residency badges | small | copy | legal exposure; do this first among the code-free items |
| 3 | Fix "cryptographically chained" and the 17-vs-18 mismatch | small | copy | |
| 4 | Gate the 30s poller behind an authed session | small | code | live cost + log noise |
| 5 | Self-host IBM Plex; drop the CSP-blocked Google Fonts import | small | code | affects the whole app, not just landing |
| 6 | Replace the mailto with a real lead-capture form + autoresponder | medium | code | needs a working outbound path |
| 7 | Rewrite the hero and demote the ERP marquee below the fold | medium | copy | the actual positioning fix |
| 8 | Update the DocAI engine list (add Gemini) and requalify "17 ERPs shipping" | small | copy | |
| 9 | Instrument a real before/after time saving from the metric catalog | medium | code | replaces the unsourced 22 minutes |
| 10 | Write the forecast-driven-procurement section | medium | copy | needs an owner decision on how much roadmap to show |

---

*Not covered here: SEO/meta tags, `og:image`, analytics, and A/B infrastructure were out of scope
for this pass.*
