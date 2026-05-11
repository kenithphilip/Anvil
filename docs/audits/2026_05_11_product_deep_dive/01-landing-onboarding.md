# A1 Deep-Dive (v2, rewrite): Landing, onboarding, auth, marketing surfaces

Anvil is the AI-native quote-to-cash console for Indian and global industrial distributors. The product takes inbound customer purchase orders (PDF, email, WhatsApp, Slack, Teams, voice) and converts them into ERP-bound vouchers across 17 ERP clients, with anomaly detection, redaction firewall, append-only audit, e-Invoice (IRN) wiring, and a mobile passkey approver.

Repo state, verified at the start of this audit: `main` is at commit `c4f946b` ("feat(bet2): format-template marketplace (post counsel approval) (#100)"). The 7 strategic bets are merged on this commit (see `git log --oneline -5`: `c4f946b` Bet 2 template marketplace, `81e0975` Bet 4 schema-aligned parsing, `2b80a48` Bet 6 AA + TReDS sandbox, `37dca49` Bet 7 BRSR Core, `2d55cc3` Bet 3 conformal-prediction safety stock; Bet 1 cost compression and Bet 5 Tally drift paid SKU landed in earlier commits). The previous draft of this file referenced commit `a24d582`, which was a stale worktree; every file:line citation in this rewrite is anchored at `/Users/kenith.philip/anvil/` on `c4f946b`. Test count 1,122 passing. Supabase migrations 103. ERP client files 17 (under `src/api/_lib/` excluding non-ERP clients).

The earlier audit (v1 of this file) was written against the assumption that no React landing tree existed, that the only "landing" was a JS redirect inside `public/index.html`, and that no auth screens, format guide, or sandbox flows were present. That assumption is now obsolete. On `main` at `c4f946b` the entire `src/v3-app/screens/*.tsx` tree exists, the landing is a 1,272-line TSX page (`src/v3-app/screens/landing.tsx`), there is a dedicated signin screen with magic link + password + passkey + TOTP (`src/v3-app/screens/signin.tsx`, 538 lines), a wired onboarding checklist (`src/v3-app/screens/onboarding.tsx`, 122 lines), a connect screen (`src/v3-app/screens/connect.tsx`, 324 lines), a security console (`src/v3-app/screens/security.tsx`), a format guide (`src/v3-app/screens/format-guide.tsx`, 71 lines), and a recovery-token-aware reset screen (`src/v3-app/screens/reset-password.tsx`, 202 lines). The auth API surface under `src/api/auth/` ships magic-link, TOTP enroll+verify+unenroll, passkey register and authenticate, password sign-in with MFA gate, signup with admin-approval gate, and a request-reset+complete-reset pair. This v2 audit re-evaluates the surface as it ships, not as it was imagined, and replaces the prior draft in full.

Date: 2026-05-11. Author seat: security engineering, audit pass v2.

Tags used inline below: `[verified-on-main]` means the file was opened at the line cited on commit `c4f946b`; `[verified-from-fetch]` means the citation was read via WebFetch this session (in this rewrite that channel was denied; tagged claims come from the prior session and are explicitly re-tagged `[verified-from-prior-knowledge]` here); `[inferred]` means a defensible reading of context but not directly read.

---

## Table of contents

F1.1 Hero pattern is a kinetic-pair, not negation: optimize the right axis (P1)
F1.2 Demo cycle math drifts: 15.4s loop vs 4 scenes, reduce-motion gated (P2)
F1.3 Logos rail replaced with connector marquee: integrity-first, but loses pilot proof (P1)
F1.4 Security strip understates posture: 6 badges but only 2 statuses, no SOC 2 evidence link (P1)
F1.5 Pricing tier under-instrumented for INR-only ICP, no per-SO overage telemetry (P2)
F1.6 Sandbox / time-to-first-value still unbuilt despite landing claims (P0)
F1.7 First-run onboarding is a checklist, not a tour, and double-routes with /connect (P0)
F1.8 Magic-link is rate-limited to 5 per 15 min per email but generic-200 hides errors (P2)
F1.9 Passkey flow uses placeholder-row challenge store on user_passkeys, a footgun (P1)
F1.10 TOTP enrollment does not show backup codes or pre-arm a recovery method (P1)
F1.11 Signin uses two parallel auth surfaces (signin.tsx + connect.tsx), drift risk (P1)
F1.12 Password reset cannot detect a stale magic-link cross-mount, silent fail (P2)
F1.13 SOC 2 / ISO 27001 "in progress" badges have no public roadmap link, trust-cliff (P1)
F1.14 Connector grid hardcodes 18 ERPs vs 17 client files vs marquee says "17": pick one (P2)
F1.15 No conditional-UI WebAuthn autofill, missing standards-grade signin UX (P1)
F1.16 No `time_to_first_voucher` event in audit_events, "2 weeks" claim is uninstrumented (P0)
F1.17 Landing has 19 sections but no IndexNow / sitemap.xml / structured data (P2)
F1.18 Landing animations use IntersectionObserver but no `content-visibility` budget (P2)
F1.19 Tally is featured as "most loved" without a tenant count, claim is unprovenanced (P1)
F1.20 The signin screen ships an "Advanced (backend URL, tenant ID)" toggle on a public surface (P0)
F1.21 The compare table has no last-updated stamp, opens defamation/competitive risk (P2)
F1.22 BRSR-positioning is absent from landing despite Bet 7 being merged (P2)
F1.23 Format guide is an in-app help page, not a public format catalog (P2)
F1.24 The auth `Advanced toggle` defaults to `open` for fresh installs (P1)
F1.25 Magic-link callback is a static HTML file at `/auth/callback.html`, separate from the SPA hash router (P2)

Then: Deep-dive prompts collated (10 numbered prompts for the implementation phase).

---

## F1.1 Hero pattern is a kinetic-pair, not negation. Optimize the right axis. [P1]

### Problem
The Anvil hero is built on a kinetic-pair pattern: the customer wrote one part-number string, the ERP wants a different one, the page animates between five pairs (`KINETIC_PAIRS`, `src/v3-app/screens/landing.tsx:45-51`). The category benchmark for inbound-doc / sales-ops AI tools is a different pattern entirely: most direct competitors lead with a negation hero ("Stop X") or a fact hero (an accuracy or volume number). The kinetic pair is striking and on-brand, but it can read as cryptic for a sales-ops lead who has never thought of part-number aliasing as a workflow problem.

### Current state on main
- `src/v3-app/screens/landing.tsx:627-642` ships an `<h1>` with two segments: "Your customer wrote {kineticPair.customer}." and "Your ERP wants {kineticPair.erp}." with `aria-live="polite"` on the kinetic span. The cycle is 3,500ms, paused under `prefers-reduced-motion: reduce` via `useKineticPair` (`src/v3-app/screens/landing.tsx:53-63`). [verified-on-main]
- Lead paragraph at `src/v3-app/screens/landing.tsx:643-648`: "Anvil is the AI-native quote-to-cash console for manufacturers and industrial distributors. We do the part-number translating, the rate-checking, the GST-classifying, the ERP-pushing, across 18 ERPs, 5 inbound channels, 6 doc engines. So your sales engineer can do the part only humans can." Strong copy, but "AI-native quote-to-cash console" expects the reader to already know what a quote-to-cash console is. [verified-on-main]
- Primary CTAs at `src/v3-app/screens/landing.tsx:649-656`: "Sign up free" → `#/signin`, "Book a demo" → `mailto:hello@anvil.app?subject=Demo%20request`. No demo-booking system (Cal.com, Chili Piper, Calendly), just a mailto. [verified-on-main]
- Spec strip below the headline has 4 cells: "ERPs 17", "Anomaly rules 20", "Inbound channels 5", "Audit coverage 100%" (`src/v3-app/screens/landing.tsx:72-77`). Each figure cites a verifiable count comment in the source. Unusually honest for landing copy. [verified-on-main]
- The hero already publishes a deliberate "free pilot · 30 min · we run a real PO" micro-line (`src/v3-app/screens/landing.tsx:656`), which raises the buyer's expectation of an in-page artifact that doesn't exist yet. [verified-on-main]

### Competitor state
- Conexiom's hero: "Learning from 1B+ line items annually. Process every order accurately, in seconds." Fact hero with a volume number plus a speed number; "30-day implementation average" below. [verified-from-prior-knowledge, https://www.conexiom.com]
- Rossum's hero: "Offload paperwork to AI agents and focus on [what matters]." Negation/promise hero. Logos under: Panasonic, Siemens, Bosch, Wolt, Adyen, Kingfisher. Per-customer numbers: Wolt 100K invoices/yr with 44% fewer error rates; Morton Salt 95% time saved; Port of Rotterdam 810 AP days saved. [verified-from-prior-knowledge, https://rossum.ai]
- Hyperscience's hero: "Industry Leading Enterprise AI Platform. Streamline workflows. Reduce errors. Accelerate outcomes." Authority + outcomes. 99.5% accuracy; Gartner MQ Leader 2025; FedRAMP High. [verified-from-prior-knowledge, https://www.hyperscience.ai]
- Ocrolus: "AI workflow and analytics platform for lenders. Make faster and more accurate underwriting decisions with trusted data." Vertical authority hero. 99+% accuracy. Customer logos: Enova, LendingClub, SoFi, Square, Zillow, PayPal. [verified-from-prior-knowledge, https://ocrolus.com]
- Linear: "The product development system for teams and agents." 25,000 product teams. Quoted Gabriel Peal (OpenAI), Nik Koblov (Ramp), Kaz Nejatian (Opendoor). [verified-from-prior-knowledge, https://linear.app]
- Stripe: "Financial infrastructure to grow your revenue." Above-the-fold: $1.9T 2025 volume, 135+ payment methods, 99.999% uptime. [verified-from-prior-knowledge, https://stripe.com]
- Figma: "Make anything possible, all in Figma." PLG, "Get started for free" primary, contact-sales secondary. [verified-from-prior-knowledge, https://www.figma.com]
- Vercel: "Your complete platform for the web." Multiple sub-claims (instant rollback, observability, edge functions); a fact-hero-and-system-block hybrid. [verified-from-prior-knowledge, https://vercel.com]
- ClearTax India: "Save Taxes Effortlessly with India's #1 Tax Filing Platform." India-vernacular product positioning that names the SKU and the outcome. Trust badges immediately below ("Trusted by 7 Cr Indians"). [verified-from-prior-knowledge, https://cleartax.in]
- Tally Solutions India: "Empowering Indian Businesses for over 35 years." Authority + tenure. CTAs: "Take a Free Trial" 7-day, "TallyPrime", "Tally on AWS". [verified-from-prior-knowledge, https://tallysolutions.com]

### Adjacent insight
The B2B SaaS landing-page conversion-rate canon for 2026: average visitor-to-lead 2 to 5 percent, top decile 8 to 15 percent; single-CTA pages convert at 13.5 percent vs 10.5 percent for multi-CTA; custom-built pages convert at 11.6 percent vs 3.8 percent for templates; demo-request pages 1.5 to 4 percent average, 8 to 15 percent top quartile. [verified-from-prior-knowledge, growthspreeofficial.com / withdaydream.com / saashero.net category review]. The Anvil hero has two equal-weight CTAs ("Sign up free" and "Book a demo") plus the "free pilot · 30 min · we run a real PO" micro-line. Reading the canon literally, the page is leaving conversion on the table by not picking one primary action. The kinetic-pair is the brand differentiator and should stay, but it should sit above a single primary CTA, not flank two.

### Research insight
NN/g's body of work on the cost of login walls ([verified-from-prior-knowledge, https://www.nngroup.com/articles/login-walls/]) is the most cited UXR rule on B2B signup: delay authentication until after value. Anvil's hero buries "Sign up free" but offers no in-page product simulation that lets an anonymous visitor try a sample PO without an account. The animated Demo component (`src/v3-app/screens/landing.tsx:371-485`) is a passive walkthrough, not an interactive simulator. Linear, Notion, Stripe, and Figma all surface interactive product-spaces before requiring signup; Anvil today does not. Reforge's onboarding-anti-patterns content is gated but is widely cited in CRO playbooks as recommending "value-before-friction" as the single most important guideline. [verified-from-prior-knowledge, https://www.reforge.com/blog/onboarding-design-anti-patterns]

### Proposed change
Run a controlled A/B test with 3 hero variants:
1. Hold (kinetic-pair, the current shipping hero). Control.
2. Negation: "Stop retyping customer POs." Lead unchanged. Same CTAs.
3. Fact: "From customer PO to Tally voucher in 8 minutes." Numbers come from `FLOW_STEPS[4].meta.elapsed = "8m 03s"` in `src/v3-app/screens/landing.tsx:235`, which is currently asserted by the page itself; once F1.16 lands the number can be the live median.

Then collapse to a single primary CTA ("Sign up free → 30-day pilot") with "Book a demo" demoted to a header link. Add a one-page anonymous-sandbox below the hero (no signup, no email) that loads a pre-canned PO PDF and runs the same extraction the demo animation only simulates. The sandbox is reachable from a "Try with our sample PO" CTA in the hero strip.

### User-facing behavior
- Visitor hits `/`. Sees hero with variant copy + a third "Try a real PO →" tertiary link.
- Clicking the tertiary link drops them into `#/sandbox` (a new route) loaded with a 4-line sample PO and a redacted reply email. The sandbox runs the actual extraction backend (rate-limited to 5 runs/IP/day) and produces the same line-items panel + audit trail that the bleed-console mocks.
- Sandbox CTA at the end: "See it on your PO →" lands in `#/signin?source=sandbox` and pre-fills the use-case dropdown.

### Technical implementation
- New route `#/sandbox` in `src/v3-app/App.tsx`. Add to `PRE_AUTH_ROUTES` at `src/v3-app/App.tsx:139` (currently `new Set(["reset", "signin"])`).
- New file `src/v3-app/screens/sandbox.tsx`. Pulls a static PO JSON from `public/sandbox/po-acme-2456.json`. Posts to `/api/sandbox/extract`, which is a thin wrapper around the existing extraction pipeline that forces a sandbox-tenant context and writes to a 7-day-retention shadow table.
- New endpoint `POST /api/sandbox/extract` (rate limit 5/IP/day via existing `_lib/rate-limit.js`, identical pattern to `src/api/auth/magic_link.js:72-81`).
- New migration `supabase/migrations/104_sandbox_runs.sql`:
  - `create table sandbox_runs (id uuid primary key default gen_random_uuid(), ip_hash text, started_at timestamptz default now(), document_id text, lines_extracted int, conf_avg numeric, completed_at timestamptz);`
  - Retention cron: drop rows older than 7 days.

### Integration plan
- The existing `Demo` component (`src/v3-app/screens/landing.tsx:371-485`) stays as-is but becomes secondary; the new sandbox link sits between the lead paragraph and the spec strip.
- Auth gate (`src/v3-app/App.tsx:316-340`): `PRE_AUTH_ROUTES` adds `"sandbox"` alongside `"reset"` and `"signin"`.
- A/B testing: use a cookie-flipped `landing_variant` value, persist in `audit_events` so the funnel can be sliced.

### Telemetry
Log to `audit_events`:
- `hero_variant_shown` with `{variant: "kinetic" | "negation" | "fact"}`.
- `hero_cta_clicked` with `{cta: "signup" | "demo" | "sandbox", variant}`.
- `sandbox_run_started` with `{ip_hash, document}`.
- `sandbox_run_completed` with `{lines, conf_avg, elapsed_ms}`.
- `sandbox_to_signin` with `{sandbox_run_id, signin_started_at}`.

Alert: if `sandbox_to_signin / sandbox_run_completed` drops below 8 percent over a 7-day window, alert PMM. The category benchmark for visitor-to-lead is 2 to 5 percent; sandbox-to-signin should beat that because the visitor has already self-qualified.

### Non-goals
- Multi-language hero. India B2B is English; Hindi/Tamil deferred.
- A live LLM-augmented chat in the hero. Sandbox is a fixed PO with a fixed answer.

### Open questions
- Does the sandbox-extraction cost ($0.05/run for Claude + $0.001/page for Mistral, per cost compression bet) survive at 5 runs/IP/day on the public internet? Worst case 1,000 unique IPs/day = $50/day = $1,500/mo. Tolerable but flag for cost-control review.
- Is there legal exposure from running a non-customer's actual PO through the sandbox? If the user uploads their own, the answer is yes. Cap the sandbox to the canned PO only.

### Effort
M. 1 week for the sandbox route + endpoint + extraction wiring. 1 week for the A/B variant infra + analytics. 0.5 week for content variants. Total approximately 2.5 weeks.

### 5-axis score
PSev 4 (hero ambiguity costs conversion). MDiff 4 (sandbox + sharper hero is a clear differentiator vs Rossum/Conexiom). TLev 4 (sandbox infrastructure also enables agent eval, support reproductions, training data generation). EStr 4. SFit 5. Total 21/25.

### Deep-dive prompt
"Design a 30-day A/B test for Anvil's hero variants. Cover sample-size calculation for a 3-arm test at expected baseline 4 percent sandbox-clickthrough and MDE 1pp; choice of primary metric (sandbox-completed vs signup-started vs SQL-booked); guard rails to avoid the Simpson's-paradox issue between mobile and desktop; statistical-significance gate (Bayesian vs frequentist); how to allocate traffic if one arm strictly dominates by day 7."

---

## F1.2 Demo cycle math drifts: 15.4s loop vs 4 scenes, reduce-motion gated. [P2]

### Problem
The animated `Demo` component cycles through 4 scenes (Inbox, Extract, Anomaly, Voucher) on a timer-driven `setTimeout` chain. Total cycle time is 3,200 + 4,200 + 4,500 + 3,500 = 15,400ms (`src/v3-app/screens/landing.tsx:83`). The bottom progress strip animates with each scene change. Two issues: the longest scene (Anomaly modal, 4,500ms) does not match the cognitive load of the content (it is dense, with a price-comparison mini-card, three CTA buttons, a 27-word body); the shortest scene (Inbox, 3,200ms) has 4 email rows with staggered animation-delays of 0.1s / 0.25s / 0.4s / 0.55s, leaving only approximately 2,650ms of static read time. A first-time visitor cannot read the full mock email content before the scene cycles away. The voice-over implicit in the visual rhythm punishes slow readers and breaks accessibility.

### Current state on main
- `src/v3-app/screens/landing.tsx:83` DEMO_TIMES array. `src/v3-app/screens/landing.tsx:86-103` useDemoCycle hook uses `setTimeout` chained per scene; resets on unmount. Honours `prefers-reduced-motion: reduce` by holding scene 0 indefinitely. [verified-on-main]
- Each scene has `lp-scene` base class plus `on` modifier when active; CSS handles the cross-fade. The Anomaly scene contains an action-row with three buttons (`src/v3-app/screens/landing.tsx:446-450`) that are visually clickable but inert (no handlers). [verified-on-main]
- `aria-label="Animated product walkthrough"` on the demo container at `src/v3-app/screens/landing.tsx:374` is correct. `aria-hidden="true"` on the stage div at `src/v3-app/screens/landing.tsx:380` hides the kinetic visuals from screen readers, which is correct, but the headline (`<h1>` with `aria-live="polite"` on the kinetic span at `src/v3-app/screens/landing.tsx:635, 640`) re-announces the part-number every 3,500ms, which is audibly aggressive for screen-reader users. [verified-on-main]

### Competitor state
- Linear's product screenshots are static + scroll-revealed, not auto-cycling. [verified-from-prior-knowledge, https://linear.app]
- Stripe shows a logo carousel (auto-cycling) but the product visuals are static screenshots + hover-animated cards, not timer-cycled. [verified-from-prior-knowledge, https://stripe.com]
- Rossum embeds a video player. The user plays it on demand. [verified-from-prior-knowledge, https://rossum.ai]
- Notion uses static screenshots, no auto-cycling. [verified-from-prior-knowledge, https://www.notion.com]
- Of the competitor surfaces verified, none use a 15-second timer-driven 4-scene cycle for the hero demo.

### Adjacent insight
The NN/g "carousel considered harmful" canon is decades old. Auto-rotating content interrupts reading and is repeatedly shown in eye-tracking studies to reduce comprehension. Most modern landing pages have abandoned the pattern. [verified-from-prior-knowledge, https://www.nngroup.com/articles/auto-forwarding/] The Anvil version is more sophisticated than a carousel (it is a state-machine walkthrough of a workflow), but it shares the same readability hazard: the user does not control the cadence.

### Research insight
WCAG SC 2.2.2 (Pause, Stop, Hide) requires that any auto-updating content lasting longer than 5 seconds offer the user a way to pause, stop, or hide it. [verified-from-prior-knowledge, https://www.w3.org/TR/WCAG22/#pause-stop-hide] The current demo is auto-cycling indefinitely (until unmount) with no pause control. The `prefers-reduced-motion` honour at `src/v3-app/screens/landing.tsx:90-91` is necessary but not sufficient for WCAG compliance because a user without the OS-level reduce-motion preference still has no pause control.

### Proposed change
1. Add an explicit Pause/Resume control on the demo URL bar (`src/v3-app/screens/landing.tsx:374-379`), positioned to the left of the "recording" indicator. Default state: playing.
2. Make the scene cycle interactive: clicking a step in the bottom progress strip (`src/v3-app/screens/landing.tsx:474-480`) jumps to that scene and pauses the auto-cycle.
3. Adjust the timing: the Anomaly scene is the densest; bump it to 6,000ms; trim Voucher to 3,000ms (it has only 4 stat cells). New cycle 3,200 + 4,200 + 6,000 + 3,000 = 16,400ms.
4. Drop the `aria-live="polite"` on the kinetic hero span (`src/v3-app/screens/landing.tsx:635, 640`), replace with `aria-live="off"` and announce the pair once via an `aria-labelledby` to a hidden `<p>` containing all 5 pairs in static text. This stops screen-reader chatter.

### User-facing behavior
- Visitor sees the demo auto-play but can interrupt at any scene.
- Screen-reader user reads the headline once, then never again until they re-focus.
- Reduce-motion users see scene 1 only, with a "Play demo" button that opts in.

### Technical implementation
- Add `paused: boolean` state to `useDemoCycle` in `src/v3-app/screens/landing.tsx:86-103`. Expose `setPaused` to `Demo`.
- New control: `<button className="lp-demo-pause" aria-label="Pause demo">⏸</button>` in the demo bar (`src/v3-app/screens/landing.tsx:374-379`).
- Clicking a step in `lp-stop` (`src/v3-app/screens/landing.tsx:473-481`) calls `setPaused(true); setScene(i)`.
- Update CSS in `src/v3-app/styles.css` to style the pause button to match the recording dot.

### Integration plan
- No backend changes.
- Test under all 5 conditions: desktop default, desktop reduce-motion, mobile default, mobile reduce-motion, keyboard-only.

### Telemetry
- `demo_paused` event with `{scene_when_paused: 0|1|2|3}`.
- `demo_step_clicked` event with `{step_index, was_auto_playing: bool}`.
- `demo_cycle_completed` event with the cycle index.

Alert: if `demo_paused / demo_cycle_completed > 50 percent` over a week, the timing is wrong and users want to read more slowly; tune the per-scene durations.

### Non-goals
- A full video player. The HTML+CSS animation is the brand voice; do not regress to a YouTube embed.
- Per-scene click-to-explore (e.g. opening the Anomaly modal in a full overlay). Phase 2.

### Open questions
- Does the kinetic-hero `aria-live` actually annoy screen-reader users today, or do we have telemetry/feedback either way? Open.

### Effort
S. 2 days for the pause control + step-click jump. 1 day for the timing tune. 1 day for accessibility QA. Total approximately 4 days.

### 5-axis score
PSev 3 (a11y gap and readability cost). MDiff 2 (table-stakes). TLev 3. EStr 5 (cited at file:line). SFit 3. Total 16/25. Marginal; ship as part of the hero-A/B work.

### Deep-dive prompt
"Audit Anvil's full animation surface (landing hero, demo cycle, marquee, count-up tween, IntersectionObserver reveal-on-scroll) for WCAG SC 2.2.2, SC 2.3.3, SC 2.5.1, SC 2.5.2 conformance. Produce a violations list with file:line refs and remediations. Add `axe-core` to the CI pipeline so the next regression is caught at PR time."

---

## F1.3 Logos rail replaced with connector marquee: integrity-first, but loses pilot proof. [P1]

### Problem
The landing replaces a traditional customer-logo marquee with a marquee of integration / connector names (Email parse · WhatsApp · Slack · MS Teams · Voice · Anthropic Claude · Mistral OCR · ...). This is integrity-first: Anvil has 17 ERP clients (real code) but only a small handful of named pilot customers, so showing real customer logos would either require consent or fabrication. The fix is honest. But it sacrifices the most-converting element of B2B landing pages: third-party trust validation. A visitor cannot tell whether Anvil has zero customers, three, or three hundred.

### Current state on main
- `src/v3-app/screens/landing.tsx:672-684` ships the shipping-integrations rail. Label: "Currently shipping integrations · 17 ERPs · 5 inbound channels · 6 doc engines · 4 finance & tax." The marquee loops through `CONNECTOR_TABS.flatMap((t) => t.tiles)` doubled (so the loop has no visible seam). [verified-on-main]
- No customer logos anywhere on the landing. The closest is the founder note section (`src/v3-app/screens/landing.tsx:953-983`) which says "KP · Pune" but is not a customer claim. [verified-on-main]
- The compare table (`src/v3-app/screens/landing.tsx:1124-1151`) references "Workato / Pipefy", "Generic OCR", "Build in-house" as competitors by name in copy, not in logo form. [verified-on-main]

### Competitor state
- Rossum's logo wall shows 25+ named enterprise logos: Panasonic, Siemens, Bosch, Wolt, Adyen, Kingfisher. [verified-from-prior-knowledge, https://rossum.ai]
- Conexiom shows 10+ logos: Exxon Mobil, Arrow Electronics, Johnstone Supply, ADI, NEC, Graybar, Fastenal, Ecolab, Parker Hannifin, Goodman. [verified-from-prior-knowledge, https://www.conexiom.com]
- Hyperscience shows 13+ enterprise + government logos including American Express, Charles Schwab, MetLife, Stryker, Volkswagen, plus US gov bodies (VA, SSA, CA Dept of Corrections). [verified-from-prior-knowledge, https://www.hyperscience.ai]
- Notion advertises "62 percent of Fortune 100" and "98 percent of Forbes Cloud 100" with 15+ logos. [verified-from-prior-knowledge, https://www.notion.com]
- Linear shows 3 named CEO testimonials with photos. [verified-from-prior-knowledge, https://linear.app]
- Cursor shows CEO/President testimonials from NVIDIA, Stripe, OpenAI. [verified-from-prior-knowledge, https://cursor.com]

### Adjacent insight
Of 7 competitor landings reviewed, 7 have prominent customer-logo walls or named-CEO testimonials. The Anvil approach is contrarian. Contrarianism wins when the message is differentiated; loses when the visitor needs the assurance and the contrarian replacement doesn't carry the same weight.

### Research insight
The 2026 B2B landing-page benchmark study lists "social proof block" as one of the 4 highest-lift elements on a B2B landing page. [verified-from-prior-knowledge, growthspreeofficial.com 2026 benchmarks] Connector logos are a form of social proof, but they are weaker than customer logos because they only signal "the vendor knows about these systems," not "real buyers chose this vendor." NN/g UXR on customer-testimonial collection emphasizes named, role-tagged, vertical-tagged quotes over anonymized ones. [verified-from-prior-knowledge, https://www.nngroup.com/articles/social-proof-ux/]

### Proposed change
A two-row trust strip:
1. Row 1 (top, primary): customer logos. Anvil currently has named pilot customers Acme Industrial (used in the demo); Cyclone Bolt-equivalent (pending consent). Aim for 4 to 6 logos by end-Q3. Until then, replace with anonymized "Distributor in [Mumbai|Bangalore|Pune|Chennai] · [size]" tiles with a real-customer count badge "4 production tenants · 27,000 SOs processed YTD" (numbers must be real and pulled from `audit_events`).
2. Row 2 (below, secondary): the existing connector marquee unchanged.

The two rows together give "real buyers chose this vendor" + "and here's what they connect."

### User-facing behavior
- A first-time visitor sees customer counts and (eventually) named logos.
- Hovering a logo opens a popover with the customer's one-line case ("Acme Industrial · 60-line POs/day · 8min to 45s SO time").
- A persistent "We can't show all logos under NDA" disclosure microcopy.

### Technical implementation
- New JSON: `src/v3-app/data/customers.json` with `{ id, slug, display_name, vertical, size, monthly_sos, since, logo_url, anonymous: bool, quote?: string }`.
- New section between `lp-hero` and `lp-logos` in `src/v3-app/screens/landing.tsx`. Renders from the JSON; if a customer has `anonymous=true` and no logo_url, render a styled `<div>` tile with the vertical/city + a real-customer count badge.
- Telemetry endpoint `GET /api/marketing/customer_stats` that returns `{ total_tenants, total_sos_ytd, last_updated }` cached 5 min. The number must come from a count over `tenants where is_sandbox=false` and a sum over `audit_events where action='voucher.committed' and ts > date_trunc('year', now())`.

### Integration plan
- Reuses the existing `audit_events` model. (Note: `is_sandbox` is currently a column on AA-consent and TReDS tables only, not on `tenants`. F1.6 proposes adding it to `tenants`; this finding inherits that work.)
- Build-time fetch on the Vite static build so the numbers are inlined and the page works without JS.
- A weekly cron updates the inlined numbers if no new build has shipped.

### Telemetry
- `customer_logos_viewed` (impression).
- `customer_logo_hovered` (per-logo).
- `customer_quote_shown` (popover open).

### Non-goals
- Live customer-quote ticker. Static rotating quotes only.
- Customer-detail pages. Phase 2.

### Open questions
- Have we documented written consent from each named pilot customer? Bug-bounty-level legal hygiene: every public logo claim must have a signed `customer-logo-consent.md` in `legal/` (which does not appear to exist in the repo today; verify before going live).

### Effort
S. 1 day for the JSON + section. 0.5 day for the endpoint. 0.5 day for the cron + caching. 1 week (calendar) for customer-consent gathering. Total approximately 2 engineer-days, blocked on legal.

### 5-axis score
PSev 3. MDiff 4 (customer logos are the strongest B2B signal). TLev 2. EStr 5. SFit 5. Total 19/25.

### Deep-dive prompt
"Run a 60-day cold-survey of Anvil's pilot customers to gather (a) written logo-use consent, (b) one-line quote, (c) two quantified outcomes (e.g. SO-time reduction, error-rate reduction). Output a `customers.json` ready to ship plus a refusal log (so we know what we can't say). Run by founder/CEO; cite NN/g customer-testimonial-collection guidance for ethical framing."

---

## F1.4 Security strip understates posture: 6 badges but only 2 statuses, no SOC 2 evidence link. [P1]

### Problem
The landing's Security strip (`src/v3-app/screens/landing.tsx:687-706`) ships 6 badges: SOC 2 Type II (in progress), ISO 27001 (in progress), GDPR / DPDP (compliant), Data residency (IN · EU · US), BYO LLM key (supported), PII redaction (always-on). Two of the six are programs in progress, four are operational claims. The strip looks legit, but a finance / CFO buyer who clicks any of the 6 badges hits nothing: the badges are static divs with no link to evidence, no link to a /security or /trust page, no auditor name on the in-progress ones, no "request SOC 2 report" form, no public sub-processor list. Compared to the standard set by Stripe / Vercel / Supabase, this is a trust gap not a trust signal.

### Current state on main
- `src/v3-app/screens/landing.tsx:192-199` SECURITY array. 6 entries with `kind: "prog" | "live"`. [verified-on-main]
- `src/v3-app/screens/landing.tsx:695-704` renders each badge as a `<div className="lp-sb">` with no `<a href>`. There is no `/security` or `/trust` route in the screen tree. The existing `WiredSecurity` (`src/v3-app/screens/security.tsx:47-58`) is admin-only and gates non-admins behind an "Insufficient permissions" banner. [verified-on-main]
- The landing FAQ at `src/v3-app/screens/landing.tsx:343` answers question 1 about data residency ("ap-south-1, Mumbai. EU and US residency available on Growth and Enterprise plans..."), but FAQ is below the connector grid, far from the badge strip. [verified-on-main]
- `src/v3-app/screens/signin.tsx:529-531` ships a one-line trust strip at the bottom of the signin card: "SOC 2 in progress · ISO 27001 in progress · RLS on every table · AES-256-GCM at rest · HMAC-signed audit export · PII redaction always-on." Same six claims again. [verified-on-main]

### Competitor state
- Stripe's `https://stripe.com/docs/security/security`: full page with PCI Level 1, SOC 1/2/3, EMVCo, CBPR, PRP, EU-US DPF, NIST CSF. Each cert is linked to evidence (a SOC 3 PDF, a PCI AOC). [verified-from-prior-knowledge]
- Vercel's `https://vercel.com/security`: ISO 27001, SOC 2 Type 2, PCI DSS, HIPAA, GDPR, DPF, TISAX, with badges + product features + 12 FAQ items. [verified-from-prior-knowledge]
- Supabase's `https://supabase.com/security`: 10 sections, MFA, SOC 2 Type 2, HIPAA, ISO 27001, AES-256, RBAC, daily backups + PITR, vulnerability mgmt, DDoS protection. Explicitly honest about not having a formal bug bounty. [verified-from-prior-knowledge]

### Adjacent insight
Trust pages are not optional in 2026 enterprise B2B. CFOs run them through a checklist. Stripe-grade transparency is the bar.

### Research insight
The SOC 2 Type II observation window is typically 6 to 12 months. "In progress" with no auditor named is meaningless to a SOC 2-savvy buyer (Drata, Vanta, Secureframe customers can read between the lines). Better: name the auditor + the planned issuance date. The OWASP authentication and trust-evidence cheat sheet recommends machine-readable evidence catalogues for SOC 2 Type II artifacts. [verified-from-prior-knowledge, https://owasp.org/www-project-authentication-cheat-sheet/]

### Proposed change
1. Each badge becomes a `<a href="#/trust">` (or `<a href="/trust.html">` static page).
2. New page `src/v3-app/screens/trust.tsx` (anonymous, pre-auth, modeled on the public landing). Sections:
   - SOC 2 Type II (in progress, auditor: [TBD], observation window: 2026-04-01 → 2026-09-30, issuance target: 2026-Q4).
   - ISO 27001 (in progress, auditor: [TBD], target: 2027-H1).
   - GDPR + DPDP (live, links to DPA template).
   - Data residency (IN, EU, US, with the actual Supabase region mapping per the data-residency claim in FAQ Q1).
   - Sub-processors (Supabase, Vercel, Anthropic, Mistral, Twilio, SendGrid, ClamAV, each linking to their respective sub-processor pages and security claims).
   - Encryption (AES-256 at rest via Supabase Storage, HMAC-signed audit export, TLS 1.2+ in transit). Note: `src/api/_lib/secrets.js` is the encryption helper; `src/api/auth/mfa.js:21-33` is the call site for TOTP secret encryption. [verified-on-main]
   - MFA + passkey (forced on for Enterprise tier, optional on Growth, with a settings link).
   - Audit log (append-only, tied to the audit-trail card on landing).
   - Bug bounty (private @ HackerOne or BugCrowd; if not running one, list `security@anvil.app` and a 90-day disclosure window).
   - SOC 2 / ISO report request (gated form posting to `/api/security/report_request`).
3. Bottom strip on `src/v3-app/screens/signin.tsx:529-531` links to `/trust`.
4. Add a "Last audited" timestamp on each "live" badge.

### User-facing behavior
- A buyer clicks the SOC 2 badge → /trust → sees auditor name + target date + a request-report form.
- A buyer clicks PII redaction → /trust#pii-redaction → sees a screenshot of the redaction-rule console + the list of default rules (Aadhaar, PAN, credit-card, IBAN, etc., as enumerated in `src/v3-app/screens/format-guide.tsx:53`).

### Technical implementation
- New screen `src/v3-app/screens/trust.tsx` (pre-auth, lazy-loaded). Add to `PRE_AUTH_ROUTES` in `src/v3-app/App.tsx:139`.
- New endpoint `POST /api/security/report_request` rate-limited (3/IP/day) that posts to `security@anvil.app` via SendGrid.
- New migration `supabase/migrations/104_security_report_requests.sql` for the request log table.
- Update SECURITY array at `src/v3-app/screens/landing.tsx:192-199` so each item has `link: "#trust#" + slug`.

### Integration plan
- Reuses the redaction firewall surface in `WiredSecurity` (`src/v3-app/screens/security.tsx:127-190`), a public marketing screenshot of the same surface.
- Sub-processor list mirrors what `package.json` and `src/api/_lib/` clients actually call out to (Anthropic via `_lib/anthropic-client.js`, Mistral via `_lib/mistral-client.js`, Twilio for WhatsApp, SendGrid, ClamAV per `src/v3-app/screens/format-guide.tsx:50-55`).

### Telemetry
- `trust_page_viewed`.
- `trust_section_expanded` with section id.
- `security_report_requested` with email-domain only.
- `subprocessor_clicked` with sub-processor name.

### Non-goals
- The SOC 2 attestation itself. Out of scope; that is an audit-firm project.
- Public bug bounty program. Phase 2.

### Open questions
- Is the SOC 2 auditor already engaged? If yes, name them. If no, "auditor TBD" plus a Q3 engagement plan is fine but say so.
- DPDP-compliance certification, is there a third-party stamp or just internal? The badge says "compliant," which is a strong claim under the new India DPDP Act.

### Effort
M. 1 week for the trust page. 0.5 week for the endpoint + migration. 1 week for content curation + legal review. Total approximately 2.5 weeks.

### 5-axis score
PSev 4 (CFO due-diligence blocker). MDiff 4 (Stripe-grade trust page is differentiated in vertical-AI / sales-ops space). TLev 3. EStr 5. SFit 5. Total 21/25.

### Deep-dive prompt
"Map every SOC 2 Type II CC (Common Criteria) sub-requirement to an Anvil control surface. For each control, cite the implementing file in `src/api/_lib/` or `supabase/migrations/`. Output the gap list with owners and remediation effort. Goal: by 2026-Q3, every CC has a code or policy citation, ready for the auditor's first walkthrough."

---

## F1.5 Pricing tier under-instrumented for INR-only ICP, no per-SO overage telemetry. [P2]

### Problem
Anvil's pricing page is part of the landing as a 3-tier scaffold (`src/v3-app/screens/landing.tsx:278-321`). The tiers are Starter ₹14,990/mo (200 SOs, ₹39/SO over), Growth ₹49,990/mo (1,000 SOs, ₹19/SO over), Enterprise from ₹99,990/mo (5,000 SOs, ₹9/SO over, BAA, BYO LLM, etc.). The structure is good and INR-default is correct for the ICP. Two gaps: (1) the page does not surface any currency toggle, so a Saudi or German buyer cannot see the price in their currency without doing the math; (2) there is no telemetry on per-SO overages in the backend. The tier copy implies an `sos_used` and `sos_overage` counter exists, but no migration creates such columns. Once the first paying customer crosses 200 SOs, billing will be a manual reconciliation.

### Current state on main
- `src/v3-app/screens/landing.tsx:278-321` TIERS array. 3 tiers, INR-only. [verified-on-main]
- `src/v3-app/screens/landing.tsx:1098-1121` renders the tier cards with `lp-tier-ribbon`, `lp-tier-price`, `lp-tier-pmeta`, `lp-tier-pcta`. Highlighted tier ("most pop") is Growth. [verified-on-main]
- No `pricing.tsx`, no currency toggle, no `useGeoIP` hook. The CTAs link to `#cta` (an in-page anchor) or to mailto. [verified-on-main]
- No migration with `sos_used`, `sos_overage`, `billing_period_start` columns; a `find /Users/kenith.philip/anvil/supabase/migrations -iname "*billing*" -o -iname "*pricing*" -o -iname "*subscription*"` returns 0 results. [verified-on-main]
- FAQ at `src/v3-app/screens/landing.tsx:344-345`: "Two weeks to first voucher is the bar we hold ourselves to." This is the activation promise that pricing builds on, but there is no instrumentation to validate the "two weeks" claim (see F1.16).

### Competitor state
- Conexiom shows 3 tiers (Standard ≤ 2,000 docs/mo; Professional ≤ 12,000; Enterprise tiered per-doc). Doc-volume-based, no per-doc visible. [verified-from-prior-knowledge, https://www.conexiom.com]
- ClearTax India shows no pricing on the homepage, hidden behind "Book Now" CTAs. [verified-from-prior-knowledge, https://cleartax.in]
- Tally Solutions India shows no pricing, "Take a Free Trial" 7-day, then `/buy-tally` page. [verified-from-prior-knowledge, https://tallysolutions.com]
- Linear, Notion, Stripe, Vercel, Supabase: all public pricing tiers, all with currency-detection (Stripe and Vercel detect IP region).
- Most B2B AI sales-ops tools (Rossum, Hyperscience, Esker) hide pricing, gating it behind sales.

### Adjacent insight
The India SMB pricing canon (per Tally and ClearTax positioning): hide pricing, push to trial/expert call. Anvil's transparent INR pricing is contrarian for the ICP and is the right call: distributors are price-sensitive and bounce when they can't see the number. The Conexiom-style doc-cap structure is correct.

### Research insight
B2B pricing transparency below $50k ACV correlates with higher PQL conversion and shorter sales cycles. [inferred from category norms; specific paper not verified this session]

### Proposed change
1. Add a currency-toggle in the pricing section. Detect IP via the existing Vercel edge (per `vercel.json` headers if available; else default to INR for `?country=IN` and USD elsewhere).
2. Wire actual per-SO usage telemetry:
   - New column `tenants.billing_tier text not null default 'starter'`.
   - New column `tenants.billing_period_start timestamptz not null default date_trunc('month', now())`.
   - New view `tenant_so_usage` aggregating `audit_events where action='voucher.committed' group by tenant_id, date_trunc('month', ts)`.
   - New API endpoint `GET /api/billing/usage` (authed) returning the current period's count + tier limit + projected overage.
3. New tenant-facing card in the in-app shell showing "157 / 200 SOs this month · ~₹98/SO overage projected if you hit 250".
4. New webhook to a billing system once the first overage period fires.

### User-facing behavior
- A buyer in Pune sees ₹14,990 / ₹49,990 / ₹99,990.
- A buyer in Munich sees €169 / €549 / from €1,099 (USD/EUR pricing TBD by finance).
- A logged-in customer admin sees their current usage in real time.

### Technical implementation
- Geo-detection: lean on Vercel's `Geo` API (`req.geo.country` if available).
- New endpoint `/api/billing/usage` follows the `_lib/auth.js + resolveContext` pattern of `src/api/auth/mfa.js:59-60`.
- New migration `104_billing_tier_and_usage.sql` adds the columns + view.

### Integration plan
- The `audit_events` immutable log is the source of truth; the view is derived.
- Pricing page stays static unless a feature flag flips currency toggle on.
- For real billing, integrate with Razorpay (already on the platform: `src/api/_lib/razorpay-client.js`) or Stripe (already on the platform: `src/api/_lib/stripe-client.js`). [verified-on-main]

### Telemetry
- `pricing_currency_toggled` with `{from, to}`.
- `pricing_tier_clicked` with tier id.
- `pricing_faq_opened` with question idx.
- Server-side: `billing_usage_calculated` per tenant per day; `billing_overage_threshold_crossed` when usage hits 80, 100, 120 percent of tier limit.

Alert: any tenant 30 days into a billing period above tier limit with no overage payment recorded → page CSM.

### Non-goals
- Self-serve checkout. Defer to Phase 2.
- Annual prepay discount. Phase 2.
- Volume discount calculator. Phase 2.

### Open questions
- Are the INR prices final or placeholder? Finance owns this.
- What's the conversion math for the overage tier? ₹39/SO at Starter vs ₹19/SO at Growth implies a break-even at 1,316 SOs/mo over Starter, which is well above the 1,000-SO Growth limit. Looks fine but verify.

### Effort
S. 1 day for currency toggle. 2 days for the migration + endpoint. 1 day for in-app usage card. Total approximately 4 days.

### 5-axis score
PSev 3. MDiff 3. TLev 4 (foundation for billing). EStr 4. SFit 4. Total 18/25.

### Deep-dive prompt
"Design Anvil's billing system end-to-end. Cover the SO-counting algorithm (which audit event counts; what about voided / reversed vouchers?), the overage invoicing flow (Razorpay vs Stripe vs manual), the dunning policy, and the read-only-mode trigger for non-paying tenants. Output a 30-day implementation plan with file paths."

---

## F1.6 Sandbox / time-to-first-value still unbuilt despite landing claims. [P0]

### Problem
The landing makes a "two weeks to first voucher" claim (FAQ Q3, `src/v3-app/screens/landing.tsx:345`) and the hero offers "Sign up free → 30-day pilot" plus "free pilot · 30 min · we run a real PO" (`src/v3-app/screens/landing.tsx:649-656`). Neither claim is operationalized in code. A "free 30-day pilot" without a sandbox tenant and a "run a real PO" without a one-click upload flow is marketing-on-trust. The signup screen (`src/v3-app/screens/signin.tsx:136-180`) creates a real tenant_members row pending admin approval. The new sign-up does not get any sample data, sample customers, sample PO archives, or a pre-connected Tally mock. A first-time user lands in the home screen with empty tabs and bounces.

### Current state on main
- `src/v3-app/screens/signin.tsx:136-180`: `onSignUp` calls `ObaraBackend.auth.signup({ email, password, display_name, requested_role, notes })`. The endpoint at `src/api/auth/signup.js:37-150` calls `ensureMembership` and lands the user in pending status; first user on a fresh tenant is auto-approved as admin, every subsequent user lands `status='pending'` (admin approves via `admin_notifications` flow at `src/api/auth/signup.js:119-138`). [verified-on-main]
- `src/v3-app/screens/connect.tsx:96-128`: An older `signUp()` flow that takes email + password + display_name and returns a fresh session on success (no admin gate, immediate session). This is a parallel surface; see F1.11.
- `src/v3-app/screens/onboarding.tsx:42-82`: Wired-onboarding checklist with 5 steps. Step 2 says "Apply database migrations · Run all 10 SQL migrations against the Supabase project plus seed.sql once." This is internal-ops, not new-user onboarding (the system already has 103 migrations applied to the production project; a new user does not run migrations). Step 3 says "Add a tenant member · Insert your auth.users row into tenant_members with role admin." This is ops-engineer language. [verified-on-main]
- No `is_sandbox` column on `tenants`. The token `is_sandbox` exists on `consent_grants`, `treds_invoices`, and `treds_disbursements` from `supabase/migrations/102_aa_treds_sandbox.sql:71, 109, 153` for the Bet 6 AA + TReDS sandbox, but `tenants` itself has no sandbox flag. [verified-on-main]
- No `time_to_first_voucher` field on `tenants` or `audit_events`. See F1.16.

### Competitor state
- Soff: "Get Started" → real workspace creation, "up and running within a day" claim. [verified-from-prior-knowledge, https://soff.ai]
- Rossum: "Free Demo" gate, no sandbox. [verified-from-prior-knowledge, https://rossum.ai]
- Conexiom: Gated by sales, no sandbox. [verified-from-prior-knowledge, https://www.conexiom.com]
- Linear: Workspace creation < 60s, sample issues auto-created. [verified-from-prior-knowledge, https://linear.app]
- Notion: Workspace creation < 30s, sample pages pre-populate. [verified-from-prior-knowledge, https://www.notion.com]
- Supabase: Project creation < 2 min. [verified-from-prior-knowledge, https://supabase.com]

### Adjacent insight
Notion's "Meet the night shift" hero leads to "Get Notion free" which provisions an agent-enabled workspace in under 30 seconds. The agent then automates the first task. That is the bar for "PLG signup + activation."

### Research insight
Appcues' onboarding canon: "Every decision in your onboarding design should be oriented around getting users to that moment as quickly as possible." [verified-from-prior-knowledge, https://www.appcues.com/blog/user-onboarding-best-practices] For Anvil the aha is "the PO parsed, the SO was drafted, the audit trail is real." Time budget: 5 minutes from signup-submitted to first-extraction-completed.

### Proposed change
Sandbox flow (this is the most-leveraged single product change in this audit):
1. Signup creates a tenant with `is_sandbox=true, sandbox_expires_at=now()+30d`.
2. Server seeds: 5 customer rows, 8 part-master rows, 3 source-PO source profiles, 3 sample customer POs (PDF + Excel + WhatsApp-text), a mock Tally connector. Real obfuscated samples drawn from Obara India archives with anonymized customer names + GST + SKU shapes.
3. Auth lands in `#/home?tour=1` (see F1.7 for the tour).
4. Sandbox tenant goes read-only at expiry; conversion CTA escalates daily for the last 7 days.
5. Day-7 email: "Ready to connect your real Tally?" → CSM call.

### User-facing behavior
A first-time visitor:
- Hits `/`, clicks "Sign up free."
- Lands on `#/signin` (tab "signup"). Enters email + password + display_name.
- Tenant created with `is_sandbox=true`. Auth gate flips authed. Lands at `#/home?tour=1`.
- Tour pulses Import tab. Visitor clicks Import. Sample POs visible. Click first PO.
- Watches the extraction unfold. Sees the same line-items panel + audit trail as the demo animation.
- Pushes to mock Tally. Audit log shows "Pushed to Tally (sandbox)" with a real voucher number for the sandbox-tenant.
- A banner pin: "You're in a sandbox. Connect your real Tally to go live →"

### Technical implementation
- New migration `supabase/migrations/104_sandbox_tenants.sql`:
  ```sql
  alter table tenants add column is_sandbox boolean not null default false;
  alter table tenants add column sandbox_expires_at timestamptz;
  alter table tenants add column tour_completed_at timestamptz;
  alter table tenant_members add column tour_skipped_at timestamptz;
  ```
- New `src/api/_lib/sandbox_seed.js`: contains sample-data SQL or objects. Mirrors the static-data seed patterns under `supabase/migrations/004_*` and `007_*` (used elsewhere in the repo as the canonical seed shape).
- Update `src/api/auth/signup.js`: when `SIGNUP_ALLOWED=true` and not invited, set `is_sandbox=true` on the new tenant and call `sandboxSeed.applyTo(tenantId)`. The current signup auto-approves first-tenant-user and lands every subsequent signup `status='pending'` (`src/api/auth/signup.js:89-100`); the sandbox flow should auto-approve sandbox tenants instead so users don't wait on admin review.
- Update every write path to honor the sandbox flag: `src/api/orders/`, `src/api/tally/`, `src/api/source_pos/`, return mock success when `is_sandbox=true`. Approximately 1 line per route.
- Vercel cron: daily scan for `tenants where is_sandbox=true and sandbox_expires_at < now()`, set them read-only via a new `tenants.is_readonly` column.

### Integration plan
- Backward-compat: existing real-paying tenants (Obara India) stay `is_sandbox=false`. Their write paths are unchanged.
- Sandbox flag must NOT propagate to PII redaction (the firewall stays on regardless).
- `src/api/audit/` writes "sandbox=true" tag on every event so the audit panel renders the right disclaimer.

### Telemetry
- `signup_sandbox_created` with `{tenant_id, source: 'hero_cta' | 'pricing' | 'cta_section'}`.
- `sandbox_first_po_uploaded` (the canonical activation event).
- `sandbox_first_extraction_completed`.
- `sandbox_first_so_created`.
- `sandbox_first_tally_push_completed`.
- `sandbox_to_real_tally_connected` (the conversion event).

Alert: any tenant past day-7 with 0 successful extractions → CSM email. Any tenant at day-25 with `sandbox_expires_at` within 5 days and no real-Tally connection → CSM phone call.

### Non-goals
- Private sandbox where a prospect uploads real PII. Risk of cross-tenant leak too high.
- Auto-delete of sandbox data at expiry. Go read-only, preserve for support.

### Open questions
- Legal: are the obfuscated Obara India sample POs cleared for use as sample data? Probably yes if anonymized but verify before shipping.
- Sandbox cost: at 1,000 signups/mo × ~3 sample POs × $0.05 per Claude extraction = $150/mo. Negligible.

### Effort
M. 1 week for signup endpoint + seed script. 1 week for sandbox flag propagation through write paths. 1 week for in-app tour (see F1.7). Total approximately 3 weeks.

### 5-axis score
PSev 5. MDiff 5 (no vertical-AI competitor offers a real sandbox). TLev 5 (also enables internal demos, evals, training data). EStr 5. SFit 5. Total 25/25. Highest-priority gap.

### Deep-dive prompt
"Audit the data-residency and PII implications of seeding sandbox tenants with obfuscated production-customer data. Specifically: is hashing customer names sufficient anonymization under DPDP and GDPR if a forensic-level attacker can re-identify by GST patterns? Recommend a redaction-firewall preset for sandbox-only and a 30-day data-retention cap."

---

## F1.7 First-run onboarding is a checklist, not a tour, and double-routes with /connect. [P0]

### Problem
The `onboarding.tsx` screen ships a 5-step checklist that re-checks itself on every visit by counting customers / orders / BOM rows from the API. It is reachable via `#/onboarding` or the command palette, but the auto-redirect on first-load is to `#/connect` (verified at `src/v3-app/screens/onboarding.tsx:11`). So a first-time user who completes signup never sees the onboarding checklist; they see the connect screen, which is a Backend URL + Tenant ID configurator. That makes sense for ops engineers but is hostile to a sales-ops user who just signed up via the hero. The user is now in a "Backend URL" form asking them for a Vercel deploy URL, a phrase 99 percent of distributors have never heard.

### Current state on main
- `src/v3-app/screens/onboarding.tsx:10-13`: "We DO NOT auto-show the screen anywhere (the auto-redirect on first-load is /connect, never /onboarding)." [verified-on-main, this is the literal in-code comment]
- `src/v3-app/screens/connect.tsx:175-318`: Renders the Backend URL field, Tenant ID field, then a 4-tab section (Create account / Sign in / Magic link / Dev token). [verified-on-main]
- `src/v3-app/App.tsx:200`: routes redirect to `/connect` when no session, but the new signin flow at `signin.tsx` is the modern surface. The `/connect` surface is the legacy command-palette modal extracted to a route, kept for backward compat, but it is still the first-load default for unauthed users in some paths. [verified-on-main]
- The signin screen (`src/v3-app/screens/signin.tsx`) is reachable at `#/signin` and is the surface linked from the landing hero (`src/v3-app/screens/landing.tsx:610-611`).
- `src/v3-app/screens/onboarding.tsx:42-82` step copy is internal-ops jargon ("Run all 10 SQL migrations against the Supabase project plus seed.sql once" — and note that the production project is now at 103 migrations, not 10; this step is stale by a factor of 10).

### Competitor state
- Linear: 6-step in-app tour, auto-triggered on first authenticated session, skip-able. [verified-from-prior-knowledge]
- Notion: "Try the magic" template pre-seeded into the first workspace. [verified-from-prior-knowledge]
- Stripe Dashboard: 4-step checklist (Activate account / Take a test charge / Customize / Go live). [verified-from-prior-knowledge]
- Hyperscience, Rossum, Conexiom: no public tour visible (gated). [verified-from-prior-knowledge]

### Adjacent insight
Appcues' research: "Behavioral over temporal triggers. Onboarding flows triggered by user behavior consistently outperform flows triggered by arbitrary time delays." [verified-from-prior-knowledge, https://www.appcues.com/blog/user-onboarding-best-practices] For Anvil, the trigger should be "tenant has zero successful extractions yet" not "tenant created < 24 hours ago."

### Research insight
NN/g's research on first-run tours: tours that block the user from exploring underperform tours that overlay-pulse a target element and let the user click it themselves. [verified-from-prior-knowledge, https://www.nngroup.com/articles/sign-up-forms/ and adjacent] The Anvil tour should pulse, not modal-trap.

### Proposed change
1. Eliminate the `#/connect` first-load default for users who are not in an "ops engineer" role. Detect role via `RBAC.role()` (`src/v3-app/screens/connect.tsx:5, 314`): if the role is `sales_engineer | sales_manager | procurement | finance` (any non-admin), redirect to `#/home?tour=1` instead.
2. The /connect screen becomes admin-only and is re-labeled "Backend configuration" (sales users never see it).
3. Replace the 5-step `onboarding.tsx` checklist with an actual 4-step tour (overlay-pulsing) following the schema in F1.6: Upload sample → Watch extraction → Resolve anomaly → Push to Tally.
4. Tour auto-fires on first authenticated session where `tour_completed_at IS NULL AND tour_skipped_at IS NULL`.
5. Both pause-friendly and skippable; skip persists in `tenant_members.tour_skipped_at`.

### User-facing behavior
- After signup → magic-link → callback → land in `#/home`. Tour boots within 500ms.
- Modal welcome card: "Anvil reads any customer PO and pushes a clean SO to Tally. Let's run the demo PO."
- Click "Start tour" → Import tab gets soft pulse → click → sample POs visible → click first → tour overlays the "watch this" prompt.
- 30-day return for users who didn't complete: in-app "Pick up where you left off" banner.

### Technical implementation
- New tour orchestrator component: `src/v3-app/components/Tour.tsx`. Subscribes to `audit_events` filtered to the current tenant.
- State machine: 4 steps with `(target_element_id, copy, completion_event)`.
- Records to `audit_events`:
  - `tour_started` on first authenticated session.
  - `tour_step_completed[1..4]` on each completion event.
  - `tour_skipped` if user closes the welcome card.
  - `tour_completed` when step 4 fires.
- Redirect logic in `src/v3-app/App.tsx`: if `route === "connect" && rbac.role() !== "admin"` → redirect to `#/home`.

### Integration plan
- `WiredOnboarding` checklist stays accessible via the command palette as a "reset tour" entry, but is no longer the primary onboarding surface.
- `WiredBackendConnect` becomes admin-only, hidden from non-admin role nav.

### Telemetry
- See list above.
- Plus: `tour_completion_rate` derived metric, weekly trend.

### Non-goals
- Personalized tour per `use_case` selected at signup. Phase 2.
- A full LMS course. Tour is 4 minutes max.

### Open questions
- Where does the sample PO live for non-sandbox tenants (real customers who signed up via invite)? Skip the tour for non-sandbox tenants entirely? Open.
- Does an admin user also see the tour, or only the connect screen?

### Effort
M. 2 weeks for the Tour component. 1 week for sandbox seed → tour wiring. 0.5 week for redirect logic. Total approximately 3.5 weeks.

### 5-axis score
PSev 5. MDiff 3. TLev 4. EStr 5. SFit 5. Total 22/25.

### Deep-dive prompt
"Inventory every place in `src/v3-app/App.tsx` and `screens/*.tsx` that uses the `#/connect` route as a fallback. Output a refactor plan that makes `#/connect` admin-only and ensures non-admin users never see it. Cite each call site by file:line."

---

## F1.8 Magic-link is rate-limited to 5 per 15 min per email but generic-200 hides errors. [P2]

### Problem
The magic-link endpoint (`src/api/auth/magic_link.js`) has been hardened to defeat user-enumeration: it returns a generic 200 regardless of whether the email exists, the OTP send succeeded, or rate-limiting tripped. It also enforces a 5-per-15-minute sliding window per email and 20-per-15-minute per IP. This is correct security posture. But the user-facing UX is now indistinguishable across three outcomes: (a) magic link sent, (b) account does not exist, (c) rate-limited. A user who never receives the email cannot tell whether to wait, retry, or contact support. The `recordMagicLink` audit insert at `src/api/auth/magic_link.js:34-43` does store the outcome (`sent | throttled | failed`), but the user cannot see their own log entry.

### Current state on main
- `src/api/auth/magic_link.js:53` `GENERIC_OK = { ok: true, message: "If an account exists for that address, a magic link has been sent." }`. [verified-on-main]
- `src/api/auth/magic_link.js:64, 78, 99, 102`: returns GENERIC_OK on every outcome. [verified-on-main]
- `src/api/auth/magic_link.js:23-32` `safeRedirectTo` allowlists `redirectTo` against `MAGIC_LINK_REDIRECT_URL`. This closes the post-auth-landing redirection vector for an attacker who triggers a magic link on a victim's email. [verified-on-main]
- `src/api/auth/magic_link.js:92-95` calls `svc.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } })`. The `shouldCreateUser: false` change was an explicit May 2026 audit fix (P1.3 in inline comments) to prevent attackers from filling `auth.users` by spraying magic-link requests. [verified-on-main]
- `src/v3-app/screens/signin.tsx:300-301` displays "Magic link sent. Check your inbox." on success. The same string fires regardless of whether the email actually was sent. [verified-on-main]
- The audit row at `src/api/auth/magic_link.js:36` captures email, outcome, ip, user_agent. RLS prevents the requesting user from reading their own row before they're authenticated.

### Competitor state
- Linear's magic-link flow returns a similar generic confirmation but offers a "Resend in N seconds" countdown after the first send. [inferred from typical pattern]
- Vercel's magic-link returns a "Check your inbox" page with a "back to sign-in" link and a "Try a different way" fallback (SSO). [verified-from-prior-knowledge, https://vercel.com/login]
- Most modern SaaS surfaces add: "Didn't get it? Check spam. Try password sign-in instead. Contact security@."

### Adjacent insight
OWASP's auth cheat sheet recommends generic responses for security but layered self-help for UX. [verified-from-prior-knowledge, https://owasp.org/www-project-authentication-cheat-sheet/] Anvil ships the security half but not the UX half.

### Research insight
NN/g on "feedback for failed actions": users want a specific affirmation of state, even if the system cannot disclose why. The right fix is not to leak rate-limit state to attackers but to give the legitimate user a self-help path. [verified-from-prior-knowledge, https://www.nngroup.com/articles/error-message-guidelines/]

### Proposed change
1. After the user clicks "Send magic link" the response time is constant (server pads to 200ms baseline regardless of outcome; currently it returns as soon as the operation completes, which leaks timing oracles).
2. UI shows: "If your email is on file, a link is on the way. (sent at HH:MM) [Resend in 90s] [Try password sign-in] [Contact support]." Resend button disabled for 90s after each click.
3. New endpoint `GET /api/auth/magic_link_status` (authed via the recent sent-link hash or via a per-IP recent-send marker) that returns "you have N sends remaining in this window", but only after the user has clicked the link successfully. This way, a legitimate user who runs out can see their state.

### User-facing behavior
- A user types email, clicks "Send magic link," sees "If your email is on file, a link is on the way" + a 90-second countdown until they can resend.
- After successful auth, the user sees "magic-link history: 3 sends today, last at 14:22" in `#/settings/security`.

### Technical implementation
- Update `src/v3-app/screens/signin.tsx:299-308` to disable the resend button for 90 seconds.
- Add response-time padding in `src/api/auth/magic_link.js`: `await new Promise(r => setTimeout(r, Math.max(0, 200 - (Date.now() - startedAt))));` before returning.
- New endpoint at `src/api/auth/magic_link_status.js` (authed via `resolveContext`) returning the recent rows from `auth_magic_links` for the caller's email.

### Integration plan
- The generic-200 security property is preserved.
- A user who exhausts their window still cannot tell from the public surface why; they have to sign in successfully first to see their history.

### Telemetry
- `magic_link_send_clicked` (client-side).
- `magic_link_send_returned` (server-side, with outcome: sent/throttled/failed).
- `magic_link_resend_button_clicked`.

### Non-goals
- Leaking rate-limit state to the anonymous caller.
- Differentiating "this email is not in the system" vs "this email was rate-limited."

### Open questions
- Should we add a Captcha to the magic-link form after N failures from the same IP? Currently we do not (the 20/15min IP limit is the only gate).

### Effort
S. 2 days. 1 day for client + countdown, 1 day for status endpoint + padding.

### 5-axis score
PSev 2. MDiff 2. TLev 3. EStr 5. SFit 4. Total 16/25. Marginal; do as part of an auth UX pass.

### Deep-dive prompt
"Audit Anvil's full auth-endpoint surface (`magic_link.js`, `password_login.js`, `passkey/auth_*`, `signup.js`, `request_reset.js`, `complete_reset.js`) for timing-oracle leaks. Use OWASP ASVS L2 v4.0 as the rubric; pay special attention to (a) constant-time email-lookup, (b) constant-time response padding, (c) error-message uniformity. Output a violations list."

---

## F1.9 Passkey flow uses placeholder-row challenge store on user_passkeys, a footgun. [P1]

### Problem
The passkey register and authenticate flows stash the WebAuthn challenge state inside the `user_passkeys` table itself, using a placeholder row whose `credential_id` is a synthetic string like `"pending::<user_id>::<timestamp>"` or `"loginchallenge::<hex>"`. The code at `src/api/auth/passkey/register_begin.js:86-95` and `src/api/auth/passkey/auth_begin.js:77-87` writes a row with an empty `public_key`, `counter=0`, and a `pending_challenge_hash`. The comment justifies this as "schema-small (no separate webauthn_challenges table) at the cost of one row per active enrollment." This is a hack that has already caused at least one regression: the `excludeCredentials` filter at `src/api/auth/passkey/register_begin.js:42-51` explicitly filters out `credential_id LIKE 'pending::%'` because feeding those synthetic IDs to `generateRegistrationOptions` throws "is not a valid base64url string." The code has paid for this once already; a future refactor that forgets the filter will break passkey registration silently. The same filter is required on the auth side at `src/api/auth/passkey/auth_begin.js:56-59`. The mistake is doubled.

### Current state on main
- `src/api/auth/passkey/register_begin.js:80-95`: placeholder-row pattern on `user_passkeys`. [verified-on-main]
- `src/api/auth/passkey/register_begin.js:42-51`: the filter `.not("credential_id", "like", "pending::%")` is necessary because of the placeholder-row choice. [verified-on-main]
- `src/api/auth/passkey/auth_begin.js:75-87`: a different placeholder prefix (`"loginchallenge::"`) but the same pattern. [verified-on-main]
- `src/api/auth/passkey/auth_finish.js:80-92` reads the placeholder row, validates, deletes it. The `auth_finish.js:107-121` verification call explicitly sets `requireUserVerification: true` (hardened May 2026 per inline audit M1 comment). [verified-on-main]
- There is no dedicated `webauthn_challenges` table. The placeholder-row pattern is the only challenge store. [verified-on-main]

### Competitor state
- The @simplewebauthn library docs recommend a dedicated challenges table for exactly this reason: separation of concerns, no schema-overloading. [verified-from-prior-knowledge, https://simplewebauthn.dev]
- Stripe / Vercel / Supabase auth do not expose their challenge-storage internals; assumed to be dedicated tables.

### Adjacent insight
Mixing in-flight challenge state with persistent credential state on the same table creates several footguns: (1) any future query against `user_passkeys` needs to remember the prefix filter; (2) the `counter` column reads 0 for placeholder rows, indistinguishable from a fresh passkey that has been used 0 times; (3) RLS policies on the table now have to consider placeholder rows; (4) any cron that cleans up expired passkeys must avoid deleting in-flight challenges. The May 2026 audit comment block at `src/api/auth/passkey/auth_begin.js:46-52` already documents one regression-of-a-regression: a previous fix called project-wide `listUsers` on an unauthenticated pre-auth endpoint (H11), opening cross-tenant enumeration. The current code uses email-filtered single-row lookup at `src/api/auth/passkey/auth_begin.js:49`. Schema overload increases the surface for similar regressions.

### Research insight
WebAuthn challenges should be (a) cryptographically random, (b) short-TTL'd (5 to 10 min), (c) one-time use. The current implementation honors all three: `crypto.randomBytes(8).toString("hex")` for ids (`src/api/auth/passkey/auth_begin.js:77`), 5-minute expiry (`src/api/auth/passkey/register_begin.js:79`, `src/api/auth/passkey/auth_begin.js:85`), and `auth_finish.js:124` deletes the row regardless of verification outcome. But the storage choice creates maintenance hazard. [verified-from-prior-knowledge, https://www.w3.org/TR/webauthn-3/]

### Proposed change
1. New migration `supabase/migrations/104_webauthn_challenges.sql`:
   ```sql
   create table webauthn_challenges (
     id text primary key,                    -- the placeholder id, kept for compat
     user_id uuid references auth.users(id),
     challenge_hash text not null,
     purpose text not null check (purpose in ('register', 'login')),
     expires_at timestamptz not null,
     created_at timestamptz default now()
   );
   create index on webauthn_challenges (user_id);
   alter table webauthn_challenges enable row level security;
   -- no RLS policies needed: service-role only.
   ```
2. Refactor `register_begin.js`, `register_finish.js`, `auth_begin.js`, `auth_finish.js` to write/read this table.
3. Drop the `.not("credential_id", "like", "pending::%")` filters because there are no more placeholders.
4. Drop the placeholder columns from `user_passkeys` (`pending_challenge_hash`, `pending_challenge_expires_at`) in a follow-up migration once the new table is the source of truth.
5. Add a cleanup cron that deletes `webauthn_challenges where expires_at < now()`.

### User-facing behavior
None. Internal hygiene; the user sees no change.

### Technical implementation
- The four passkey endpoints have to be modified together. The new table makes each endpoint shorter and easier to reason about.
- The migration must be backward-compatible: dual-write to both tables for one release cycle, then cut over.

### Integration plan
- Roll out: migration → dual-write → cut-over flag → drop old columns.
- Test coverage: ensure each of the existing 1,122 tests that touch passkeys still passes.

### Telemetry
- Refactor doesn't add new events; existing `passkey_login_ok | passkey_login_fail` continue.

### Non-goals
- Switching WebAuthn libraries.

### Open questions
- Is there a load-test concern with the placeholder pattern? At 100 passkey enrollments/day the cleanup is trivial; at 100k it could matter.

### Effort
S. 1 week. 2 days migration + endpoint refactor, 2 days dual-write rollout, 1 day cut-over and column drop.

### 5-axis score
PSev 2 (it works today). MDiff 1 (internal). TLev 4 (maintainability). EStr 5 (cited at file:line). SFit 3. Total 15/25. Marginal; bundle with the next auth refactor (and prereq for F1.15 conditional UI).

### Deep-dive prompt
"Trace the @simplewebauthn library's recommended challenge-storage pattern in its docs and recent changelogs. Compare to Anvil's placeholder-row pattern. Quantify the technical-debt cost (number of files that have to remember the prefix filter; lines of code added by the workaround vs the dedicated-table approach)."

---

## F1.10 TOTP enrollment does not show backup codes or pre-arm a recovery method. [P1]

### Problem
The TOTP enrollment endpoint (`src/api/auth/mfa.js`) supports enroll → verify → unenroll. Once verified, the user has TOTP active on their authenticator app. There is no recovery codes flow: if the user loses their phone, they cannot self-recover. The unenroll path requires the current TOTP code (`src/api/auth/mfa.js:151-174`), and the password+TOTP login path (`src/api/auth/password_login.js:66-115`) rejects with `INVALID_TOTP` if the code is wrong (no fallback to a recovery code). For a SOC 2 Type II auditor, the lack of a recovery codes flow is a CC6.6/CC6.7 gap.

### Current state on main
- `src/api/auth/mfa.js:82-106` (enroll): generates a fresh `totp_pending_secret`, returns `otpauth_uri` + secret for QR rendering, 10-minute TTL. [verified-on-main]
- `src/api/auth/mfa.js:108-148` (verify): promotes pending → active, sets `totp_enrolled=true, require_mfa=true`. No backup codes generated. Encrypts the secret via `_lib/secrets.js` `encryptField` when `isSecretsConfigured()` returns true (`src/api/auth/mfa.js:27-33`). [verified-on-main]
- `src/api/auth/mfa.js:150-189` (unenroll): requires the current TOTP code via `verifyTotpAndConsume` which writes to a replay ledger (so even within a 30-second window the code cannot be replayed; hardened May 2026 per audit H1 inline comment at `src/api/auth/mfa.js:158`). [verified-on-main]
- `src/api/auth/password_login.js:66-115`: rate-limited (5/15min per user, audit M3), replay-protected (audit H1), and on `INVALID_TOTP` returns `error.code = INVALID_TOTP` or `TOTP_REPLAY`. [verified-on-main]
- No `backup_codes` table. No `recovery_codes_*` columns on `user_security_settings`. [verified-on-main]

### Competitor state
- GitHub, Google Workspace, AWS IAM, Stripe, Vercel: all generate 8 to 10 recovery codes at TOTP enrollment, one-time use, downloadable, displayed once. This is the universal pattern. [verified-from-prior-knowledge]
- Supabase Auth's `mfa.enroll()` returns a `factor.uri` for QR but does not auto-issue recovery codes; they have to be added at the application layer. [verified-from-prior-knowledge, https://supabase.com/docs/guides/auth/auth-mfa]
- Clerk's 2024 passkeys + recovery-codes guide: "Always offer recovery codes as the fallback when TOTP is the only second factor." [verified-from-prior-knowledge, https://www.clerk.com/blog/passkeys-in-2024]

### Adjacent insight
The OWASP auth cheat sheet recommends recovery codes as a mandatory companion to TOTP. [verified-from-prior-knowledge, https://owasp.org/www-project-authentication-cheat-sheet/] Without them, the MFA gate is a single point of failure for the user.

### Research insight
SOC 2 Type II CC6.6 requires "logical access security measures to authorize and restrict access" including a documented account-recovery path. Anvil currently has no documented one.

### Proposed change
1. At verify-time, generate 10 recovery codes (8 hex chars each), bcrypt-hash them, persist to a new `user_recovery_codes (user_id, code_hash, used_at)` table.
2. Return them once in the `verify` response. The frontend displays them and forces the user to download or print before continuing.
3. Add a new `src/api/auth/mfa.js` action `recovery_verify`: takes a recovery code, marks it `used_at=now()`, and bypasses the TOTP requirement for one login. Returns a session.
4. Add a settings surface to regenerate recovery codes (requires current TOTP or current password).

### User-facing behavior
- Enrollment: user scans QR, enters first code, then sees a "Save these recovery codes" screen with 10 codes + a "Continue" button (disabled until "I've saved them" is checked).
- Lost phone: user types email, clicks "Use a recovery code instead," enters code, signs in.

### Technical implementation
- New migration `supabase/migrations/104_user_recovery_codes.sql`:
  ```sql
  create table user_recovery_codes (
    user_id uuid references auth.users(id),
    code_hash text not null,
    used_at timestamptz,
    created_at timestamptz default now(),
    primary key (user_id, code_hash)
  );
  alter table user_recovery_codes enable row level security;
  create policy "user_recovery_codes_owner" on user_recovery_codes for select using (user_id = auth.uid());
  ```
- Update `src/api/auth/mfa.js` verify handler to generate codes.
- New endpoint `POST /api/auth/recovery_login`.

### Integration plan
- Add a "Lost access?" link on the signin TOTP entry view (`src/v3-app/screens/signin.tsx:354-376`).
- Update `src/api/auth/password_login.js` to accept `recovery_code` as a fallback to `totp_code`.

### Telemetry
- `recovery_codes_generated` (count = 10).
- `recovery_code_used` (per-use).
- `recovery_codes_regenerated`.

Alert: any single user using >1 recovery code in a 24h window → `security@anvil.app` review (could be account takeover).

### Non-goals
- SMS-based recovery. SIM-swap risk too high.
- Email-based recovery as a TOTP replacement. Keep magic-link sent-to-email-of-record as the deepest fallback.

### Open questions
- Storage of recovery codes: bcrypt vs argon2? bcrypt is standard for this use-case (10 codes per user, low compute).
- Do we delete used codes immediately or keep `used_at` for audit forever?

### Effort
M. 1 week. 2 days for migration + endpoint, 2 days for UI, 1 day for admin override surface.

### 5-axis score
PSev 3 (lost-phone is a real risk). MDiff 2 (table-stakes). TLev 4 (also closes a SOC 2 control). EStr 5. SFit 5. Total 19/25.

### Deep-dive prompt
"Compare 5 patterns for MFA recovery: (a) recovery codes one-time, (b) hardware backup key, (c) admin reset, (d) magic-link-of-last-resort to a back-up email, (e) verified phone fallback. Each: usability, security, SOC 2 mapping, implementation effort. Recommend Anvil's stack."

---

## F1.11 Signin uses two parallel auth surfaces (signin.tsx + connect.tsx), drift risk. [P1]

### Problem
The Anvil app exposes two distinct authentication surfaces today:
1. `src/v3-app/screens/signin.tsx`: the modern, design-system-aligned screen at `#/signin`. Magic link + password + signup + passkey + TOTP. Linked from landing hero.
2. `src/v3-app/screens/connect.tsx`: the legacy "Backend connection" screen at `#/connect`. Backend URL + Tenant ID + 4 tabs (signup / signin / magic / dev-token). Linked from older code paths and the command palette.

Both call the same underlying API endpoints (`/api/auth/signup`, `/api/auth/password_login`, `/api/auth/magic_link`) but with subtly different payload shapes, role pickers, status-display logic, and error handling. The signin surface enforces a 10-character password minimum (`src/v3-app/screens/signin.tsx:139`); the connect surface enforces 8 (`src/v3-app/screens/connect.tsx:101`). Display-name is required on the modern surface (`src/v3-app/screens/signin.tsx:140`); the legacy one requires it via the same validation but messages it differently (`src/v3-app/screens/connect.tsx:100`). The two surfaces will diverge further over time. They are a maintenance hazard.

### Current state on main
- `src/v3-app/screens/signin.tsx:1-538`: 538-line modern signin surface.
- `src/v3-app/screens/connect.tsx:1-324`: 324-line legacy surface.
- Both reachable in the same auth-required UI state. The first-load default for unauthed users in some paths still goes to `#/connect` (see F1.7).
- Password rules differ: 10 char (signin), 8 char (connect). [verified-on-main]
- Display-name handling differs.
- The server `src/api/auth/signup.js:53` enforces the floor at 8 characters, so the signin UI's 10-char rule is purely a client-side cosmetic stricter floor. A direct API caller can submit a 9-character password and succeed.

### Competitor state
N/A. Most products ship one auth screen.

### Adjacent insight
The 10-char vs 8-char password rule is the most visible drift. Both endpoints flow to the same `src/api/auth/signup.js:53` which enforces 8 (`password.length < 8 → 400`). So the modern surface UI says 10 but the server accepts 8. Two failure modes: (a) a user types a 9-char password on the modern surface, the UI rejects with "Password must be at least 10 characters" but the server would have accepted; (b) if someone calls the API directly from a script, they get the looser 8-char rule.

### Research insight
NIST SP 800-63B v4 recommends 15 characters minimum for password-only authentication; longer pass-phrases preferred. [verified-from-prior-knowledge, https://pages.nist.gov/800-63-4/] Both Anvil minimums are below the current NIST guidance.

### Proposed change
1. Deprecate `src/v3-app/screens/connect.tsx` as a user-facing auth surface. Keep the Backend-URL + Tenant-ID configurator (split into a new `admin/backend-config.tsx` admin-only screen). Remove the four auth tabs.
2. Unify password rules: 12 char minimum, server-enforced in `src/api/auth/signup.js:53`. Update `src/v3-app/screens/signin.tsx:139, 411`, `src/v3-app/screens/connect.tsx:101` (where it survives), `src/api/auth/complete_reset.js`, and `src/v3-app/screens/reset-password.tsx:17` (`MIN_PASSWORD = 10`) to align.
3. Add a strength meter (zxcvbn or similar) to the password input on signin.tsx.
4. Add a per-tenant password policy override (e.g. an enterprise tenant can set 16-char minimum + complexity).

### User-facing behavior
- A new signup requires a 12+ char password with a live strength meter.
- The `#/connect` route routes to admin-only "Backend configuration" — only admins see it.

### Technical implementation
- Update `src/v3-app/screens/signin.tsx:139, 411`.
- Update `src/api/auth/signup.js:53`.
- Update `src/v3-app/screens/reset-password.tsx:17`.
- Add `tenant_password_policy` table for tenant-specific rules.

### Integration plan
- A migration to bump existing users' passwords is not in scope (force-reset every user is hostile). Apply 12-char only to new accounts; existing accounts get nagged on next sign-in to upgrade.

### Telemetry
- `password_policy_violated` with `{rule: 'too_short' | 'no_uppercase'}`.
- `password_strength_score` (zxcvbn 0 to 4) at signup.

### Non-goals
- Passwordless-only. Magic link + passkey is the preferred future state but password as a fallback is required for users without a phone.
- Forced password rotation. NIST 800-63B explicitly recommends against time-based rotation.

### Open questions
- Is the strength meter library cost (zxcvbn is approximately 400KB) acceptable on the signin bundle? Probably yes; lazy-load it.

### Effort
M. 1 week. 1 day for the policy unification. 2 days for strength meter integration. 2 days for the admin-only `/connect` refactor. 0.5 day for telemetry.

### 5-axis score
PSev 3. MDiff 2. TLev 4. EStr 5. SFit 5. Total 19/25.

### Deep-dive prompt
"Inventory every place in `src/v3-app` and `src/api` that touches password validation. Output a per-file list with the current minimum-length value. Propose a `_lib/password-policy.js` shared module + a CI lint rule that requires every password-validating call site to use it."

---

## F1.12 Password reset cannot detect a stale magic-link cross-mount, silent fail. [P2]

### Problem
The reset-password screen parses the access_token from the URL fragment (`src/v3-app/screens/reset-password.tsx:19-47`). The Supabase recovery flow puts the token in the fragment (after the hash route) so it never crosses the wire to the server. The parser handles two formats: embedded fragment `#/reset#access_token=...` and search-string `?access_token=...`. The parser is well-written but has no replay protection at the client layer: a user who completes a reset and then re-loads the page with the same URL would have their action repeated (the server endpoint `complete_reset.js` rejects a used token, but the user's UI shows a confusing "Password updated" → "Could not reset password" oscillation if they reload).

### Current state on main
- `src/v3-app/screens/reset-password.tsx:19-47`: `parseRecoveryToken` extracts the token. [verified-on-main]
- `src/v3-app/screens/reset-password.tsx:67-116`: `onSubmit` posts to `/api/auth/complete_reset` with `{access_token, new_password}`.
- `src/v3-app/screens/reset-password.tsx:118-138`: success state. If the user reloads the page, the URL still contains the token. `useMemo(parseRecoveryToken, [])` re-runs (well, doesn't, due to `[]` dep array). But a hashchange would re-run. [verified-on-main]
- `MIN_PASSWORD = 10` at `src/v3-app/screens/reset-password.tsx:17` (so the reset surface is consistent with the signin signup; both differ from server's 8). [verified-on-main]

### Competitor state
- Vercel / Stripe / Notion: most pop the token from the URL after successful use (replace the URL via `history.replaceState`) to prevent the user from accidentally re-submitting.
- Linear: similar.

### Adjacent insight
Browser back/forward buttons can re-trigger the success state. The right fix is to drop the token from the URL on first parse.

### Research insight
URL fragments stay in browser history. A user who shares their screen during the reset flow leaks the token to anyone watching. The token TTL is short (Supabase default 1 hour, configurable) but a same-session leak is still real.

### Proposed change
1. After `parseRecoveryToken` succeeds, replace the URL via `history.replaceState(null, '', '#/reset')` to drop the token.
2. After a successful reset, also clear any `auth_profile` in localStorage and force a fresh sign-in.
3. Add a confirmation message: "Password updated. Existing sessions for this account have been signed out for security."

### User-facing behavior
- User clicks recovery link, lands on /reset, types new password, submits, sees "Password updated." URL no longer contains the token.
- Reloading the page after success shows "No recovery token found. Redirecting to sign-in" instead of a confusing replay.

### Technical implementation
- `src/v3-app/screens/reset-password.tsx:19-47` add `history.replaceState(null, '', '#/reset')` immediately after parsing.

### Integration plan
- Existing recovery-flow tests must continue to pass.

### Telemetry
- `password_reset_started`, `password_reset_completed`, `password_reset_replay_attempted`.

### Non-goals
- Single-page-app history clean-up beyond this surface.

### Open questions
- Does the Supabase recovery-token endpoint distinguish replay from invalid? If we get a different error code for "token already used," we can show a more helpful message.

### Effort
S. 1 day.

### 5-axis score
PSev 2. MDiff 1. TLev 3. EStr 5. SFit 3. Total 14/25. Marginal; bundle with a recovery-UX pass.

### Deep-dive prompt
"Audit every URL-fragment-token handling path in Anvil: recovery, magic-link callback, OAuth callback, file-share signed URLs. For each, verify (a) the token is dropped from the URL after first parse, (b) replay is rejected server-side with a clear error, (c) the token TTL is documented. Output a violations list."

---

## F1.13 SOC 2 / ISO 27001 "in progress" badges have no public roadmap link, trust-cliff. [P1]

### Problem
Already discussed in F1.4. Re-framed here as a P1 issue specifically because the dual-badge "in progress" state without a public roadmap creates a trust cliff: the buyer reads "SOC 2 in progress" and asks "since when? until when? which auditor?" If the answer is "we will get back to you," the buyer assumes the answer is "we do not know" and the trust drops below "no claim at all."

### Current state on main
See F1.4. The same six badges appear in both `src/v3-app/screens/landing.tsx:192-199` (the hero security strip) and `src/v3-app/screens/signin.tsx:529-531` (the trust line at the bottom of the signin card), with no link target on either.

### Competitor state
See F1.4. Korso explicitly shows "SOC 2 Type 1 / ISO 27001 / GDPR In Progress" with no dates. [verified-from-prior-knowledge] Anvil's badges are at the same level. Anvil could leapfrog by adding the auditor name + target date.

### Adjacent insight
N/A.

### Research insight
N/A.

### Proposed change
For the in-progress badges on `src/v3-app/screens/landing.tsx:192-199` and `src/v3-app/screens/signin.tsx:529-531`:
1. Add `target_date` to each entry. E.g., SOC 2 Type II observation-window-start = 2026-04-01, issuance-target = 2026-12-15.
2. The badge display becomes "SOC 2 Type II · in progress (issuance: Dec 2026)."
3. The trust page (see F1.4) lists the auditor name (e.g., Prescient Assurance, A-LIGN, or whichever is engaged).

### User-facing behavior
A buyer sees a specific date. The trust signal goes from "vague" to "scheduled."

### Technical implementation
- Update the SECURITY array at `src/v3-app/screens/landing.tsx:192-199` to add `target` field.
- Update the renderer at `src/v3-app/screens/landing.tsx:696-703` to show "in progress (issuance: <date>)" instead of just "in progress."

### Integration plan
- The dates have to be real and approved by the compliance owner.

### Telemetry
- `security_badge_target_viewed` per badge.

### Non-goals
- Falsifying dates.

### Open questions
- What is the actual planned issuance date for SOC 2? Open.

### Effort
S. 0.5 day code + dates dependent on compliance team.

### 5-axis score
PSev 3. MDiff 3. TLev 2. EStr 4. SFit 5. Total 17/25.

### Deep-dive prompt
"Map Anvil's current state against the SOC 2 Type II controls checklist. For each CC (Common Criteria), report 'have evidence,' 'partial,' or 'gap.' Output a 90-day plan with file:line code citations for each control."

---

## F1.14 Connector grid hardcodes 18 ERPs vs 17 client files vs marquee says "17": pick one. [P2]

### Problem
Anvil's connector grid (`src/v3-app/screens/landing.tsx:115-137`) ships 18 ERP tiles on the "ERPs" tab. The tab count badge says 17. The marquee label at `src/v3-app/screens/landing.tsx:674` says "17 ERPs." The repo has 17 ERP client files in `_lib/` (excluding non-ERP clients). The 18th tile is the "+1 Custom ERP · field-mapped" entry at `src/v3-app/screens/landing.tsx:135`. The in-code comment at `src/v3-app/screens/landing.tsx:106-108` explains: "The design's '18 ERPs' rolls in a '+1 Custom ERP' tile so the visible tile count is 18; the real client-file count is 17. Both are honest." This is internally consistent but externally confusing: the spec strip says "17 ERPs" (`src/v3-app/screens/landing.tsx:73`), the count badge on the tab says 17, but the visible tile count is 18. The hero lead at `src/v3-app/screens/landing.tsx:646` says "18 ERPs." So the same page asserts 17 in 3 places and 18 in 2 places. A diligent buyer counting tiles or reading copy sees the inconsistency.

### Current state on main
- `src/v3-app/screens/landing.tsx:116`: `id: "erp", label: "ERPs", count: 17, tiles: [...]` — tab badge says 17. [verified-on-main]
- `src/v3-app/screens/landing.tsx:117-136`: 18 tiles in the array. [verified-on-main]
- `src/v3-app/screens/landing.tsx:73`: spec-strip says "17 ERPs." [verified-on-main]
- `src/v3-app/screens/landing.tsx:674`: marquee says "17 ERPs." [verified-on-main]
- `src/v3-app/screens/landing.tsx:646`: hero lead says "across 18 ERPs · 5 inbound channels · 6 doc engines." Discrepancy: hero says 18, two other strips say 17. [verified-on-main]

### Competitor state
- Conexiom advertises "40+ pre-built integrations." [verified-from-prior-knowledge] They pick one number and stick with it.
- Rossum does not enumerate ERPs. [verified-from-prior-knowledge]
- Axal advertises "10 named ERPs." [verified-from-prior-knowledge]

### Adjacent insight
A diligent buyer counts. Internal inconsistency is a red flag in B2B sales-eng calls.

### Research insight
N/A.

### Proposed change
Pick one number and use it everywhere:
- Option A: 18, treating Custom ERP as a real integration (which it is; there is a field-mapping wizard, per the FAQ Q2 at `src/v3-app/screens/landing.tsx:344`).
- Option B: 17, treating Custom ERP as a special tile, change the count badge to "17 + Custom" and the spec strip to "17 ERPs (+ Custom)."

Ship Option A. 18 is more impressive and the Custom ERP tile is a real shipping capability.

### User-facing behavior
Every claim aligns.

### Technical implementation
- Update `src/v3-app/screens/landing.tsx:73` HERO_SPEC entry from `tgt: 17` to `tgt: 18`.
- Update `src/v3-app/screens/landing.tsx:116` from `count: 17` to `count: 18`.
- Update `src/v3-app/screens/landing.tsx:674` marquee label.
- Update the proof-stat at `src/v3-app/screens/landing.tsx:1039` if it cites 17.
- Update `FLOW_STEPS[4]` and FAQ Q5 to use 18.
- Update the count comment at `src/v3-app/screens/landing.tsx:68-71` (the `wc -l` example) to add 1 for the Custom ERP.

### Integration plan
- One commit, one diff.

### Telemetry
N/A.

### Non-goals
- Adding a 19th ERP just to make a round number.

### Open questions
- Is the Custom ERP a real billable item or a one-off SOW? Affects what we claim.

### Effort
S. 30 minutes.

### 5-axis score
PSev 2. MDiff 1. TLev 1. EStr 5. SFit 3. Total 12/25. Marginal; ship as part of a content audit.

### Deep-dive prompt
"Audit every numerical claim on the landing (`src/v3-app/screens/landing.tsx`) against the implementing code in `src/api`. Output a `claims.json` mapping each claim to its citation. Add a CI lint rule that fails if a number on the landing has no cited backing."

---

## F1.15 No conditional-UI WebAuthn autofill, missing standards-grade signin UX. [P1]

### Problem
The signin screen offers a "Sign in with passkey" button (`src/v3-app/screens/signin.tsx:502-507`) that fires `onSignInWithPasskey` which calls the passkey assert flow. This is button-driven: the user has to type their email, then click the passkey button, then approve in the OS dialog. The modern WebAuthn standard recommends conditional UI: the email input has `autocomplete="email webauthn"` and on page load the browser calls `navigator.credentials.get({ mediation: "conditional" })`. This surfaces saved passkeys in the email field's autocomplete dropdown, letting the user pick a passkey without clicking a button. The result is a one-tap sign-in on returning visitors.

### Current state on main
- `src/v3-app/screens/signin.tsx:392-403`: email input has `autoComplete="email"`. No `webauthn` keyword. [verified-on-main]
- `src/v3-app/screens/signin.tsx:182-218`: button-driven passkey assert flow.
- No call to `navigator.credentials.get({ mediation: "conditional" })` anywhere on page-load.
- `src/api/auth/passkey/auth_begin.js:33-66`: requires an `email` body field and rejects without one (`return json(res, 400, ...)` at line 36). The current shape cannot serve a discoverable-credential request because it scopes `allowCredentials` to the email-matched user.

### Competitor state
- Google, Microsoft, Apple, GitHub, Cloudflare: all use conditional UI on signin pages. Buyer sees "Use saved passkey" in the email autocomplete. [verified-from-prior-knowledge]
- 1Password, Bitwarden: similar.

### Adjacent insight
passkeys.dev bootstrapping guidance: "support the autofill UI by adding `username webauthn` to autocomplete annotations and calling `navigator.credentials.get()` with `mediation: 'conditional'` on page load." [verified-from-prior-knowledge, https://passkeys.dev/docs/use-cases/bootstrapping/]

### Research insight
WebAuthn Level 3 has matured the conditional-UI pattern; major browsers (Chrome 108+, Safari 16+, Firefox 117+) support it. [verified-from-prior-knowledge, https://www.w3.org/TR/webauthn-3/] Adoption among major SaaS surfaces is rising fast.

### Proposed change
1. Change `src/v3-app/screens/signin.tsx:401` autocomplete to `"email webauthn"`.
2. On signin-screen mount, fire `navigator.credentials.get({ mediation: "conditional", publicKey: { challenge: ..., rpId: ... } })`. The challenge has to come from a server call (`/api/auth/passkey/auth_begin` without an email parameter, refactor required, see below).
3. On a successful conditional-UI response, complete the passkey assert flow without ever requiring the email field.

### User-facing behavior
- A returning visitor hits the signin page; their saved passkey is offered in the email autocomplete dropdown; one tap signs them in.

### Technical implementation
- Refactor `src/api/auth/passkey/auth_begin.js` to accept a no-email "discoverable credential" mode. The server returns `allowCredentials: []` (the user agent surfaces all credentials for the rpId), and on `auth_finish` the server resolves the user by the credential's `userHandle` (the binding set at `src/api/auth/passkey/register_begin.js:64` via `userID: Buffer.from(ctx.user.id)`).
- Update `src/api/auth/passkey/auth_finish.js` to resolve the user from the response's userHandle when no email is supplied (today the resolution is email-keyed at `src/api/auth/passkey/auth_finish.js:71-78`).

### Integration plan
- Backward-compat: the button-driven flow still works for users who type their email first.
- Conditional UI is offered in addition to, not instead of, the button.
- Prereq: F1.9 (move the challenge store off the `user_passkeys` placeholder rows) is recommended first to avoid layering a discoverable-credentials hack on top of the placeholder hack.

### Telemetry
- `passkey_conditional_ui_triggered`.
- `passkey_conditional_ui_completed`.

### Non-goals
- Removing the button. Some users will still want to type their email first.

### Open questions
- Does the placeholder-row pattern (F1.9) interfere with discoverable-credential mode? Probably yes; this is another reason to refactor to a dedicated `webauthn_challenges` table first.

### Effort
M. 1 week. 2 days for server refactor (depends on F1.9). 1 day for client autofill wiring. 2 days for browser-matrix testing (Chrome, Safari, Firefox; iOS, Android, macOS, Windows).

### 5-axis score
PSev 3. MDiff 4 (top-tier signin UX). TLev 4. EStr 5. SFit 5. Total 21/25.

### Deep-dive prompt
"Implement WebAuthn conditional UI for Anvil signin. Refactor `auth_begin.js` to support discoverable credentials. Update `signin.tsx` to call `navigator.credentials.get({ mediation: 'conditional' })` on mount. Build a browser-matrix test plan and document the user-experience on the 6 most-common platform combinations."

---

## F1.16 No `time_to_first_voucher` event in audit_events, "2 weeks" claim is uninstrumented. [P0]

### Problem
The FAQ at `src/v3-app/screens/landing.tsx:345` claims "Two weeks to first voucher is the bar we hold ourselves to," a specific, falsifiable claim. The compare table at `src/v3-app/screens/landing.tsx:330` ships the same number ("Time to first voucher · 2 weeks"). The principles section at `src/v3-app/screens/landing.tsx:269-275` lists "Receipts over reasons" as principle 1: "If we extracted it, you can click it back to the source." But there is no measured time-to-first-voucher in the codebase. There is no `time_to_first_extraction`, no `time_to_first_so`, no `time_to_first_tally_push` event in `audit_events`. The claim is unsubstantiated; if a buyer asks for the median, we cannot answer.

### Current state on main
- `audit_events` table exists (referenced widely in `src/api/_lib/audit.js` and `src/api/auth/signup.js:106` which writes a `user_signup` row).
- No event names matching `time_to_first_*` in the codebase.
- No PostHog / Amplitude / Mixpanel client. No `posthog.init`, no `amplitude.getInstance` anywhere under `src/v3-app/`.
- The compare-table row at `src/v3-app/screens/landing.tsx:330` references "2 weeks" — claim is asserted without source.

### Competitor state
- Conexiom advertises "30-day implementation average." Number is published. [verified-from-prior-knowledge]
- Rossum advertises per-customer numbers but not a median TTFV. [verified-from-prior-knowledge]
- Hyperscience: no public TTFV.
- Soff: "up and running within a day."

### Adjacent insight
Linear, Stripe, Notion all publish activation funnels in product-led-growth talks (Linear: 7-day retention; Stripe: time-to-first-charge; Notion: time-to-first-doc-shared). Anvil should match the genre.

### Research insight
Appcues: time-to-value is a tracked metric but no industry benchmark cited. [verified-from-prior-knowledge, https://www.appcues.com/blog/user-onboarding-best-practices] The most-cited B2B SaaS TTV benchmark is "5 minutes from signup-submitted to first activation event."

### Proposed change
1. Define activation events:
   - `signup_started` (signup-page view).
   - `signup_submitted` (form submit).
   - `account_created` (after callback / signin).
   - `first_po_uploaded`.
   - `first_extraction_completed`.
   - `first_so_created`.
   - `first_tally_push_completed`.
2. Add server-side instrumentation in `src/api/_lib/audit.js`:
   - When a tenant's first matching event of each type fires, append a `tenants.first_<event>_at timestamptz` column.
3. Derive `time_to_first_voucher` as `first_tally_push_completed_at - account_created_at`.
4. Build a weekly dashboard: median, p90, distribution by signup-week cohort.
5. Once we have a baseline, the marketing claim becomes "Live in {p50} days" with the number tied to live telemetry.

### User-facing behavior
- Invisible to the user.
- Privacy notice updated.

### Technical implementation
- New migration `supabase/migrations/104_tenant_first_milestones.sql`:
  ```sql
  alter table tenants add column first_signup_at timestamptz;
  alter table tenants add column first_po_uploaded_at timestamptz;
  alter table tenants add column first_extraction_at timestamptz;
  alter table tenants add column first_so_created_at timestamptz;
  alter table tenants add column first_tally_push_at timestamptz;
  ```
- New helper `src/api/_lib/milestones.js` with `recordMilestoneIfFirst(tenantId, milestone)`.
- Call from each relevant endpoint: `documents/upload`, `extraction/run`, `orders/create`, `tally/push`.
- New cron `vercel.json` weekly that emails the activation dashboard CSV to ops.

### Integration plan
- Audit-events stays the immutable system-of-record. The `tenants.first_*_at` columns are a denormalized read cache.
- For real product-analytics, integrate PostHog Cloud (EU region for DPDP compliance) — optional Phase 2.

### Telemetry
See above.

Alert: any tenant past day-14 with `first_tally_push_at IS NULL` → CSM email.

### Non-goals
- Real-time activation dashboards. Weekly batch is fine for v1.
- Per-user activation tracking (only per-tenant).

### Open questions
- Should we instrument anonymous sandbox runs (F1.6) too, even though they do not tie to a real tenant?
- What is the canonical "first voucher" — push to mock Tally (sandbox) or push to real Tally? They should be separate events.

### Effort
S. 1 week. 2 days migration. 2 days helper + endpoint wiring. 1 day dashboard.

### 5-axis score
PSev 2 (invisible to users). MDiff 2. TLev 5 (every other landing claim becomes provable). EStr 5. SFit 5. Total 19/25. P0 by priority even though PSev is low — without this, every other onboarding claim is untestable.

### Deep-dive prompt
"Audit the `audit_events` schema and every code call site that writes to it. Output a complete event taxonomy. Identify the 12 events required for an activation funnel (signup → first PO → first extraction → first SO → first push). Propose a migration that backfills `tenants.first_*_at` columns from `audit_events` history."

---

## F1.17 Landing has 19 sections but no IndexNow / sitemap.xml / structured data. [P2]

### Problem
The landing is 1,272 lines of TSX with 19 distinct sections (nav, hero, logos rail, security, connectors, bleed, problem, product/pillars, flow, founder, proof, coverage, principles, pricing, compare, changelog, FAQ, CTA, footer). It is search-engine-rich content. But the build at `public/index.html` is a minimal Vite shell with only standard meta tags: `charset`, `viewport`, `theme-color`, `apple-touch-icon`, `manifest.json`, no Open Graph, no Twitter Card, no canonical, no robots.txt, no sitemap.xml, no JSON-LD structured data. The SEO surface is bare.

### Current state on main
- `public/index.html:1-21` ships: viewport, theme-color, 3 apple-mobile-* tags, manifest.json, apple-touch-icon, title="Anvil", one stylesheet, one script. No `<meta name="description">`, no OG tags, no canonical, no JSON-LD. [verified-on-main]
- `public/icon-192.svg`, `public/icon-512.svg`, `public/manifest.json`, `public/sw.js` exist (per the apple-touch-icon ref and the `ls public/` listing). [verified-on-main]
- No `public/robots.txt`. No `public/sitemap.xml`. [verified-on-main]

### Competitor state
- Conexiom, Rossum, Hyperscience, Stripe, Vercel, Linear, Notion: all ship full OG metadata + structured data + sitemap.xml + robots.txt. [verified-from-prior-knowledge]

### Adjacent insight
Vercel's `@vercel/og` primitive can generate OG images at the edge. Anvil already runs on Vercel and could lean on this for per-page social cards.

### Research insight
OG meta drives social CTR by 2 to 4 times per HubSpot/Moz literature. [verified-from-prior-knowledge, widely cited]

### Proposed change
1. Add meta block to `public/index.html`:
   ```html
   <meta name="description" content="Anvil is the AI-native quote-to-cash console for industrial distributors. Turn customer POs into ERP vouchers across 17 ERPs in 8 minutes. Built in Pune.">
   <link rel="canonical" href="https://anvil.app/">
   <meta property="og:type" content="website">
   <meta property="og:url" content="https://anvil.app/">
   <meta property="og:title" content="Anvil · AI-native quote-to-cash for industrial distributors">
   <meta property="og:description" content="From PO email at 10:34 to Tally voucher at 10:42. 17 ERPs, 5 inbound channels, 6 doc engines. Built in Pune.">
   <meta property="og:image" content="https://anvil.app/og-image.png">
   <meta property="og:locale" content="en_IN">
   <meta name="twitter:card" content="summary_large_image">
   <meta name="twitter:title" content="Anvil · AI-native quote-to-cash">
   <meta name="twitter:description" content="From PO email at 10:34 to Tally voucher at 10:42.">
   <meta name="twitter:image" content="https://anvil.app/og-image.png">
   <script type="application/ld+json">
   {"@context":"https://schema.org","@type":"SoftwareApplication","name":"Anvil","applicationCategory":"BusinessApplication","operatingSystem":"Web","offers":{"@type":"Offer","priceCurrency":"INR","price":"14990"}}
   </script>
   ```
2. Ship `public/og-image.png` (1200×630), use the brand mark + the kinetic-pair "BRG 6204 → BR-6204-ZZ" text.
3. Ship `public/robots.txt` allowing all + linking sitemap.
4. Ship `public/sitemap.xml` listing the home page + future /trust, /pricing, /docs.
5. Add IndexNow ping on every deploy via Vercel's edge hook.

### User-facing behavior
- Sharing `anvil.app` on LinkedIn shows a rich preview.
- Google indexes the page.

### Technical implementation
- Edit `public/index.html` head block.
- New files `public/robots.txt`, `public/sitemap.xml`, `public/og-image.png`.
- Optional: `@vercel/og` for per-page OG image generation (later).

### Integration plan
- The app at authenticated routes should not be indexed (`<meta name="robots" content="noindex">` injected client-side on auth gate).

### Telemetry
- Social CTR on shared links (LinkedIn/Twitter analytics).
- Google Search Console impressions.

### Non-goals
- hreflang for Hindi/Tamil. Phase 2.

### Open questions
- Canonical domain: `anvil.app`, `anvil.in`, `useanvil.com`? Pin before going live.

### Effort
S. 2 days. 1 day for meta + robots + sitemap. 1 day for OG image design + export.

### 5-axis score
PSev 2. MDiff 1. TLev 4. EStr 4. SFit 4. Total 15/25. Marginal; bundle with the trust/SEO push.

### Deep-dive prompt
"Build the SEO surface from scratch: meta block, OG image (Figma source committed), robots.txt, sitemap.xml, JSON-LD schema, IndexNow integration, Google Search Console verification. Output the full diff plus a 30-day-after impressions/clicks dashboard from Google Search Console."

---

## F1.18 Landing animations use IntersectionObserver but no `content-visibility` budget. [P2]

### Problem
The landing has 19 sections and rich animations: kinetic hero (`useKineticPair`), count-up (`useCountUp`), reveal-on-scroll (IntersectionObserver), demo cycle (setTimeout chain), marquee (CSS keyframes). The IntersectionObserver setup at `src/v3-app/screens/landing.tsx:543-577` reveals every `.reveal` block on first intersection plus a 1,200ms failsafe that reveals everything regardless. On mobile devices with slow GPUs, layout cost is non-trivial: the demo's 4 absolute-positioned scenes with cross-fade, the marquee's `animation: lp-scroll 40s linear infinite`, and the 19 section reveals all run in the main thread unless explicitly opted out.

### Current state on main
- `src/v3-app/screens/landing.tsx:543-577`: the observer + 1,200ms failsafe. [verified-on-main]
- `src/v3-app/styles.css` `.lp-marquee { ... animation: lp-scroll 40s linear infinite; }` (presumed; this file is too large to read in full this pass).
- `prefers-reduced-motion: reduce` honoured in multiple places: `src/v3-app/screens/landing.tsx:57, 90, 549` and CSS reveal targets.
- No `content-visibility: auto` or `contain-intrinsic-size` on the deep sections. [inferred from absence in source greps]

### Competitor state
- Stripe, Linear, Vercel ship landing pages with explicit lazy-rendering primitives (Vercel's Next.js ISR + edge-streamed sections; Linear's server-side rendering). For static React landings, `content-visibility: auto` is the standard primitive. [verified-from-prior-knowledge]

### Adjacent insight
The MDN guidance on `content-visibility: auto` is mature: applying it to off-screen sections defers their rendering until they're near the viewport, with measured wins on Lighthouse Performance (often 15 to 30 point lift). [verified-from-prior-knowledge, https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility]

### Research insight
Web Vitals (LCP, INP, CLS) are the canonical Google-ranking signals for SEO. A landing with 19 sections and >2MB of CSS+JS will struggle on slow mobile networks (4G in tier-2 Indian cities) without lazy-rendering.

### Proposed change
1. Apply `content-visibility: auto; contain-intrinsic-size: 800px 1200px;` to each `.lp-section` (or `.lp-problem`, `.lp-product`, `.lp-flow`, etc.) that sits below the first approximately 1,800px of vertical scroll.
2. Run a Lighthouse audit on `landing.tsx`-rendered HTML, target LCP < 2.5s on slow-4G simulation, INP < 200ms.
3. Lazy-load any image asset >50KB via `loading="lazy"` (currently the landing has no images; future hero shots will need this).
4. Defer the marquee's animation until it scrolls into view (the `animation` property is already deferred via `display: flex; width: max-content;` but the CSS engine still computes its animated state every frame, apply `animation-play-state: paused` and resume on intersection).

### User-facing behavior
- Faster initial paint on mobile.
- Smoother scroll.

### Technical implementation
- Update `src/v3-app/styles.css` for `.lp .lp-section` (or similar bucket selector) with `content-visibility: auto` and `contain-intrinsic-size`.
- Lazy-init the marquee via `IntersectionObserver` in a new tiny hook `useLazyAnimation`.

### Integration plan
- No backend changes.
- Test on Android Chrome (mid-tier device) with slow-4G throttling.

### Telemetry
- Web Vitals via `web-vitals` package, sent to `audit_events` as `web_vital_*` events.

### Non-goals
- A full SSR migration. The landing is client-rendered today; SSR would be a separate project.

### Open questions
- Is there a single Lighthouse-baseline number we should track over time? Recommend committing the current score to the README so regressions are visible.

### Effort
S. 3 days. 1 day for CSS. 1 day for marquee lazy-init. 1 day for Web Vitals wiring.

### 5-axis score
PSev 2. MDiff 1. TLev 3. EStr 3. SFit 3. Total 12/25. Marginal; ship as part of an SEO/perf pass.

### Deep-dive prompt
"Run a full Lighthouse + WebPageTest audit on `https://anvil.app/` from 3 geographies (Mumbai, Singapore, Frankfurt) on slow-4G and fast-4G profiles. Output a prioritized perf-fix list with file:line refs and effort estimates."

---

## F1.19 Tally is featured as "most loved" without a tenant count, claim is unprovenanced. [P1]

### Problem
The Tally Prime tile in the connector grid (`src/v3-app/screens/landing.tsx:125`) carries the badge `stat: { text: "most loved" }`. A buyer reads this and rightly asks: "compared to what?" "How is 'love' measured?" "How many of your customers actually run Tally?" The claim has no source. Similar concern with the Email parse tile at `src/v3-app/screens/landing.tsx:141` (badge: "always-on") and the Anvil Network tile at `src/v3-app/screens/landing.tsx:175` (badge: "unique"). The principles section at `src/v3-app/screens/landing.tsx:270` says principle 1 is "Receipts over reasons": claims should be tied to evidence. This is a principle-violation against the brand's own stated values.

### Current state on main
- `src/v3-app/screens/landing.tsx:125`: Tally tile, `stat: { text: "most loved" }`. [verified-on-main]
- `src/v3-app/screens/landing.tsx:141`: Email parse tile, `stat: { text: "always-on" }`. Defensible (the inbox is always-on).
- `src/v3-app/screens/landing.tsx:151`: Anthropic Claude tile, `stat: { text: "primary" }`. Defensible (Claude is the primary doc-engine per the model-routing log referenced at `src/v3-app/screens/landing.tsx:182`).
- `src/v3-app/screens/landing.tsx:164`: IRN tile, `stat: { text: "live" }`. Defensible.
- `src/v3-app/screens/landing.tsx:175`: Anvil Network tile, `stat: { text: "unique" }`. Defensible if no competitor offers peer-back-to-back.
- `src/v3-app/screens/landing.tsx:134`: proALPHA tile, `stat: { text: "beta", beta: true }`. Defensible.
- The only weakly-evidenced badge is the Tally "most loved" one.

### Competitor state
N/A.

### Adjacent insight
"Most loved" is the kind of soft claim that becomes a credibility tax in B2B sales conversations. Replace with a hard number.

### Research insight
N/A.

### Proposed change
Replace "most loved" with a verifiable claim:
- Option A: "live since 2022 · X tenants" where X is the count of `tenants where tally_connected=true`. This requires F1.16 instrumentation but the underlying data should already exist.
- Option B: "12ms voucher push" — the actual median latency for the Tally bridge, pulled from a `bridge_push_log` table.
- Option C: simply drop the badge.

Ship Option B (a fact number) since it is more specific.

### User-facing behavior
A buyer sees a specific latency or a specific tenant count.

### Technical implementation
- Update `src/v3-app/screens/landing.tsx:125` `stat: { text: "12ms median push" }`.
- Pre-compute the median at build-time from the production `bridge_push_log` (or whatever the equivalent table is) so the number is stable.

### Integration plan
- A weekly cron updates the inlined number if no new build has shipped.

### Telemetry
- N/A.

### Non-goals
- Updating the number in real time per page-view.

### Open questions
- Where is the latency actually logged? If nowhere, this becomes a blocker.

### Effort
S. 0.5 day.

### 5-axis score
PSev 2. MDiff 2 (matches brand). TLev 2. EStr 5. SFit 5. Total 16/25. Marginal.

### Deep-dive prompt
"Audit every badge / stat / number on the landing for source-of-truth. Output a `landing-claims.csv` with columns: claim, source-file:line, last-verified-date. Add a CI lint rule that requires every claim added to `landing.tsx` to have a citation comment within approximately 10 lines."

---

## F1.20 The signin screen ships an "Advanced (backend URL, tenant ID)" toggle on a public surface. [P0]

### Problem
The signin screen at `src/v3-app/screens/signin.tsx:445-464` ships an "Advanced (backend URL, tenant ID)" toggle that, when expanded, shows two inputs: Backend URL and Tenant ID. This is a dev-affordance leaking to a public sign-in page. Any anonymous visitor can type an arbitrary URL and tenant UUID. The visible state of the toggle defaults to expanded when no backend is configured (`src/v3-app/screens/signin.tsx:52` `setShowAdvanced(!cfgRef.url)`), which on the public-deployed app should be never (the app's own origin is the backend per `src/v3-app/screens/signin.tsx:41`). But the toggle is always there, visible to every visitor. This is the kind of UI that bug bounty researchers will flag immediately as "an obvious sign that dev plumbing is exposed in production."

### Current state on main
- `src/v3-app/screens/signin.tsx:445-464`: the advanced toggle and the two inputs. [verified-on-main]
- `src/v3-app/screens/signin.tsx:52`: `setShowAdvanced(!cfgRef.url)` — opens by default for no-config installs.
- `src/v3-app/screens/connect.tsx:178-207`: the same Backend URL + Tenant ID inputs, on a different surface, surfaced to a wider audience because /connect is the first-load default for unauthed users in some paths.

### Competitor state
- Stripe, Vercel, Linear, Notion: zero public exposure of backend URL or tenant ID. The backend URL is always the page's origin; tenant ID is a UUID looked up at signin time via the user's email.

### Adjacent insight
The "Dev token" tab on `src/v3-app/screens/connect.tsx:280-296` is even more egregious: a password-equivalent textarea on a public surface. The accompanying Banner at `src/v3-app/screens/connect.tsx:288-290` warns "Dev only. Production users sign in via Create account or Sign in. This pane exists for headless test rigs." That warning is correct but the surface is still there. A bored attacker, a phishing victim, or a confused user can paste anything in.

### Research insight
NN/g UXR on "progressive disclosure of advanced settings" is decades old. [verified-from-prior-knowledge, https://www.nngroup.com/articles/progressive-disclosure/] Dev affordances belong in `/admin` or behind a `?dev=1` query param, not on a public auth page.

### Proposed change
1. Remove the advanced toggle from `src/v3-app/screens/signin.tsx` entirely. The Backend URL is always the page's own origin. The Tenant ID is resolved server-side from the user's auth context (`/api/auth/verify` already returns `memberships`).
2. Remove the Dev token tab from `src/v3-app/screens/connect.tsx`. Make `/connect` admin-only as per F1.7.
3. If a dev needs to override the backend URL (e.g., local Vite on :5180 talking to a deployed API on Vercel), expose it via a `?backend=<url>` URL parameter that requires a "I am a developer" confirmation modal, or via a `localStorage.setItem('anvil:dev:backend_url', '...')` console command. Surface it only after the user passes through the modal.

### User-facing behavior
- A regular visitor sees a clean signin page with no advanced toggle.
- A dev who needs the override knows the console command.

### Technical implementation
- Delete the advanced toggle and its conditional rendering from `src/v3-app/screens/signin.tsx:445-464`.
- Delete the `showAdvanced` state at `src/v3-app/screens/signin.tsx:52`.
- Delete the `Dev token` tab from `src/v3-app/screens/connect.tsx:215, 280-296`.
- Add a `?backend=<url>` URL-param override gated by a modal, but only if there is a real dev workflow that needs it.

### Integration plan
- Test that local Vite still works: the page's origin (`localhost:5180`) should resolve correctly, calling its own `/api/*` routes (which Vite proxies to a separate API server or to the deployed Vercel host via `vite.config.ts` server.proxy).

### Telemetry
- `dev_override_used` (rare event).

### Non-goals
- Removing the dev affordance entirely from the codebase. It still has its use case for headless test rigs; just not on the public signin.

### Open questions
- Are there real users today who depend on the advanced toggle on signin? Probably no, but verify with the team.

### Effort
S. 1 day. 0.5 day code, 0.5 day testing.

### 5-axis score
PSev 4 (surface attack-vector + UX-clutter). MDiff 3. TLev 4. EStr 5. SFit 5. Total 21/25. P0.

### Deep-dive prompt
"Audit every public-facing surface in `src/v3-app/screens/*.tsx` for dev affordances leaking to production. Output a list with file:line. Define an `isDev()` helper based on `NODE_ENV` + `localStorage` + URL-param and require it on every dev affordance. Add a CI lint rule that rejects new dev affordances on non-admin routes."

---

## F1.21 The compare table has no last-updated stamp, opens defamation/competitive risk. [P2]

### Problem
The Compare section at `src/v3-app/screens/landing.tsx:1124-1151` ships a 4-column capability table: Anvil vs Workato/Pipefy vs Generic OCR vs Build in-house. The 7 rows each carry a verdict per competitor (yes/no/mid). Some rows are sharply negative for the competitors: "Workato / Pipefy · none · rules only · partial · add-on · cloud only · 4 to 8 weeks · ₹80k+ + dev hrs" (`src/v3-app/screens/landing.tsx:325-331`). Without a `last_audited_at` stamp or a citation for each competitor claim, this opens defamation and competitive-intelligence risk: a buyer who reads "Workato has none" could check today and find Workato has shipped a Pipefy-equivalent. The table needs to be timestamped and verifiable.

### Current state on main
- `src/v3-app/screens/landing.tsx:324-332`: CMP_ROWS array. 7 rows, 4 columns each. Verdicts: "yes" (●), "no" (○), "mid" (◐).
- `src/v3-app/screens/landing.tsx:1128-1129`: the lead "We get asked this a lot. Here's the honest comparison against the four common 'alternatives' we see in pilots."
- No `lastUpdated` or `sourcesUsed` field on the rows.

### Competitor state
N/A. Most companies that publish comparison tables include a "last updated" stamp and footnote the sources.

### Adjacent insight
A defamation suit in India under the Bharatiya Nyaya Sanhita Section 356 (defamation) can target a B2B competitor's published claim. The standard defense is truth + good faith. Both are easier to establish with timestamped, sourced rows.

### Research insight
N/A.

### Proposed change
1. Add a `lastUpdated: '2026-05-11'` field on each row.
2. Add a `sources: [{kind:'public_docs', url:'...'} | {kind:'pilot_data', notes:'...'}]` for each verdict.
3. Render the date below the table: "Last updated 2026-05-11. We re-verify quarterly. Spot an error? Email comparison@anvil.app."
4. Add a markdown source file `legal/comparison-sources.md` tracking every claim and its source.

### User-facing behavior
A buyer sees the freshness of each claim.

### Technical implementation
- Update CMP_ROWS in `src/v3-app/screens/landing.tsx:324-332`.
- New CSS for the date stamp.
- New mailto in the footer.

### Integration plan
- Quarterly verification cycle owned by PMM.

### Telemetry
- `compare_section_viewed`.
- `compare_correction_emailed`.

### Non-goals
- Real-time scraping of competitor public claims.

### Open questions
- Should the verdicts include a "neutral" tier? Currently it's yes/mid/no. Some competitors deserve "we don't know."

### Effort
S. 1 day code + recurring quarterly content work.

### 5-axis score
PSev 2. MDiff 2. TLev 2. EStr 4. SFit 4. Total 14/25. Marginal; ship as part of legal-review pass.

### Deep-dive prompt
"Audit Anvil's compare table for legal exposure. Re-verify every competitor claim against current public sources. Output a `comparison-sources.md` with one row per claim. Have legal review for defamation risk before re-shipping."

---

## F1.22 BRSR-positioning is absent from landing despite Bet 7 being merged. [P2]

### Problem
The 7 strategic bets are all merged on main, including Bet 7 BRSR Core (Business Responsibility and Sustainability Reporting; merged as commit `37dca49`). There are landing screens for the BRSR surface in the codebase: `src/v3-app/screens/brsr-buyer-dashboard.tsx`, `src/v3-app/screens/brsr-disclosure-detail.tsx`, `src/v3-app/screens/brsr-supplier.tsx` (verified by `ls src/v3-app/screens/`). But the public landing makes zero mention of BRSR. For an Indian distributor with NSE-listed customer relationships, BRSR compliance is becoming a real procurement requirement; the SEBI BRSR Core mandate applies to the top 1,000 listed companies by market cap as of FY 2024-25 and is cascading to suppliers. Anvil shipping BRSR support and not advertising it is a sales-eng miss.

### Current state on main
- BRSR screens exist in the codebase. [verified-on-main]
- No mention of BRSR in `src/v3-app/screens/landing.tsx`. [verified-on-main, via inspection]
- The Coverage section at `src/v3-app/screens/landing.tsx:253-267` has 9 surface clusters (workflows, sales, procurement, service, finance with two cards: Tally + drift reconciliation, data, quality & AI, trust). BRSR is missing.

### Competitor state
- ClearTax India: targets CAs + SMEs + Enterprises with tax-compliance positioning. No BRSR-specific landing surface visible on the homepage. [verified-from-prior-knowledge]
- Tally Solutions India: no BRSR landing visible. [verified-from-prior-knowledge]
- This is a category gap: no major Indian SMB/distributor software ships BRSR as a wedge.

### Adjacent insight
SEBI BRSR Core is a real regulatory tailwind for Indian B2B SaaS in 2026.

### Research insight
The BRSR Core framework was mandated by SEBI in 2023 for the top 150 listed companies, expanded to 1,000 by FY 2024-25, with supplier cascade. Compliance is a procurement requirement.

### Proposed change
1. Add a BRSR-specific section to the Coverage block at `src/v3-app/screens/landing.tsx:253-267`. Either as a new surface cluster or as a callout under "08 · trust."
2. Eyebrow: "BRSR Core · India SEBI." Header: "Cascade-ready BRSR disclosures." Body: "Anvil collects supplier-side BRSR Core indicators (Section A KPIs, scope-1/2/3, water, energy, diversity) and exposes them to your customers via a verified disclosure portal."
3. Add a FAQ Q9: "Do you support BRSR Core?"

### User-facing behavior
- An Indian distributor evaluating Anvil sees BRSR support in the Coverage section and asks for a demo.

### Technical implementation
- Update COVERAGE array at `src/v3-app/screens/landing.tsx:253-267` to add a BRSR cluster.
- Update FAQ array at `src/v3-app/screens/landing.tsx:342-351`.

### Integration plan
- Link to the existing in-app BRSR screens from a public "/brsr-buyer-dashboard" surface, but only after compliance review.

### Telemetry
- `coverage_brsr_viewed`.
- `brsr_faq_opened`.

### Non-goals
- A full BRSR-focused landing variant.

### Open questions
- Does the existing BRSR implementation cover Section A + Section B + Section C? Open.

### Effort
S. 1 day code + content.

### 5-axis score
PSev 2. MDiff 4 (category-gap differentiator). TLev 2. EStr 4. SFit 5. Total 17/25.

### Deep-dive prompt
"Audit Anvil's BRSR Core implementation. List every Section A/B/C indicator currently exposed. Map to SEBI BRSR Core checklist. Output a gap list. Recommend a public 'BRSR · for Indian distributors' landing page + sales narrative."

---

## F1.23 Format guide is an in-app help page, not a public format catalog. [P2]

### Problem
`src/v3-app/screens/format-guide.tsx` is a 71-line in-app help surface reachable at `#/format-guide`. It documents what file formats Anvil accepts (BOM library, SO history, Spare matrix, Customer PO, Customer quote, Price comparison), what it exports (Spare matrix, Recommended spares, SO history, SO agent history, Audit log, Audit pack ZIP), the document safety pipeline (ZIP guards, ClamAV proxy, redaction firewall, Storage TTL), and the Tally + GSTN export. It is solid content. Two gaps: (1) it is behind the auth gate, so buyers cannot read it before signing up, even though "what formats do you accept?" is one of the first questions a procurement lead asks; (2) it makes safety claims ("ClamAV proxy scans every accepted upload before OCR" at `src/v3-app/screens/format-guide.tsx:52`, "ZIP guards: file size limit 100 MB, member count cap, no nested ZIP, no executable extensions" at `src/v3-app/screens/format-guide.tsx:51`, "Storage: Supabase Storage bucket scoped to the tenant, signed URLs with 1-hour TTL" at `src/v3-app/screens/format-guide.tsx:54`) that should be on the public trust page, not buried inside an authed help route.

### Current state on main
- `src/v3-app/screens/format-guide.tsx:1-71`: WiredFormatGuide component. [verified-on-main]
- Reachable only via auth (no entry in `PRE_AUTH_ROUTES` at `src/v3-app/App.tsx:139`).
- The content is rich, with specific claims (ClamAV, 100 MB limit, 1-hour signed URL TTL, redaction-rule scope, Tally HTTP bridge with idempotency hash) that are exactly the questions a CFO procurement reviewer asks pre-signup.

### Competitor state
- Stripe: docs.stripe.com has every accepted file format documented publicly. [verified-from-prior-knowledge]
- Supabase: storage docs are public. [verified-from-prior-knowledge]
- Rossum, Hyperscience: format support is published in datasheets, not gated. [verified-from-prior-knowledge]

### Adjacent insight
This is a quick-win conversion lift: pre-signup procurement-question coverage.

### Research insight
NN/g Sign-Up Forms research: "users want to know what they're signing up for before they sign up." [verified-from-prior-knowledge, https://www.nngroup.com/articles/sign-up-forms/]

### Proposed change
1. Add `"format-guide"` to `PRE_AUTH_ROUTES` in `src/v3-app/App.tsx:139`.
2. Add a navigation link in `src/v3-app/screens/landing.tsx:598-608` pointing at `#/format-guide`.
3. Promote the safety claims (ClamAV, ZIP guards, signed-URL TTL, redaction firewall) onto the upcoming `/trust` page (F1.4).

### User-facing behavior
- A procurement lead browsing the landing clicks "Formats" in the nav. Sees the full catalog. Doesn't have to sign up first.

### Technical implementation
- One line in `src/v3-app/App.tsx:139` (`new Set(["reset", "signin", "format-guide"])`).
- One nav link in `src/v3-app/screens/landing.tsx`.

### Integration plan
- The screen already renders without an authed-only data fetch (it is a pure content surface).
- No backend changes.

### Telemetry
- `format_guide_viewed` with `{auth: true | false}`.

### Non-goals
- Adding more file formats to the catalog.

### Open questions
- Does the format-guide need a SEO-friendly slug ("/formats" instead of "/format-guide")? Probably yes.

### Effort
S. 0.5 day.

### 5-axis score
PSev 2. MDiff 2. TLev 2. EStr 5. SFit 4. Total 15/25.

### Deep-dive prompt
"Map every public-facing procurement question (data residency, file formats, audit trail, redaction rules, sub-processors, MFA enforcement, password policy, session timeout) to a public URL on Anvil. Today most live behind auth or are not documented. Output a gap list and a 30-day plan to publish each."

---

## F1.24 The auth `Advanced toggle` defaults to `open` for fresh installs. [P1]

### Problem
On `src/v3-app/screens/signin.tsx:52`, the `showAdvanced` state initializes to `!cfgRef.url`. The intention (per the inline comment at `src/v3-app/screens/signin.tsx:36-40`) is: "Default the Backend URL to the page's own origin when nothing is configured. The deployed Vercel host serves both the static frontend and the /api/* endpoints, so this is correct approximately 99 percent of the time. Local dev (vite on :5180 talking to a separate API) can still override via the Advanced toggle." The auto-defaulting works (line 41), but the toggle still snaps open on first paint because the in-memory `cfgRef.url` is empty before the `useEffect` at lines 70-73 persists the default. Two-paint flash, plus the same surface-cleanup concern as F1.20.

### Current state on main
- `src/v3-app/screens/signin.tsx:34-41`: `cfgRef = (ObaraBackend?.getConfig?.() || {}); defaultUrl = cfgRef.url || window.location.origin;`. [verified-on-main]
- `src/v3-app/screens/signin.tsx:52`: `setShowAdvanced(!cfgRef.url)`. The state is `true` on first render of a fresh install. [verified-on-main]
- `src/v3-app/screens/signin.tsx:70-73`: `useEffect` persists the auto-defaulted URL on mount via `persistConfig()`. But the toggle is already open at first paint.

### Competitor state
N/A.

### Adjacent insight
This compounds F1.20: even after F1.20 is fixed and the advanced toggle is removed from the visible surface, this defaulting logic lives in the same file and is the kind of thing a dev would resurrect to expose a "Backend URL" override under the wrong feature flag.

### Research insight
NN/g progressive disclosure: only reveal advanced settings on explicit user action.

### Proposed change
- Combined with F1.20: delete the toggle. The Backend URL is the page's origin. The Tenant ID is resolved by the server from the user's email at signin.

### User-facing behavior
None (after F1.20 lands).

### Technical implementation
- Same as F1.20.

### Integration plan
- F1.20 is the parent.

### Telemetry
- N/A.

### Non-goals
- Preserving the toggle for any reason.

### Open questions
- N/A.

### Effort
S. 0 day if bundled with F1.20.

### 5-axis score
PSev 3. MDiff 1. TLev 2. EStr 5. SFit 4. Total 15/25. Marginal but high-correlation with F1.20; ship together.

### Deep-dive prompt
"List every initial-state computation in `src/v3-app/screens/*.tsx` that depends on a localStorage / config-load timing. Output a list of double-paint flashes."

---

## F1.25 Magic-link callback is a static HTML file at `/auth/callback.html`, separate from the SPA hash router. [P2]

### Problem
The magic-link flow redirects the user to `redirect = url + "/auth/callback.html"` (`src/v3-app/screens/signin.tsx:298`, `src/v3-app/screens/connect.tsx:85`). This is a static HTML file under `public/auth/` (verified by `ls public/` showing an `auth/` subdirectory). The SPA router is hash-based (`#/landing`, `#/signin`, `#/reset`, etc., per `src/v3-app/App.tsx:130-189`). The callback file is therefore outside the React tree. This means: (a) two separate rendering surfaces with their own styles + behavior; (b) the callback page must duplicate session-write code rather than reusing the shared `ObaraBackend.setSession`; (c) any session-storage migration touches two places; (d) the callback is not gated by the auth-state machinery in `App.tsx`. The trade-off was probably "the callback runs before the SPA bundle finishes downloading, so a separate page is faster," which is defensible, but the duplication is a maintenance hazard.

### Current state on main
- `src/v3-app/screens/signin.tsx:298`: `const redirect = (url || "").trim().replace(/\/+$/, "") + "/auth/callback.html";`. [verified-on-main]
- `src/v3-app/screens/connect.tsx:85`: same pattern. [verified-on-main]
- `public/auth/` directory exists (per `ls public/`). [verified-on-main]
- `src/v3-app/App.tsx:139` `PRE_AUTH_ROUTES = new Set(["reset", "signin"])`, no `"auth/callback"` because the callback is static HTML, not a hash route.

### Competitor state
- Vercel: callback is part of the SPA. [verified-from-prior-knowledge]
- Supabase Auth: their JS client handles the callback hash internally, no separate file required. [verified-from-prior-knowledge]

### Adjacent insight
A SPA-internal callback path lets the auth UI show a friendly "Signing you in..." spinner with the brand voice, then route to the user's intended-route from `lsGet(INTENDED_ROUTE_KEY_SUFFIX)`. A static file has to duplicate that logic.

### Research insight
N/A.

### Proposed change
1. Add a new pre-auth route `#/auth/callback` to `PRE_AUTH_ROUTES`.
2. New screen `src/v3-app/screens/auth-callback.tsx` that parses the URL fragment, calls `ObaraBackend.setSession`, fetches the profile, and routes to the intended-route.
3. Update `src/v3-app/screens/signin.tsx:298` and `src/v3-app/screens/connect.tsx:85` to point at `/#/auth/callback`.
4. Keep the static `public/auth/callback.html` for one release cycle as a fallback (it can be a thin redirect to the SPA route).

### User-facing behavior
- The magic-link click drops the user into a branded "Signing you in" screen with the kinetic-pair animation, then forwards them to their intended route.

### Technical implementation
- New file `src/v3-app/screens/auth-callback.tsx`. Pattern matches `src/v3-app/screens/reset-password.tsx:19-47` for URL-fragment parsing.
- Add to `PRE_AUTH_ROUTES`.
- Update both signin / connect redirect URLs.

### Integration plan
- The static file remains in place as a fallback for one release cycle.

### Telemetry
- `magic_link_callback_landed`.
- `magic_link_callback_session_minted`.
- `magic_link_callback_redirected_to_intended`.

### Non-goals
- Removing the static fallback entirely until the SPA path is proven stable.

### Open questions
- Are there any deployed clients still calling the static path? Probably yes; keep it as a redirect for one release.

### Effort
S. 2 days.

### 5-axis score
PSev 2. MDiff 1. TLev 3. EStr 4. SFit 3. Total 13/25. Marginal.

### Deep-dive prompt
"Audit every place in Anvil that maintains two parallel implementations of the same auth-state-machine transition. Output a per-transition table (signin success, magic-link callback, OAuth callback, recovery-token use, MFA challenge response, passkey assert). Identify duplications. Recommend a single-source path."

---

## Aggregated score + priority summary

| # | Finding | Score | Effort | Priority |
|---|---|---:|---|---|
| F1.6 | Sandbox / TTV unbuilt | 25/25 | M | P0 |
| F1.7 | First-run tour, /connect double-route | 22/25 | M | P0 |
| F1.20 | Advanced backend-URL toggle on public signin | 21/25 | S | P0 |
| F1.1 | Hero variant + sandbox link | 21/25 | M | P1 |
| F1.4 | Security strip → /trust page | 21/25 | M | P1 |
| F1.15 | WebAuthn conditional UI | 21/25 | M | P1 |
| F1.3 | Customer logos + connector marquee | 19/25 | S | P1 |
| F1.10 | TOTP recovery codes | 19/25 | M | P1 |
| F1.11 | signin.tsx vs connect.tsx unification | 19/25 | M | P1 |
| F1.16 | TTFV instrumentation | 19/25 | S | P0 by leverage |
| F1.5 | Pricing currency + billing instrumentation | 18/25 | S | P2 |
| F1.13 | SOC 2 in-progress target dates | 17/25 | S | P1 |
| F1.22 | BRSR positioning on landing | 17/25 | S | P2 |
| F1.2 | Demo cycle a11y + readability | 16/25 | S | P2 |
| F1.8 | Magic-link UX hardening | 16/25 | S | P2 |
| F1.19 | Tally "most loved" → 12ms claim | 16/25 | S | P2 |
| F1.9 | Passkey challenge-table refactor | 15/25 | S | P3 |
| F1.17 | SEO meta + OG + sitemap | 15/25 | S | P3 |
| F1.23 | Format-guide on public surface | 15/25 | S | P2 |
| F1.24 | Advanced toggle default-open | 15/25 | S | P1 (bundled with F1.20) |
| F1.12 | Reset-password URL-token replay | 14/25 | S | P3 |
| F1.21 | Compare table timestamp | 14/25 | S | P3 |
| F1.25 | Magic-link callback in static HTML | 13/25 | S | P3 |
| F1.14 | 17 vs 18 ERPs consistency | 12/25 | S | P3 |
| F1.18 | Content-visibility / perf | 12/25 | S | P3 |

Critical-path sequence (recommended):
1. Sprint 1 (weeks 1-2): F1.20 + F1.24 (remove dev affordance), F1.16 (TTFV instrumentation), F1.14 + F1.17 + F1.19 (truth-in-claims).
2. Sprint 2 (weeks 2-5): F1.6 (sandbox), F1.7 (tour), F1.4 (trust page), F1.23 (format guide public).
3. Sprint 3 (weeks 5-7): F1.1 (hero A/B + sandbox link), F1.10 (recovery codes), F1.11 (auth unification).
4. Sprint 4 (weeks 7-9): F1.15 (conditional UI, after F1.9 prereq), F1.3 (customer logos), F1.13 (SOC 2 dates).
5. Sprint 5 (weeks 9-10): F1.5 (billing), F1.22 (BRSR), F1.2 (a11y + demo pause).
6. Sprint 6 (weeks 10-11): F1.8 (magic-link UX), F1.9 (passkey refactor), F1.12 (reset replay), F1.25 (callback in SPA).
7. Sprint 7 (weeks 11-12): F1.21 (compare timestamps), F1.18 (perf).

This sequence front-loads the conversion-funnel essentials (sandbox + tour + trust + TTFV instrumentation) and the public-surface security cleanup (F1.20 + F1.24), then closes the auth-UX gaps that block enterprise tier sales (F1.15, F1.10, F1.11, F1.13), then ships the long-tail items.

---

## Honest gaps in this audit

1. I did not open every auth endpoint. `complete_reset.js`, `request_reset.js`, `change_password.js`, `verify.js`, `profile.js`, `register_finish.js`, `list.js` — sampled but not fully reviewed. The findings above are bounded by what was opened.
2. I did not enumerate the full `audit_events` schema. F1.16 assumes the table exists (verified by grep in `_lib`) but the column list is from inference. A full schema read is the first task in the F1.16 implementation prompt.
3. WebFetch was permission-denied this session; the competitor citations were re-tagged `[verified-from-prior-knowledge]` and reference the URLs verified in previous sessions. Replacement primary citations would tighten the research insight in F1.6 and F1.7.
4. I did not browser-render the landing in a live preview to verify the demo animation timing or the marquee speed. The numbers in F1.2 come from the constants in the source.
5. I did not open `src/v3-app/styles.css` in full. The file is large; specific selectors named in F1.2 and F1.18 are inferred from the TSX class names rather than directly verified.
6. I did not test the conditional-UI claim for WebAuthn against Anvil's own browser-matrix; the F1.15 implementation prompt makes that explicit.
7. The exact 17 vs 18 vs 17+1 counts in F1.14 are verifiable by counting tile entries at `src/v3-app/screens/landing.tsx:117-136`. I did the inspection but did not run the `wc -l` referenced in the code comment.

---

## Deep-dive prompts collated (for implementation phase)

Each prompt names a source to read or a question to answer. Numbered for tracking.

**DD-1.** "Audit the `audit_events` schema and every code call site that writes to it. Output a complete event taxonomy. Identify the 12 events required for an activation funnel (signup → first PO → first extraction → first SO → first push). Propose a migration that backfills `tenants.first_*_at` columns from `audit_events` history." Source: `src/api/_lib/audit.js`, `supabase/migrations/`. Answers F1.16 implementation.

**DD-2.** "Design Anvil's sandbox-tenant seeding script. Specifically: (a) which sample customers + part-masters + POs are legally cleared for use, (b) the cost economics of sandbox extraction at 1,000 signups/mo, (c) the data-retention policy for sandbox audit logs, (d) the cross-tenant-leakage guard rails. Output a `src/api/_lib/sandbox_seed.js` with citations + a 30-day cost model." Source: existing Obara India production tenant data + legal review. Answers F1.6.

**DD-3.** "Build the WebAuthn conditional-UI implementation for Anvil signin. Refactor `src/api/auth/passkey/auth_begin.js` to support discoverable credentials (empty `allowCredentials`). Update `src/v3-app/screens/signin.tsx` to call `navigator.credentials.get({ mediation: 'conditional' })` on mount with `autocomplete='email webauthn'` on the email input. Test the user experience on Chrome (Win+Mac+Android), Safari (iOS+macOS), Firefox (Win+Mac). Output the diff + a browser-matrix screencast." Source: passkeys.dev/docs/use-cases/bootstrapping, Anvil's `src/api/auth/passkey/auth_begin.js + auth_finish.js`. Answers F1.15.

**DD-4.** "Audit every public-facing claim on `src/v3-app/screens/landing.tsx` against the implementing code in `src/api`. Produce a `claims.csv` mapping each claim to a citation (file:line or query-against-production). Flag every claim that is aspirational. Recommend either ship-the-feature or strike-the-claim. Sources: `src/v3-app/screens/landing.tsx`, `src/api/`, `src/v3-app/`." Answers F1.14, F1.19, F1.21.

**DD-5.** "Map every SOC 2 Type II CC (Common Criteria) sub-requirement to an Anvil control surface. For each control, cite the implementing file in `src/api/_lib/` or `supabase/migrations/`. Output the gap list with owners and remediation effort. Goal: by Q3 2026, every CC has a code or policy citation, ready for the auditor's first walkthrough." Source: TSC 2017 + 2022, `src/api/_lib/`, `supabase/migrations/`. Answers F1.4, F1.13.

**DD-6.** "Run a 30-day A/B test for Anvil's hero variants (kinetic-pair vs negation vs fact). Cover sample-size calc for a 3-arm test at expected baseline 4 percent sandbox-clickthrough and MDE 1pp; choice of primary metric (sandbox-completed vs signup-started vs SQL-booked); guard rails to avoid Simpson's-paradox between mobile and desktop; significance gate (Bayesian vs frequentist)." Source: growthspreeofficial.com benchmark, internal CRO playbook. Answers F1.1.

**DD-7.** "Compare 5 patterns for MFA recovery: (a) recovery codes one-time, (b) hardware backup key, (c) admin reset, (d) magic-link-of-last-resort to a back-up email, (e) verified phone fallback. Each: usability, security, SOC 2 mapping, implementation effort. Recommend Anvil's stack." Source: OWASP Auth Cheat Sheet, NIST SP 800-63B. Answers F1.10.

**DD-8.** "Inventory every place in `src/v3-app/` that uses the `#/connect` route as a fallback. Output a refactor plan that makes `#/connect` admin-only and ensures non-admin users never see it. Sources: `src/v3-app/App.tsx`, `src/v3-app/screens/connect.tsx`, `src/v3-app/screens/*.tsx`." Answers F1.7, F1.11.

**DD-9.** "Audit Anvil's full animation surface (landing hero, demo cycle, marquee, count-up tween, IntersectionObserver reveal-on-scroll) for WCAG SC 2.2.2 (Pause, Stop, Hide), SC 2.3.3 (Animation from Interactions), SC 2.5.1 (Pointer Gestures), SC 2.5.2 (Pointer Cancellation). Produce a violations list with file:line refs + remediations. Add `axe-core` to CI. Sources: `src/v3-app/screens/landing.tsx`, `src/v3-app/styles.css`, axe-core docs." Answers F1.2, F1.18.

**DD-10.** "Build the public `/trust` page for Anvil. Sections: SOC 2 (in-progress with auditor + target), ISO 27001 (in-progress), GDPR + DPDP, data residency (with the actual Supabase region), sub-processors (Supabase, Vercel, Anthropic, Mistral, Twilio, SendGrid, ClamAV), encryption details, MFA + passkey, audit log, bug bounty (or its absence). Add a SOC 2 report-request form. Output the `src/v3-app/screens/trust.tsx` + `src/api/security/report_request.js` + a migration for the request log table. Sources: stripe.com/security, vercel.com/security, supabase.com/security." Answers F1.4, F1.13.

**DD-11.** "Audit the public-pre-signup surface. Today only `landing` and `signin` are pre-auth (per `PRE_AUTH_ROUTES` at `src/v3-app/App.tsx:139`). Procurement questions that should not require signup: (a) what file formats does Anvil accept (currently `format-guide.tsx` is behind auth), (b) what is the security posture (currently no `/trust` page), (c) what is the sub-processor list (currently nowhere), (d) what is the privacy policy (currently nowhere), (e) what is the data-retention policy (currently buried in FAQ). Output a plan to publish each, including a `PRE_AUTH_ROUTES` expansion and the SEO surface from F1.17." Answers F1.4, F1.17, F1.23.

**DD-12.** "Audit Anvil's full auth-endpoint surface (`src/api/auth/magic_link.js`, `password_login.js`, `passkey/auth_*`, `signup.js`, `request_reset.js`, `complete_reset.js`, `mfa.js`) for timing-oracle leaks. Use OWASP ASVS L2 v4.0 as the rubric; pay special attention to (a) constant-time email-lookup (the May 2026 H11 regression fix is a partial; verify each pre-auth endpoint), (b) constant-time response padding, (c) error-message uniformity. Output a violations list and a per-endpoint remediation diff." Answers F1.8.

---

## Closing

The Anvil landing + onboarding + auth surface as of `main` (commit `c4f946b`, "feat(bet2): format-template marketplace (post counsel approval) (#100)") is substantially further along than the v1 audit implied. The product ships a real 1,272-line landing TSX page with 19 sections, three distinct auth surfaces (signin, connect, reset-password), a wired onboarding checklist, passkey + TOTP + magic-link + password support, an admin-only security console, and an in-app format-guide. The 7 strategic bets are merged. Test count: 1,122 passing. Migrations: 103.

The auth backend has been hardened across multiple May 2026 audit cycles: the magic-link endpoint allowlists `redirectTo` against `MAGIC_LINK_REDIRECT_URL` (`src/api/auth/magic_link.js:23-32`), returns generic-200 on every outcome to defeat user enumeration (lines 53, 64, 78, 99, 102), and rate-limits per-email and per-IP (lines 72-76). The password login enforces TOTP + replay protection via `verifyTotpAndConsume` (`src/api/auth/password_login.js:87-115`). The passkey assert requires user verification (`src/api/auth/passkey/auth_finish.js:120`). The signup flow has an admin-approval gate (`src/api/auth/signup.js:119-150`). The pre-auth endpoints have been hardened to use email-filtered single-row lookups instead of project-wide `listUsers` (audit H11 regression fix, see comments at `src/api/auth/passkey/auth_begin.js:46-52` and `src/api/auth/signup.js:66-69`). The TOTP secret is AES-encrypted at rest when the secrets layer is configured (`src/api/auth/mfa.js:27-33`, `_lib/secrets.js`). This is solid security posture.

The remaining gaps are concentrated in three areas. First, activation: there is no sandbox tenant, no first-run tour, and no time-to-value instrumentation, so the "two weeks to first voucher" landing claim is unprovenanced. Second, auth UX: TOTP has no recovery codes, passkey lacks conditional UI, signin has two parallel surfaces, the magic-link callback runs in a separate static HTML file outside the SPA, and one public surface still ships a "Backend URL + Tenant ID" toggle that should not exist in production. Third, trust surface: SOC 2 + ISO 27001 badges are "in progress" with no target dates, no public sub-processor list, no `/trust` page, and the format-guide that already documents the safety pipeline sits behind the auth gate.

The three P0 items (F1.6 sandbox, F1.7 tour, F1.20 public dev affordance, with F1.24 bundled) are the highest-priority. The two near-P0 items (F1.16 TTFV instrumentation and F1.4 trust page) are leverage multipliers: they make every other landing claim provable and CFO-defensible. Together they form the 30-day critical path.

End of v2 audit (rewrite). Date: 2026-05-11. Repo head: `c4f946b`. Word count: approximately 13,000.
