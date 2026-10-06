# Sales accounts, installed assets and the customer portal: scope

Scoping note, 2026-10-04. A prospective tenant asked for this. They sell resistance welding guns, weld timers and their spares to automotive OEM body shops (Hyundai, Mahindra, Gestamp). The survey was done at `origin/main` 1f45d83f. Nothing has been built.

This plan combines three candidate designs that three judges scored: wire-first 21.5, customer-first 21, model-first 14.5. It starts from wire-first. From customer-first it takes the security sequencing and the PR-number matching rules. From model-first it takes the quote-owner order of precedence and the escalation route. It drops every claim a judge showed to be false. Section 2.3 lists each conflict and how it was settled. Section 2.4 lists the claims that were corrected against the code. A review pass then re-checked the plan against the code. The Review notes at the end list what that pass changed, and the one place where the review itself was only partly right.

**Terminology.** "PR raised", "PR number" and "requisition" mean the customer's SAP purchase requisition. "PR 1" to "PR 25" are this scope's pull requests. "D1" to "D21" are the open owner decisions in section 2.2.

**The short answer.** Almost every link in the customer's loop already exists in Anvil, but the pieces do not reach each other. The work is wiring and fixing, not modelling:
- **5 additive migrations** (227 to 231);
- **no new tables** and **no new enum values**;
- **25 PRs**, of which **17 make the pilot**, and **9 can start today** without waiting on any decision.

---

## 0. The problem in the customer's words

- **N1.** Organise the sales team's pipeline: reps with assigned accounts, each rep's pipeline; managers see the team.
- **N2.** Assets within accounts (guns and timers at each customer plant) define which spares apply, and therefore the potential spare opportunities.
- **N3.** Quote and opportunity follow-up is a key part of the sales cadence.
- **N4.** A customer-facing portal. The customer sees their assets, the spares that apply to each, and the quotes requested for spares, so they can keep track and respond. Their maintenance team raises a purchase requisition (PR) in SAP against our quote, and purchasing then issues the PO. They also track order shipment status and ready dates.

The loop these describe:

```
installed gun / timer at a plant
  -> spares that fit it
  -> customer (or rep) asks for a quote
  -> rep prices it, a manager approves and sends it
  -> customer answers: PR raised (with the SAP PR number) / revise / not needed
  -> purchasing issues the PO; DocAI extracts it, PR number included
  -> order reviewed and approved
  -> a delivery date we commit to
  -> despatch: challan, LR, invoice
  -> delivered
```

**The PR number is the hinge.**
- The customer's maintenance team raises a SAP PR against our quote, and their purchasing prints that PR on the PO.
- DocAI already extracts it (`claude.js:1326`, `gemini.js:268`).
- so-intake already stores it inside `orders.result.salesOrder.customer` (`so-intake.tsx:919-934`), but nothing reads it there.
- If the customer tells us the PR number when they raise it, the PO can close the quote by itself.

What breaks the loop today, one line per need:

- **N1:** accounts have no owner. The Opportunities screen shows blank names, ₹0 and "5000%". Opportunities cannot be edited after they are created.
- **N2:** the only installed-base data customers could see is the spare matrix worksheet. The canonical equipment registry is empty and nothing links to it.
- **N3:** follow-ups belong to nobody. Automatic nudges start within the hour and do not stop when the customer declines.
- **N4:** a logged-in customer sees only spare matrices: no quotes, no way to respond, no order view. Nobody can even be invited.

---

## 1. What already exists

The states used below:
- **wired:** written, read and shown;
- **partial:** a link is missing or broken;
- **unwired:** built, but nothing reaches it;
- **missing:** does not exist.

### N1: accounts, ownership, pipeline

| piece | where | state | what this scope does |
|---|---|---|---|
| `opportunities.owner_id` | `006:311`; set to the creator at `opportunities.js:93` | partial: not in the PATCH allowlist (`:113`), no "mine" filter (`:65-69`) | **Wire** (PR 6, 7) |
| Opportunities screen | `opps.tsx` | partial: reads fields the API never returns (`:33-47,399-414`); probability is multiplied by 100 (`:404`); `opps-list-view.test.tsx:42` locks the drift in | **Fix** (PR 6) |
| `updateOpportunity` | `anvil-client.js:1615` | unwired, no caller | **Wire** (PR 7) |
| `lost_reason_taxonomy` and its client wrappers | `006:640`; global rows `006:845-852`; `anvil-client.js:1757-1759` | unwired | **Wire** (PR 7) |
| Account owner | no column. `credit_review_request.js:24,52-53` already reads a nonexistent `customers.owner_user_id` and a nonexistent `users` table | missing | **Add** (PR 5, migration 227) |
| Pipeline self-scope | `analytics/pipeline.js:33-37` | partial: the screen never sends `owner_id` (`sales-ops.tsx:29`); "manager" means the approve tier, which includes finance | **Wire, fix** (PR 9) |
| `by_rep`, stalled list, revenue by rep | `pipeline-conversion.js:124-163`; `_lib/ops-kpis.js:89-99` | partial: `by_rep` is never shown; the stalled list shows truncated **opportunity** ids (`sales-ops.tsx:146`) and "Revenue by rep" shows truncated **user** ids (`:290`) | **Wire** (PR 9) |
| `resolveAssignee` | `service/visits.js:22-35` | built, no screen sends it | **Reuse** (PR 5, 7) |
| `requireAction` / `SERVER_ACTIONS` | `auth.js:206-249`; `rbac.ts:111-131` | wired, but an action missing from `SERVER_ACTIONS` passes for every role (`auth.js:236`) | **Reuse**; every new action is registered on both sides in the PR that uses it |
| Member directory | `admin/members.js:46-74` | wired; returns unapproved members without saying which | **Fix lightly** (PR 5) |
| `quotes.opportunity_id` | `068:48`; POST accepts it (`quotes/index.js:292`) | unwired from the UI (`NewQuoteModal.tsx:104-114`; `to_quote.js:147` writes null) | **Wire** (PR 8) |
| Quote send | `quotes/send.js:158-161` | wired; gated on `quotes.approve`, which only `sales_manager` and `admin` hold (`auth.js:222`). A rep cannot send | **Keep** (D21) |
| Teams, managers, quotas | none; only `prospecting_targets` (`057:35`) | missing | **Leave** (D1, D2) |
| Client-side role | `rbac.ts:142-146` | can be changed from localStorage | **Leave**; every new rule here is enforced on the server |

### N2: installed assets and applicable spares

| piece | where | state | what this scope does |
|---|---|---|---|
| `spare_matrix`, `spare_matrix_rows` | `159:24-75` | wired; this is the installed base in practice. No plant column, no publish flag | **Wire to the portal** (PR 14, migration 229) |
| `recommended_spares` | `159:81-103`; `item_id` from 171 | wired; `quote_id` is written back (`to_quote.js:184-190`) and shown nowhere | **Show** as the applicable-spares list (PR 14, 23) |
| `equipment_hierarchy`, `equipment_installed_parts` | `006:390-429` | canonical by decision (`INSTALLED_BASE_CANONICAL.md:15-37`); about 0 rows; its screen is not in the nav | **Leave** (D5) |
| `item_customer_parts` | `105:345-358` | wired for the item mapper; never reaches spares or the portal | **Wire** (PR 14) |
| `to_quote` | `spare_matrix/to_quote.js` | wired; unit price 0 (`:101`), opportunity null (`:147`); re-syncs any DRAFT with the same `source_matrix_id` unless `force` (`:113-124`) | **Fix** (PR 20); **reuse** its builder with two guards (PR 21) |
| Share | `share.js:20-89`; button at `spares.tsx:298-306` | partial: the SPA ignores the `/portal?token=` link (`share.js:83`, `PortalApp.tsx:8-11`); reuses tokens with broader scopes (`:44-71`) | **Stop minting** (PR 2); **rewire** as publish (PR 14) |
| `gun_drawings.approval_status` | `197:45`, default `pending`, provisioned "for a future approval workflow" (`197:12-14`); `drawings/update.js:49-51` accepts it | partial: no screen sets it | **Leave** for engineering; customer release is a separate stamp (D15, PR 14) |
| ARC rates | `contract_lines` (`006:211-240`) | read only by admin | **Wire** as the price prefill (PR 20) |
| Spare "opportunities" | `spare_matrix/opportunities.js:19-28` | unwired; hidden tab (`spares.tsx:2140`) | **Leave** |
| Planning, `demand_forecasts` | `cron/inventory-planning-weekly.js`; `085:226-249` | partial; not scheduled | **Leave** (north star, §7) |

### N3: cadence and follow-up

| piece | where | state | what this scope does |
|---|---|---|---|
| Quote nudge goal | `quote_accept.js`; `agent_goals` (011) | partial: see the five problems below this table | **Fix** (PR 12, migration 228) |
| `expiring_quote_nudge` | `:39` | wired; stops on every terminal status | **Keep** |
| Escalation | `run.js:102-127` calls `notifyAdmins` (`notifications.js:34-84`) | partial: writes one tenant-wide row; the bell loads only for admin and operator (`Shell.tsx:95,597`) | **Leave** for admins; send quote escalations to the owner's chase list instead (PR 12) |
| Reply attribution | `_lib/graph-reply.js:30-66`, called from `inbound/email/webhook.js:196` | partial: marks the outbound `communications` row `replied` for Graph-sent mail; nothing reads it for goals | **Wire** to pause the quote's nudges (PR 12) |
| `communications` | `005:22-40` (`metadata jsonb` at `:37`); `189:49-63` (`object_type`, `object_id`, `customer_id`, `sent_by`) | wired; the list filters only by order and source PO (`communications/list.js:36-37`) | **Wire** as the touch log (PR 10) |
| `addBusinessDays` | `_lib/datemath.js:42` | wired | **Reuse** |
| Home | `home.tsx:31-34` | broken: reads `.rows`, but `/api/orders` returns `{orders}` | **Fix**, and host the chase list (PR 11) |
| Quotes list | `quotes.tsx:61-70,262` | partial: a future expiry date is shown as a negative age | **Fix** (PR 11, 16) |
| `/api/quotes/ingest` | `router.js:929`; `quote-ingest.js:276,293` | unwired, no client | **Wire** (PR 22) |
| `opportunity_quotes` (203) | `opportunities/quotes.js` | wired as a revision log; no cadence | **Leave** internal |

The quote nudge goal has five problems today:
- the first nudge goes out within the first hour (`011:57`);
- it never stops on DECLINED, CANCELLED or EXPIRED (`quote_accept.js:31`);
- it escalates on every run after the due date and stays active forever (`quote_accept.js:95-101`; `run.js:60-63`);
- its owner is whoever clicked Send (`send.js:485`), which is always a manager, and that owner field is never read (`011:69`);
- an emailed answer does not stop it: `handle_replies.js:34` acts on no quote intent, and the `replied` flag set by `graph-reply.js:42-53` is read by nothing.

### N4: portal and tracking

| piece | where | state | what this scope does |
|---|---|---|---|
| Portal identity | `portal_users` (199); `portal-auth.js:34-85`; `login.js` | wired, spares only (`SESSION_SCOPES`, `:34`). Both lookups read one row by `auth_user_id` with no tenant filter (`portal-auth.js:45-47`, `login.js:42-44`), while rows are unique only per tenant and customer (`199:33`) | **Extend** (PR 13-17) |
| Invite | `portal/auth/invite.js` | unwired: no screen, no `redirectTo` (`:60`), no set-password flow; throws on any invite error, including an email that already has an auth account (`:60-61`) | **Wire** (PR 13) |
| `GET /api/portal/view` | `view.js` | partial: see the list below this table | **Fix, extend** (PR 1, 14, 15, 17) |
| Legacy URL tokens | five minters, five endpoints (list in D18) | every link Anvil emails is a 404 (`vercel.json:45-46`) | **Close** two unsafe paths (PR 1), **retire** the rest (PR 2) |
| `accept_quote.js` | quote path `:40-106`; order path `:108-140` | unwired and unsafe: see the list below this table | **Fix** (PR 1), **rewire** (PR 16) |
| `portal_quote_acceptances` | `033:24-38`; `quote_id` from `069:11-17` | written, never read | **Becomes the customer-response log** (PR 16, migration 230) |
| Quote status transitions | `quotes/index.js:35-44` | wired | **Reuse** |
| Stored quote PDF | `send.js:289` | wired | **Serve** through a signed link (PR 15) |
| Pending-orders read model | `sales/pending_sales_orders.js` | staff-only; excludes RECONCILED (`:37`); drops fully despatched lines (`:144-145`); selects a nonexistent `customers.display_name` (`:64`); takes the oldest 500 orders before filtering status (`:65-70`); carries supplier and vessel details | **Leave** for staff with two one-line fixes (PR 17); **not** the portal's base |
| Customer-safe despatch register | `dispatch-register.js:80-84` `SAFE_KEYS`; `buildDispatchRegister` (`:170-290`) | library wired, endpoint unwired | **Build the portal Orders view on it** (PR 17) |
| Despatch capture | `dispatch_lines` (193); `delivery_note_ingest.js` (#541); `anvil-client.js:693-696` | no screen calls it; an explicit `order_id` skips every check (`:100-142`) | **Wire, fix** (PR 3) |
| Committed date | `orders.committed_delivery_date` (207); `SOWorkspaceOrderPanels.tsx:189-191` | entered by hand | **Keep**; add a suggestion chip (PR 19) |
| Customer lead times | `003:70-79`; only reader is `delivery/promise.js:50-56` (no screen caller) | edited by admins; meaning unclear (D11) | **Decide**, then prefill (PR 19) |
| Requisition number | `claude.js:106,186-206,1326`; `gemini.js:64-67,268`; stored at `so-intake.tsx:919-934` | stored, read by nothing; header-level slot only | **Wire** (PR 4, 18, migration 231) |
| Large-PO extraction | `so-intake.tsx:997-1035`; `cron/extraction_jobs.js:749-765` | wired: the order is created from a page-1 preview, reconcile is skipped, and the worker later replaces the lines and the customer block | **Respect** in PR 4 and PR 18 |
| PO-to-quote reconcile | `reconcile_quotes.js`, called at `so-intake.tsx:1038` and by the workspace button (`so-workspace.tsx:1094-1110`) | wired; pools all of the customer's non-draft quotes (`:1-10,61-66`) and overwrites `orders.quote_id` (`:254`) | **Extend** (PR 18) |
| `quotes.converted_order_id` | only writer is `quotes/convert.js:173` | partial | **Write it at approval** (PR 18) |
| Expected-PO internal SO | `006:38-47,334-363` | the list screen is always empty: `internal-sos.tsx:56` reads a different key than `internal_so.js:34` returns | **Wire** (PR 24) |
| "Where is my order" emails | `handle_replies.js:34,92-114` | classified and written as events; nothing reads them | **Use** as the pilot baseline (§6) |
| TOTP, rate limits | `auth/password_login.js:57-112`; `_lib/totp.js`; `_lib/rate-limit.js:23-55` over per-feature attempt tables (`043:154`, `059:43,50`) | wired for staff | **Reuse** (PR 13, 25) |

Problems in `GET /api/portal/view` today:
- the customer-visible status list contains values that are not in the enum (`:27-29`);
- `kind=quotes` reads **orders**, not quotes (`:83-89`);
- `kind=summary` is gated on the `quotes` scope and returns an open-invoice count and the customer's contact email with no allowlist (`:53,60-82`);
- legacy `kind=invoices` has no status filter, so draft and void invoices are served (`:97-101`);
- every matrix of the customer is visible (`:103-109`);
- drawings are filtered only on `status = 'committed'`, and `document_id` is not selected (`:124`).

Problems in `accept_quote.js` today:
- the order path sets any order of the token's customer to APPROVED;
- any token can accept a quote with no customer (`:46`);
- the audit insert writes `actor_id` (`:87,144`), but the column is `actor` (`001:326`).

---

## 2. Decisions

### 2.1 Already decided

- **The canonical installed base is `equipment_hierarchy` + `equipment_installed_parts`** (`INSTALLED_BASE_CANONICAL.md:15-37`, migration 170).
  - Point 3 of that doc also says `recommended_spares.installed_qty` is a worksheet count and must not be treated as installed-base data.
  - This scope amends the first point for the customer-facing view (D5) and obeys the third.
- **Spare matrix shape** (`recompute_recommended.js:1-12`):
  - rows are guns and columns are spare categories;
  - cells are filled by matchSpares;
  - `installed_qty` is a COUNT.
- **Portal identity is separate from staff identity:** `portal_users` plus a separate SPA (199; `vite.config.js:41-44`). The older plan for an internal "customer role" is superseded.
- **A portal scope ships with its tab.** `api-portal-scope-surface.test.js` enforces this (comment at `portal-auth.js:13-33`).
- **Customers never see unreviewed internal states or prices, with one allowlist constant per view** (`view.js:15-29`).
- **House rules for this scope**, as set in the scoping request: prefill instead of blank entry; default to undecidable; something built but never wired counts as not existing; every PR ships its caller. Three of these also appear in `PENDING.md:212-241`, but there they are **candidates** for a product manifesto that was asked for, not decided rules. This scope treats them as binding because the request does, not because PENDING.md decided them.
- **No task-manager integration and no Kanban-first view** (`PROJECT_MANAGEMENT_SCOPE.md` §0, §5).
- **Ticketing:** buy a tool, or build one table only if the inbound-complaint gate query passes (`PRODUCT_CATALOG_SCOPE.md:230-231`).
- **Payments:** OEMs pay through SAP accounts payable with TDS withheld, not by card or UPI (the owner's recorded note on payment practice, outside the repo). So there is no portal pay button, and the pay-token path has no customer to serve (D18).
- **Mode A / Mode B** order processing is a tenant setting, default A (`221_so_processing_mode.sql`).

**Not decided, although it reads as if it were:** the portal go-live bar. `CUSTOMER_PORTAL_AUTH_DESIGN.md` is marked "draft for review" (`:3`). Its §6 (`:154-159`) says to assume SSO is required until told otherwise, and puts MFA, per-user audit, drawing-download controls and data-residency confirmation before launch. That is a recommendation in a draft, so it is an open decision here (D20).

### 2.2 Open decisions

Each decision has a recommended default, and the PRs are written against that default. Nothing here is assumed: section 5 says which PRs wait on which decision, and a PR that waits is not listed as decision-free.

**D1. Who is this built for? (the GAP_ANALYSIS warning)**

`GAP_ANALYSIS.md:495` says Anvil's users are ops and procurement, not quota-carrying account executives, and warns against chasing rep tooling. N1 and N3 ask for rep tooling. This is the owner's call, and it is recorded here rather than assumed.

- **Recommended:** build for the **account owner** in an engineering-sales firm.
  - This is the sales or applications engineer who owns a set of plant accounts, prepares their spares quotes, chases the answers and, in practice, also watches the order through.
  - Ship ownership, pipeline visibility, a chase list and the portal.
  - Ship **no** quotas, targets, commission, rep forecasting, activity scoring or coaching.
  - This reads the warning as aimed at the enterprise SaaS sales core it names (coaching, multi-threading, CRM hygiene for its own sake), not at knowing who owns an account.
- **If the owner says "quota-carrying reps":** add a targets table and attainment on the team view later. Nothing in this scope changes.
- **If the owner says "ops only, no rep tooling":**
  - drop PR 9 (the team pipeline view);
  - the Mine toggles in PRs 6 and 11 default to All;
  - keep PRs 5, 6 and 7: PR 5 because the chase list and the cadence need someone to route to, and PRs 6 and 7 because they fix a screen that is already in the nav and broken;
  - the portal is unchanged.
- **Gates:** PR 9, and the toggle defaults in PRs 6 and 11.

| # | Question | Recommended default | If the owner chooses otherwise | Gates |
|---|---|---|---|---|
| D2 | What is a "manager"? | A role: `sales_manager` or `admin` see every rep. Finance keeps its approve rights elsewhere, but loses the team pipeline view it gets today by accident (`pipeline.js:33`). | A hierarchy. Add `tenant_members.reports_to uuid` (one migration); `_lib/sales-scope.js` resolves each manager's reports; the member editor sets it; the rep picker lists only reports; `opportunity.assign` (PR 7) narrows to a manager's reports. | PR 9 |
| D3 | Is rep scope a wall or a filter? | A default filter: "Mine" by default for `sales_engineer`, "All" one click away. Accounts, quotes and opportunities stay readable across the whole seller tenant. | A wall. Enforce `_lib/sales-scope.js` in the GET handlers of customers, opportunities and quotes, **and** of orders, pending SOs, shipment tracking, copilot tools and exports, or it leaks. Shared accounts then need co-ownership. | PR 6 (only the toggle's default) |
| D4 | Who owns a quote's follow-up? | Worked out at read time, never stored: the linked opportunity's owner, else the account owner, else `quotes.created_by`. Because a manager sends every quote (D21), the sender is never used. | Store `quotes.owner_id` (a migration plus an assignment control). It becomes a fifth "rep" column that drifts when an account is reassigned. | PR 11, 12 |
| D5 | Which registry is the customer's asset view? | The **shared spare matrix**, labelled as the worksheet it is. `equipment_hierarchy` stays canonical for engineering and reliability, unlinked for now. Record this as an amendment to `INSTALLED_BASE_CANONICAL.md`, not a reversal. | Link first: a unique key on `equipment_hierarchy` (there is none at `006:412-413`), `spare_matrix_rows.equipment_id` with a backfill, and a write-through on save. About three PRs before PR 14, all on the matrix autosave path. | PR 14 |
| D6 | Which quotes does the portal show? | `quotes` (068) **authored in Anvil and actually sent**: `ingest_source is null and sent_at is not null`, current version only (the highest version with `sent_at` set). Uploaded PDFs (ingested quotes) and `opportunity_quotes` (203) stay internal. | Show ingested quotes as header plus PDF only, behind an explicit reviewed "publish" flag (one migration). Their lines are unreviewed extractions and must never be shown. | PR 15 |
| D7 | Automatic customer nudge emails (signed "The team", sent from the tenant mailbox)? | A per-tenant switch (migration 228). **Off for the pilot tenant**; on for existing tenants, so nothing changes for them. The timing, stop and reply fixes ship either way. | Always on: drop migration 228 and the toggle. PR 12 keeps the owner, timing, terminal-status, escalate-once and reply fixes. | PR 12 |
| D8 | What may the customer see for each applicable spare? | Part number, their part number, category, item type, how many guns on the sheet list it, and quote status. Never the recommended quantity, min/max, priority, remarks, lead-time text, `quote_ref`/`po_ref`, or prices they were not quoted. | Show the recommended quantity (the "opposite sign" trust play, `GAP_ANALYSIS.md:1022-1027`) by adding it to `PORTAL_SPARE_KEYS`. First stop recompute from overwriting the operator's min/max (`recompute_recommended.js:129-131`). | PR 14 |
| D9 | What status does "PR raised" set? | **ACCEPTED**, with the PR number on the response row. See the reasons and the consequences below this table. | Keep it SENT. See what that requires below this table. | PR 16, 18 |
| D10 | What date does the customer see? | Only a date a person committed to: `orders.committed_delivery_date`, else "Not committed yet". Never the ETD at source or a supplier acknowledgement ETA (`pending_sales_orders.js:160`). Never `order_schedule_lines`, which hold **the customer's own** delivery schedule (`006:584-585`). | Per-line commitments: an `order_line_commitments` table keyed like `dispatch_lines`, storing `part_no` and showing "not committed" when the line moves. Or wait for the float-gated ETA on the logistics track. | PR 17 |
| D11 | What does `customer_lead_times.lead_days` mean? | Days from PO date to delivery for that customer (and product category), the way a spares seller quotes "4 weeks from PO". This **changes the meaning of existing rows**: the admin screen labels the field only "supplier or customer · days" (`admin.tsx:3522`), and the only reader treats it as internal handling time added after the supplier ETA, default 3 (`delivery/promise.js:50-56`). So PR 19 relabels the field, shows the chip only for rows saved after the relabel (`updated_at`, stamped on every admin save at `admin/lead_times.js:43`), and stops `promise.js` reading the table. | It is internal handling time, as `promise.js` uses it. Then there is no chip until a customer-safe supply date exists, and PR 19 is dropped. | PR 19 |
| D12 | What is the portal's scope unit? | One person has one portal identity, for one customer row of one tenant. Plant is a display grouping (`spare_matrix.customer_location_id`), not a security boundary. An invite refuses an email that already has a portal identity **in any tenant**, or already has an auth account of any kind (staff, or another tenant's portal user), because both portal lookups read one row by `auth_user_id` with no tenant filter (`portal-auth.js:45-47`, `login.js:42-44`) and a second row breaks that person's sign-in everywhere. | Group users: expand through `parent_customer_id`, after fixing the upsert that wipes it on partial edits (`customers/index.js:172`, `customers.tsx:206-216`). Per-plant users: `portal_users.location_ids`, failing closed on rows with no plant. Several tenants per person: every portal lookup then takes a tenant and the sign-in asks which supplier. | PR 13, 17 |
| D13 | Who at the customer may respond? | Any active portal user of that customer; the row records who did. | Only `portal_admin` may raise a PR or decline. That enforces `portal_users.role` for the first time. | PR 16 |
| D14 | Are spares quotes opportunities? | No. Two lanes: opportunities for project business, open quotes for spares, both keyed on the owner. | `to_quote` and portal requests create or link an `order_mode = 'SPARES'` opportunity (enum `006:17-23`). Funnel and forecast then count spares and need a rule for repeat quotes. | PR 9, 23 |
| D15 | Which gun drawings can the customer open? | Committed drawings that a person has **released to the customer**, recorded in a new stamp (`gun_drawings.released_at`, `released_by`, migration 229) set by a "Release to customer" action gated on a new `drawing.release` server action. `approval_status` stays for the engineering approval workflow it was provisioned for (`197:12-14`). Approving a drawing for engineering therefore never publishes the uploaded EG, 2D or 3D file, which even some staff roles cannot download (`auth.js:223-226`). | Reuse `approval_status = 'approved'` as the release flag and label the button "Release to customer". Then the future engineering approval workflow needs its own column, and until it has one, "approved" means "released". Or: sharing the matrix counts as release, and all committed drawings show. | PR 14 |
| D16 | Prices in the portal? | Discounted unit price and line amount on authored, sent, current-version quotes. A maintenance engineer raises the SAP PR with the price next to their own material code. | PDF only, no structured prices. | PR 15 |
| D17 | Does a PO convert the quote automatically? | Only on a **unique** normalised PR-number match, for the same customer, within 365 days, only when every line of the **fully extracted** PO agrees on one PR number, and only when the order is **approved**. Never through part overlap. | Link only, and a person converts. Nudges already stopped at "PR raised", so the cost is a stale ACCEPTED status. | PR 18 |
| D18 | Legacy URL tokens? | Retire every token path in one PR, after one measurement query. See the full list below this table. | Keep them for a measured period: PR 2 waits, and the rewired portal kinds keep answering a token through their allowlists until it lands. Or keep only the pay path; see below. | PR 2 |
| D19 | What can a customer request a quote for? | Only parts on a shared matrix's applicable list, with quantities they choose. | Free-text lines land in the draft as unmatched lines for the rep to map. The rate limit and line cap stay. | PR 21 |
| D20 | The portal sign-in bar, for the pilot and for go-live | See below this table. | Follow the draft design: see below this table. | PR 13, 25 |
| D21 | May a `sales_engineer` send a quote? | No change. Send stays a `sales_manager` or `admin` action (`quotes/send.js:158-161`, `auth.js:222`). The rep prepares and prices the draft; a manager approves and sends it. Follow-up ownership is computed (D4), so the chase list still lands on the rep. | Add a `quotes.send` server action that includes `sales_engineer`, move `send.js` from `requirePermission('approve')` to `write` plus that action, and keep the margin-floor rule (`quotes/index.js:370-385`) so a below-floor quote still needs an approver. One PR, no migration. | nothing; PR 12 and PR 20 are written for the default |

**D9 in detail.**
- Why ACCEPTED:
  - it is already a terminal status for both nudge handlers (`quote_accept.js:31`, `expiring_quote_nudge.js:39`);
  - `expire.js:27-31` only expires SENT and PENDING quotes;
  - so a quote that waits weeks for SAP purchasing is neither nudged nor expired;
  - the PO converts it (PR 18); if purchasing buys elsewhere, the customer or the rep marks it not needed and it is cancelled with a reason.
- Consequences of the default, which PR 16 carries in the same commit:
  - `_lib/ops-kpis.js:89-99` counts every quote with `accepted_at` as "Revenue by rep" (rendered at `sales-ops.tsx:280-295`). A raised PR is not revenue, so PR 16 makes it count CONVERTED quotes and relabels the card "Won by rep (PO received)", adding `converted_at` to the select at `analytics/ops_kpis.js:38`.
  - `sent_to_accepted` (`ops-kpis.js:75`) becomes the time to the customer's answer; PR 16 relabels it "Sent to customer answer".
  - The Won tab in `quotes.tsx` splits into "PR raised, awaiting PO" and "Converted".
- If the owner keeps it SENT instead:
  - `expire.js` and `expiring_quote_nudge` must learn to skip a `pr_raised` quote;
  - the link step must convert SENT directly;
  - the Won tab and the portal labels must read the response instead of the status;
  - otherwise the quote expires mid-purchase, and EXPIRED can only become CANCELLED (`quotes/index.js:41`);
  - the ops-kpis change is not needed.

**D18 in detail.** The repo's current position, written into `api-portal-scope-surface.test.js:88-92`, is to keep the token kinds because links already sent "may be in real use". D18 is the decision to change that, which is why PR 2 waits on it and rewrites that comment. Every token path, and the PR that ends it:

| Token path | What it does today | Ended by |
|---|---|---|
| `portal/accept_quote.js` order path (`:108-140`) | sets any order of the token's customer to APPROVED | PR 1 (unsafe whatever D18 says) |
| `portal/accept_quote.js` quote path on a quote with no customer (`:46`) | any token can accept it | PR 1 (unsafe whatever D18 says) |
| `view.js` legacy `kind=invoices` (`:97-101`) | serves draft and void invoices | PR 1 filters it to sent, partial, paid and overdue (`012:35-37`) |
| Minter: `quotes/send.js:102-126`, called at `:301` | `['quotes','accept_quote']` on every send | PR 2 |
| Minter: `invoices/send.js:35-54`, called at `:121` | `['invoices','pay']` on every invoice send | PR 2 |
| Minter: `_lib/pay-link.js:28-48`, called from `agents/_handlers/ar_collect.js:260` | `['invoices','pay']` on every dunning step | PR 2 |
| Minter: `spare_matrix/share.js:44-71` | reuses or mints a token and widens its scopes | PR 2 (PR 14 then adds publish) |
| Minter: `portal/tokens.js` POST (`:31-52`) | caller-chosen scopes, default `quotes, orders, invoices, pay`; client wrapper only (`anvil-client.js:437`) | PR 2 (POST returns 410; list and revoke stay) |
| Reader: `view.js`, every kind, through `resolvePortalAccess` (`portal-auth.js:73-84`) | reads by token | PR 2 |
| Writer: `accept_quote.js` legacy quote accept | ACCEPTED with no PR number | PR 2 |
| Writer: `portal/pay.js:15-25` | creates a payment-gateway order | PR 2 (410) |
| Writer: `portal/reorder.js:12-20` | inserts a non-enum `NEW` order | PR 2 (410) |
| Reader: `portal/invoice_pdf.js:11-21` | signed invoice PDF, `download_invoice` scope | PR 2 (410) |

- **Before PR 2 merges,** run the measurement query in the pilot runbook (§6). `view.js`, `accept_quote.js`, `reorder.js` and `invoice_pdf.js` write `portal_access_log` with `token_id`; `pay.js` does not, but every Stripe session it opens carries `anvil_portal_token_id` (`pay.js:103-107`). If the query shows real use, the owner revisits D18 before PR 2 lands.
- **Only after PR 2 is deployed,** so that nothing is still minting, the runbook revokes every outstanding token.
- **Rewired kinds before PR 2:** PRs 14, 15 and 17 change what `spares`, `spare_matrix`, `quotes`, `summary` and `orders` return, through one allowlist per view. Until PR 2 lands, a legacy token that holds the scope gets the same allowlisted answer as a session; it never gets more.
- **If the owner keeps the pay path:** `invoices/send.js` and `pay-link.js` keep minting pay-only tokens, and `pay.js` stays. The `/portal/<token>` link they email is a 404 today (`vercel.json:45-46`), so keeping the path also means giving it a route. Given how OEMs pay (§2.1), the recommendation is not to.

**D20 in detail.**
- **Recommended:** for a supervised pilot with named users, password sign-in, invite-only, login and recovery rate limits (PR 13), and drawing opens logged through short-lived signed URLs (PR 14). MFA and session refresh (PR 25) before any OEM user outside that pilot. SSO only when an OEM's security review asks for it. Data residency is confirmed with the OEM before the first invite, as a runbook question, not code.
- **This departs from the draft design in two places,** and the departure is the owner's to make: the draft says to assume SSO is required until told otherwise, and it puts MFA, per-user audit and drawing-download controls before launch (`CUSTOMER_PORTAL_AUTH_DESIGN.md:114-119,154-159`). What the recommendation already meets of the draft's Phase 5: per-user access logging (`portal_access_log.portal_user_id`, `199:41`, written at `view.js:35`), a logged open for every drawing, and short-lived signed URLs. What it does not: watermarking, idle and absolute session timeouts, and exportable audit.
- **If the owner follows the draft:** SSO is assumed and becomes a phase of its own before launch (several PRs, not scoped here), PR 25 joins the pilot slice, and data residency is settled before any invite.

### 2.3 Where the candidate designs disagreed

| Topic | wire-first | customer-first | model-first | This plan, and why |
|---|---|---|---|---|
| Asset registry | spare matrix | spare matrix | write-through to `equipment_hierarchy` | Spare matrix (D5). The write-through is a large change on the autosave path. Because `equipment_hierarchy` has no unique key, concurrent saves can create duplicate equipment rows. It would also block the portal until it lands. |
| Manager | role | `reports_to` | `reports_to` | Role (D2). `reports_to` is one migration away once a second manager exists. |
| Quote requests | a DRAFT quote | new `portal_quote_requests` table | a DRAFT quote | A DRAFT quote, with lines the server derives, a line cap and a rate limit. The rep's work object is the quote; a request table would be a second copy of it. |
| "PR raised" status | ACCEPTED | stays SENT | stays SENT | ACCEPTED (D9). Left SENT, the quote expires mid-purchase and can then never convert. |
| Where the requisition number lives | read the stored JSON | new column | new column | A new column, prefilled and editable, backfilled from the JSON (migration 231). A misread PR number needs a way to correct it. |
| When to link and convert | at approval | at order create | reconcile marks every quote it used as ACCEPTED | Link at reconcile (visible to staff, reversible); convert at approval; unique PR match on the fully extracted PO only (D17). See below this table. |
| Ready date | order level | per-line commitments with "commit all" | order level | Order level (D10). Schedule lines are the customer's schedule, not our promise; this corrects wire-first. "Commit all suggested" turns guesses into promises in one click. |
| Portal prices | yes | PDF only | authored sent quotes | Authored, sent, current version (D16). |
| Ingested quotes in the portal | shown by status | hidden | PDF only | Hidden (D6). Ingested quotes are SENT with extracted lines (`quote-ingest.js:276,293`). |
| Drawings | approved filter | publishing counts as review | not addressed | A separate customer-release stamp and a gated Release action (D15). |
| Nudges | switch, off for the pilot | keep on | off for the prospect | Switch (D7). |
| Escalation | `escalate_roles` to sales_manager | per-user bell | next action on the owner | A lane on the owner's chase list, once, then the goal ends. `escalate_roles` never reaches a sales manager (§2.4). |
| Identity guard | in `resolveContext` | in `ensureMembership` | in `resolveContext` | In `ensureMembership`, which covers all five callers. |
| Deep links | `/portal?quote=` | `/portal/:path*` rewrite | `/portal/:path*` rewrite | A query parameter on the existing rewrite. A catch-all rewrite would make the dead `/portal/<token>` links load the SPA. |
| Next action | touch log in `communications` | not modelled | stored `next_action_at` columns | `communications` touches, with a computed default labelled "default". A stored default cannot be told apart from a date a rep chose. |
| Plant | none | optional per-plant scope | `spare_matrix.customer_location_id` | The column, for display and grouping only (D12). |
| RLS `current_tenant_ids` | none | restrict to approved members | none | Left out; flagged as its own security PR (§9). It is a change to row-level security across every table. |
| Visibility wall toggle | none | none | `sales_visibility` | Not added. A wall that covers four endpoints looks like data segregation and is not (D3). |
| MFA | not built | a PR in the pilot | before production | PR 25, before production (D20). |

On linking and converting: converting when the order is created acts on an extraction nobody has reviewed. Marking every quote reconcile used as ACCEPTED would accept unrelated quotes that merely share a consumable part.

### 2.4 Claims corrected against the code

- **The requisition number is stored, not dropped.** customer-first and model-first said it is "extracted and dropped". In fact:
  - `so-intake.tsx:919-934` writes the whole extracted customer block to `orders.result.salesOrder.customer`;
  - `reconcile_quotes.js:134` already reads `payment_terms` from that same block.
- **It is stored only at header level, but the extractor reads one per line.**
  - `claude.js:186-206` tells the model that the OEM block layout prints a requisition in row 4 of every block, with the same 1000343964 example.
  - The only slot for it is `customer.requisition_no` (`claude.js:1326`).
  - So a consolidated PO carries only one PR of several. PR 4 adds a line-level slot to both adapters.
- **For a large PO, intake sees only page 1.** The order is created from a page-1 preview, reconcile is skipped (`so-intake.tsx:997-1035`), and the background worker later replaces `lineItems` and the customer block (`cron/extraction_jobs.js:749-765`). Any agreement check made at intake is therefore made on part of the PO.
- **`quote_accept` mints no tokens.** It sends plain text (`quote_accept.js:113-155`). Tokens are minted by five paths, listed in D18.
- **Quote send has no zero-price guard.** customer-first assumed one existed.
  - `quotes/send.js` refuses only a missing id, the wrong status, or no recipient (`:163,171,189`).
  - The margin-floor guard in the PATCH path (`quotes/index.js:370-385`) applies only where a floor is configured.
- **A rep cannot send a quote.** Send requires `quotes.approve` (`send.js:161`), held by `sales_manager` and `admin` only (`auth.js:222`). The goal owner set at send (`send.js:485`) is therefore always a manager.
- **An action that is not registered is not gated.** `hasAction` returns true for any action missing from `SERVER_ACTIONS` (`auth.js:234-239`), so `requireAction('x')` with an unregistered `x` admits every role.
- **`customers.tsx` has no multi-select.** A bulk "Assign owner" needs a new checkbox column (PR 5).
- **The lost-reason taxonomy is not empty for a new tenant.** Global rows are seeded at `006:845-852` and read by `admin/lost_reasons.js:17`, so requiring a reason on CLOSE_LOST blocks nobody.
- **`escalate_roles: ['sales_manager']` does not reach a sales manager.**
  - `notifyAdmins` writes one row with no recipient (`notifications.js:56-76`).
  - The bell loads only for admin and operator (`Shell.tsx:95,597`).
- **A guard in `resolveContext` alone leaves four other callers open.** These call `ensureMembership` directly:
  - `auth/verify.js:26`;
  - `auth/password_login.js:53`;
  - `auth/passkey/auth_finish.js:144`;
  - `auth/signup.js:94`.
- **There are two customer-merge implementations, and only one is live.** `customers/merge.js` (route `/customers/merge`, `router.js:983`) is the one a screen calls. `_lib/customer-merge.js` has no caller outside its test.
- **CI runs `apply-migrations.sh` once, not twice** (`.github/workflows/ci.yml:60`).
- **Migration 226's live state is unknown, not "unapplied".** The repo cannot show what has been applied.
- **"One customer row per plant, a GSTIN per plant" is an overstatement.** GSTIN is issued per state registration. The repo models plants three ways:
  - `customer_locations` (`006:123`);
  - a customer per plant in the seed data (`010:36-52`);
  - `parent_customer_id` (`137:9`).

---

## 3. Data model

All five migrations are additive and idempotent, and every new column is nullable or has a default:
- columns use `add column if not exists`, indexes use `create index if not exists`;
- check constraints are added inside `do $$ ... if not exists (select 1 from pg_constraint where conname = ...)`;
- a foreign key or column on a table whose apply state is unconfirmed is guarded by `to_regclass(...) is not null`.

**No table is created and no enum value is added**, so the add-value-then-use rule never comes up. Each migration is applied by hand, before the PR that reads it.

### Prerequisites on the pilot database

Merged is not the same as applied, and a missing prerequisite would show up as a failing PR, not as a failed runbook check. So the list is built from every column a pilot PR reads, and the runbook checks all of them before applying 227 to 231.

| Migration | What a PR reads from it | PRs |
|---|---|---|
| 033 | `portal_quote_acceptances` | 1, 16 |
| 069 | `portal_quote_acceptances.quote_id`, nullable `order_id` | 1, 16, 18 |
| 105 | `item_customer_parts` | 14 |
| 117 | `extraction_jobs.order_id`, `status` | 18 |
| 138 | `quotes.field_sources` | 20, 21 |
| 159 | `spare_matrix`, `recommended_spares` | 14, 21, 23 |
| 171 | `recommended_spares.item_id` | 14 |
| 188 | `quotes.ingest_source` | 15, 22 |
| 189 | `communications.object_type`, `object_id`, `customer_id`, `document_type` | 10, 12 |
| 193 | `dispatch_lines` | 3, 17 |
| 197 | `gun_drawings` (listed as unconfirmed live in the survey) | 14 |
| 199 | `portal_users` (listed as unconfirmed live) | 1, 13 to 17 |
| 203 | `opportunity_quotes.sent_by` | 9 |
| 204 | `orders.opportunity_id` | 18 |
| 207 | `orders.committed_delivery_date` | 17, 19 |
| 215 | `quotes.revision` | 15 |
| 221 | `tenant_settings.so_processing_mode` | runbook (Mode A/B) |
| 226 | `delivery_note` in the extraction-kind checks (listed as unconfirmed live) | 3 |

The apply-state query (every row it returns is a missing prerequisite):

```sql
with expected(mig, tbl, col) as (values
  ('033','portal_quote_acceptances','signature_name'),
  ('069','portal_quote_acceptances','quote_id'),
  ('105','item_customer_parts','customer_part_number'),
  ('117','extraction_jobs','order_id'),
  ('138','quotes','field_sources'),
  ('159','recommended_spares','quote_id'),
  ('171','recommended_spares','item_id'),
  ('188','quotes','ingest_source'),
  ('189','communications','document_type'),
  ('193','dispatch_lines','lr_number'),
  ('197','gun_drawings','approval_status'),
  ('199','portal_users','auth_user_id'),
  ('203','opportunity_quotes','sent_by'),
  ('204','orders','opportunity_id'),
  ('207','orders','committed_delivery_date'),
  ('215','quotes','revision'),
  ('221','tenant_settings','so_processing_mode')
)
select e.mig, e.tbl, e.col
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
where c.column_name is null
union all
select '226', 'extraction_runs', 'kind check allows delivery_note'
where not exists (
  select 1 from pg_constraint
  where conname = 'extraction_runs_extraction_kind_check'
    and pg_get_constraintdef(oid) like '%delivery_note%'
);
```

### 227_customer_owner.sql (PR 5)

| column | type | why |
|---|---|---|
| `customers.owner_user_id` | `uuid null references auth.users(id) on delete set null` | The account owner. See notes below. |
| index `customers_owner_idx` | `(tenant_id, owner_user_id) where owner_user_id is not null` | The Mine and Unassigned filters. |

Notes on `customers.owner_user_id`:
- it uses the name the code already reads (`credit_review_request.js:24`);
- its foreign key has the same shape as `opportunities.owner_id` (`006:311`);
- it is written only through a dedicated endpoint, never through the `POST /api/customers` upsert, which writes `body.x || null` for every column (`customers/index.js:133-176`).

No backfill. An owner nobody chose is unknown and shows as "Unassigned". A suggestion is computed at read time and saved only on click.

### 228_quote_nudge_switch.sql (PR 12)

| column | type | why |
|---|---|---|
| `tenant_settings.quote_customer_nudges_enabled` | `boolean not null default true` | Per-feature flags live on `tenant_settings` (`205:12`, `206:93`). See notes below. |

Notes:
- the default is true so existing tenants keep today's behaviour, the rule migration 221 states;
- it is set to false for the pilot tenant from the Agents screen;
- if the column is missing, `armQuoteAgentGoals` treats the switch as on, which is today's behaviour for existing tenants;
- **that fallback fails open for the one tenant that wants it off,** so it is contained in two places: the toggle returns a 503 naming migration 228 when the column is missing, as `admin/so_processing_mode.js:88-97` does for 221, and the pilot runbook confirms 228 is applied and the switch is off **before the pilot tenant's first Send**.

### 229_spare_matrix_publish.sql (PR 14)

| column | type | why |
|---|---|---|
| `spare_matrix.shared_at` | `timestamptz null` | Null means not visible in the portal. Today every matrix of the customer is visible (`view.js:103-109`). |
| `spare_matrix.shared_by` | `uuid null` | Who published it (`ctx.user.id`). |
| `spare_matrix.customer_location_id` | `uuid null references customer_locations(id) on delete set null` | The plant, so a multi-plant OEM's portal groups guns by plant and requests carry the plant. For display only, not a security boundary (D12). The foreign key proves only that the row exists, so PR 14 checks tenant and customer in the handler. |
| `gun_drawings.released_at` | `timestamptz null`, added only if `to_regclass('public.gun_drawings')` is not null | Null means the customer cannot open it (D15). |
| `gun_drawings.released_by` | `uuid null`, same guard | Who released it (`ctx.user.id`). |

`shared_at` and `released_at` decide what customers can see, so they get **no fallback for a missing column (Postgres error 42703)**. If a column is missing, the portal shows an error, not every matrix or every drawing.

Backfill of `shared_at` and `shared_by`:
- the source is the latest `audit_events` row with action `spare_matrix_shared` for that matrix. `share.js:73-78` writes that row with an object `detail`, which is stored as JSON text;
- it applies **only where that row's `detail` names the matrix's current customer**;
- `audit_events.detail` is a `text` column (`001:336`) that other actions fill with non-JSON text, for example `"by=<name> v<n>"` (`accept_quote.js:91`) and `"<number> v<n> expires_at=..."` (`expire.js:49-50`). Postgres does not promise to apply the `action` filter before a `detail::jsonb` cast in the same query, so **the backfill never casts `detail`**:
  - it filters `action = 'spare_matrix_shared'` in a `materialized` CTE;
  - it reads the customer id with a regular-expression `substring(detail from '"customer_id"\s*:\s*"([0-9a-fA-F-]{36})"')`;
  - it compares that with `m.customer_id::text`, and compares `m.id::text` with `object_id`, which is also text;
  - nothing is cast, so no row can abort the migration;
- rows that do not match stay unshared; this uses a recorded act of sharing, not a guess;
- CI cannot catch a failure here today because its `audit_events` table is empty. So PR 14 adds a CI step that seeds two rows: one non-JSON detail row under another action, and one malformed `spare_matrix_shared` row. The step then re-applies 229 (it is idempotent) and asserts that the migration succeeds and shares nothing it should not.

No backfill of `released_at`: a release nobody recorded is unknown.

### 230_quote_customer_responses.sql (PR 16)

This extends the existing `portal_quote_acceptances` (`033:24-38`; `quote_id` and a nullable `order_id` from `069:11-17`). Today only the unwired `accept_quote.js` writes it, and nothing reads it.

| column | type | why |
|---|---|---|
| `response_kind` | `text not null default 'accepted'`, check in (`accepted`, `pr_raised`, `revision_requested`, `not_needed`) | `quote_status` (`068:35-38`) has no "revision requested" state and nowhere to hold a PR. Existing rows were acceptances, so the default is their true meaning. |
| `pr_number` | `text null` | The SAP PR number as the customer typed it. |
| `pr_number_norm` | `text generated always as (nullif(upper(regexp_replace(coalesce(pr_number,''),'[^A-Za-z0-9]','','g')),'')) stored` | The match key, so spaces, slashes and letter case never block a match. |
| `pr_date` | `date null` | Prefilled with today. |
| `note` | `text null` | What to revise, or why the quote is not needed. |
| `quote_version` | `int null` | The version answered; only the current version may be answered. |
| `portal_user_id` | `uuid null`, foreign key to `portal_users` on delete set null, added only if that table exists | Who answered from the portal. |
| `recorded_by` | `uuid null` | The staff user (`ctx.user.id`) when a rep records the answer for the customer. |
| `channel` | `text not null default 'portal'`, check in (`portal`, `staff`) | Separates what the customer clicked from what a rep heard on the phone. |
| index | `(tenant_id, customer_id, pr_number_norm) where pr_number_norm is not null` | PR-number lookup at PO intake. |

`token_id` is already nullable (`033`), so rows from a signed-in session need nothing more.

### 231_order_requisition.sql (PR 18)

| column | type | why |
|---|---|---|
| `orders.customer_requisition_no` | `text null` | The PR number on the PO, prefilled from extraction and editable in the header, so a misread can be corrected. |
| `orders.customer_requisition_norm` | `text generated always as (...same expression...) stored` | The match key. |
| `orders.quote_link_source` | `text null`, check in (`pr_number`, `reconcile`, `convert`, `manual`) | Records how `orders.quote_id` was set, so reconcile stops overwriting a PR-number link with its price-primary quote (`reconcile_quotes.js:254`). If the column is missing, reconcile behaves as today. |
| index | `(tenant_id, customer_id, customer_requisition_norm) where customer_requisition_norm is not null` | Lookup by customer and PR number. |

Backfill: where `customer_requisition_no` is null, fill it from `result->'salesOrder'->'customer'->>'requisition_no'`, else from `result->'customer'->>'requisition_no'`. Both shapes are read at `tally-reconciler.js:57`. **No backfill of quote links**: that would be guessing. The column is a convenience for display and lookup; the link step never trusts it alone (PR 18 recomputes line agreement from the stored lines every time).

### Deliberately not added

| Not added | What carries the need instead |
|---|---|
| A teams table, `tenant_members.reports_to` | Manager is a role (D2). |
| Quotas, targets, commission | Out of scope (D1). |
| `quotes.owner_id` | The owner is worked out at read time (D4). |
| A tasks, activities or follow-ups table; `next_action_at` columns | `communications` touches. The next date is the latest touch's `metadata.next_followup_at`, else a default labelled as such. |
| Per-user notifications | The chase list on Home. |
| A `portal_quote_requests` table | A DRAFT quote with lines the server derives (PR 21). |
| A portal login-attempts table | The existing `magic_link_attempts` (`059:50`), with identifiers prefixed `portal_login:` and `portal_recover:` so they never collide with magic-link's `email:` and `ip:` keys (`auth/magic_link.js:110-119`). |
| `order_lines`, `order_line_commitments` | The order-level committed date (D10). |
| `spare_matrix_rows.equipment_id`, write-through | D5. |
| `portal_users.location_ids`, per-plant scope | D12. |
| `quotes.customer_pr_number` | The PR lives on the response row. |
| Any `quote_status` or `order_status` value | None needed; "PR raised" is ACCEPTED plus a response row. |
| A sales visibility wall setting | D3. |

### How existing data migrates or links

- **`spare_matrix_rows`:** unchanged. Customers see a matrix only once it is shared, and a shared matrix shows its rows exactly as today. Behaviour change: matrices that were never shared disappear from any existing portal session.
- **`gun_drawings`:** `released_at` starts null, so no drawing is visible in the portal until someone releases it. Share warns how many committed drawings are not released.
- **`equipment_hierarchy`, `equipment_installed_parts`:** untouched and still canonical. PR 14 adds a dated amendment note to `INSTALLED_BASE_CANONICAL.md` saying the customer-facing view is the shared worksheet until the link exists.
- **`recommended_spares`:** read as the applicable-spares list. `installed_qty` is shown as "guns on this sheet that list it", which is what it is.
- **`opportunities`:** `owner_id` unchanged; new opportunities default to the account owner. Existing quotes stay unlinked from opportunities; nothing guesses a link.
- **`customers`:**
  - every owner starts null ("Unassigned");
  - PR 5 suggests whoever owns a strict majority of the account's opportunities and authored quotes over the last 365 days;
  - the suggestion is saved only on click.
- **`quotes`:** no new columns. Quotes ingested before PR 22 keep `expires_at` null and show "Validity unknown".
- **`portal_quote_acceptances`:** existing rows become `response_kind = 'accepted'`.
- **`portal_tokens`:** revoked by the runbook after PR 2 is deployed, not by a migration.
- **`orders`:** the requisition number is backfilled from the JSON already stored.
- **`agent_goals`:** goals armed before PR 12 keep their owner. The terminal-status, escalate-once and reply fixes apply to them as soon as the handler ships.
- **`communications`:** touches are new rows with `document_type = 'rep_touch'` and `status = 'sent'`, never queued.

---

## 4. Flows

### 4.1 A rep's day

1. **Home (`#/`, `home.tsx`): My follow-ups** (PR 11, extended by PRs 12, 15, 16 and 21).
   - Data: `GET /api/quotes?mine=1&followup=1` and `GET /api/sales/opportunities?followup=1`.
   - Lanes, in this order:
     - new customer requests;
     - revision requested;
     - customer replied by email (when the reply can be traced, PR 12);
     - overdue;
     - due today;
     - automatic follow-ups ran out;
     - PR raised and no PO yet, with its age;
     - no next step set.
   - Each row shows the customer, quote, owner and last touch.
   - It shows "Viewed 2 Oct" when the customer opened the quote in the portal.
   - Its next date is marked **rep** or **default** (sent date plus 3 business days).
   - A quote whose next version has been sent is superseded and leaves the list.
2. **Open a quote** in QuoteDetailDrawer.
   - The Follow-up tab lists touches and automatic nudges.
   - "Log a touch" (call, meeting, whatsapp, visit, note) posts to `/api/communications` with the next date prefilled.
   - The response block shows, for example, "PR 1000343964 raised 3 Oct by Asha Rao (portal)".
   - "Record customer response" posts to `/api/quotes?action=respond&id=` for answers heard by phone or read in an email.
3. **Quote spares** from the Spares Matrix (`nav.ts:44`).
   - Import the customer's gun sheet, autofill with matchSpares, and recompute recommended spares.
   - "Feed to quote" (`POST /api/spare_matrix/<id>/to_quote`) creates the draft, with prices prefilled from the rate contract or the last quote (PR 20).
   - The rep checks the prices and submits the draft for approval.
   - **A sales manager approves and sends it** (`POST /api/quotes/send`, gated on `quotes.approve`, `send.js:158-161`; D21).
   - Send arms the cadence only if the tenant switch is on. The cadence belongs to the quote's owner (D4), not to the manager who clicked Send.
4. **Opportunities (`#/opps`):** "Mine" by default; edit stage, close date, probability and lost reason; claim an unowned opportunity (`PATCH /api/sales/opportunities`). "New quote" on an opportunity opens the quote form with the opportunity and its customer preselected (PR 8).
5. **Customers (`#/customers`):** three panels:
   - Account owner;
   - Portal users;
   - Account (opportunities, quotes, spares never quoted).
6. **The PO arrives.**
   - so-intake extracts it. The SO workspace shows the PR number on each line with its OCR marker, and warns when the lines carry more than one (PR 4).
   - Once the full PO is extracted, reconcile links it to the quote by PR number. QuotesStrip shows "Matched by PR 1000343964", and the header editor shows the PR number with its OCR marker.
   - Approval in the SO workspace converts the quote, which then leaves the chase list.
7. **Commit and despatch.**
   - Set the committed delivery date; after PR 19 a chip suggests "PO date + 30 days".
   - At despatch, "Upload delivery challan" in the SO workspace (PR 3) writes `dispatch_lines`, after checking the challan names this order.

### 4.2 A manager's view

- **Quotes to approve and send.** Every quote send is a manager's click today (D21). The zero-price confirmation (PR 20) therefore appears to the manager, at the moment of sending.
- **Sales Ops (`#/sales-ops`)** (PR 9). The Rep picker passes `owner_id` to `GET /api/analytics/pipeline`. It shows:
  - `by_rep` with names and an Unassigned row;
  - open spares-quote value per owner;
  - stalled deals with opportunity and customer names;
  - "Won by rep" with names (PR 16 changes what it counts, D9).
- **Home:** the same chase list with an owner filter, so a manager can read any rep's list or the whole team's.
- **Customers:** an Unassigned filter and bulk "Assign owner" (PR 5).
- **Opportunities:** All, and reassign owner (PR 7).
- **Agents (`#/agents`):** the automatic-nudge switch and the owner of each goal (PR 12).

### 4.3 The customer's loop (portal SPA at `/portal`)

| Step | Customer sees or does | Endpoint | Anvil records |
|---|---|---|---|
| Invited | Gets an email from the rep, lands on `/portal`, sets a password | `POST /api/portal/auth/invite` (staff), `POST /api/portal/auth/set_password` | `portal_users` row: invited, then active |
| Assets | Shared matrices by plant (line, station, robot, gun, timer, ATD), released drawings, and applicable spares with their own part numbers and quote status | `GET /api/portal/view?kind=spares\|spare_matrix` | access log |
| Drawing | Opens a released drawing | `GET /api/portal/drawing?id=` (short-lived signed URL) | access log entry `drawing:<id>` |
| Request (PR 21) | Ticks spares, with quantities prefilled, and adds a note | `POST /api/portal/request_quote` | a DRAFT quote with origin `portal_request`, at the top of the owner's list |
| Quote | "Being prepared", then "Awaiting your response" with lines, prices and the PDF | `GET /api/portal/view?kind=quotes` | access log entry `quote:<id>` |
| Respond | PR raised (PR number, date prefilled), Revise (with a note), or Not needed (with a reason) | `POST /api/portal/accept_quote` with a signed-in session | a response row. PR raised: ACCEPTED. Revise: stays SENT, goals paused. Not needed: DECLINED, or CANCELLED if a PR was raised earlier. The customer sees their own response as the label ("You marked this not needed") |
| PO | "PR 1000343964 raised, awaiting PO", then "PO 4500123456 received" once the order is approved | none (staff side) | `orders.customer_requisition_no`, `quote_link_source`, quote CONVERTED |
| Order | Per line: ordered, despatched, balance, committed date or "Not committed yet", despatch date, LR, invoice | `GET /api/portal/view?kind=orders` | access log |

These never leave the server:
- supplier, source PO, vessel, port, origin, and the supplier's invoice number on an import consignment;
- ETD at source;
- rates on items the customer was not quoted;
- internal statuses;
- unreviewed extractions;
- recommended quantities;
- the customer's open-invoice count and contact email from the summary.

---

## 5. PR breakdown

The PRs are listed in merge order. Every PR ships the screen that calls it and a test that the screen sends the new field. Sizes are S (under a day of review) or M; none is L.

**Decision-free, can start now:** 1, 3, 4, 5, 7 (after 6), 8, 10, 20, 22. PR 6 can start too; only the default position of its toggle waits on D3 (and on D1). Every other PR names the decision it waits on.

### PR 1. Close the portal's unsafe holes before anyone is invited

**Needs:** N4. **Migration:** none; reads 199 and tolerates its absence (below). **Size:** S. **Depends on:** none. **Waits on:** nothing. Decision-free: everything here is unsafe whatever D18 says.

**API**
- `accept_quote.js`:
  - the order path (`:108-140`) returns 410;
  - refuse a quote whose `customer_id` is null (`:46`);
  - audit rows write `actor`, not `actor_id` (`:87,144`).
- `tenancy.js` `ensureMembership` (`:44`): when the auth user has a `portal_users` row, insert nothing and return no membership.
  - The check runs on the insert path only, after the existing-membership check (`:51-62`), so existing staff are untouched.
  - It covers all five callers: `auth.js:134`, `auth/verify.js:26`, `auth/password_login.js:53`, `auth/passkey/auth_finish.js:144` and `auth/signup.js:94`.
  - A missing-relation error (Postgres `42P01`, or PostgREST `PGRST205`) means migration 199 is not applied, so no portal identity can exist: onboarding proceeds as today.
  - Any other read error fails the call with 500, the way the `tenant_members` lookup fails at `:55-59`. Failing open on an unknown error would onboard a portal user as staff.
- `view.js`:
  - `CUSTOMER_VISIBLE_ORDER_STATUSES` (`:27-29`) becomes APPROVED, EXPORTED_TO_TALLY and RECONCILED (enum at `001:118-121`);
  - the legacy `kind=invoices` (`:97-101`) serves only `sent`, `partial`, `paid` and `overdue` invoices (`012:35-37`).

**Caller:** none changes; PortalHome still calls spares and spare_matrix.

**Tests**
- Accepting with an `order_id` returns 410.
- A quote with no customer returns 403.
- The audit row carries `actor`.
- `ensureMembership` with a portal identity inserts nothing when reached through `verify.js` and `password_login.js`, as well as through `resolveContext`.
- `ensureMembership` with no portal identity and a `42P01` from `portal_users` inserts the membership; with any other error it throws 500.
- A token read of `kind=invoices` returns no `draft` or `void` invoice.
- The status list contains only values present in the enum text of `001_init.sql`.
- The scope-surface test stays green.

**Wires:** nothing new; closes the holes listed in §9.

### PR 2. Retire the legacy URL tokens

**Needs:** N4. **Migration:** none. **Size:** M. **Depends on:** 1. **Waits on:** D18 (and its measurement query, §6).

**API**
- Stop all five minters:
  - `quotes/send.js` stops calling `issuePortalTokenForQuote` (`:102-126,301`) and drops the dead `/portal/<token>?quote=` line from the email; the signed PDF link stays;
  - `invoices/send.js` stops calling `issuePortalTokenForInvoice` (`:35-54,121`) and drops its dead `/portal/<token>` line; the signed PDF link stays;
  - `ar_collect.js:260` stops calling `issuePayLinkForInvoice`; the `[PAY_LINK]` placeholder takes the existing fallback (`pay-link.js:56-60`), reworded so it no longer promises a link;
  - `spare_matrix/share.js` stops reusing or minting tokens (`:44-71`) and returns the `/portal` link;
  - `portal/tokens.js` POST returns 410; GET, revoke and DELETE stay so an admin can see and revoke what is left.
- Close every token route:
  - `resolvePortalAccess` drops its token branch (`portal-auth.js:73-84`), so `view.js` answers sessions only and a request with `?token=` gets 401 "sign in";
  - `accept_quote.js`, `pay.js`, `reorder.js` and `invoice_pdf.js` return 410 to any token request. Their STATIC_ROUTES rows stay, so an old caller gets a clear answer rather than a 404.
- Rewrite the comment in `api-portal-scope-surface.test.js:88-92`, which keeps token kinds because links "may be in real use", to record D18, its date and the measurement result.

**Caller:** none; this PR removes surface. The unused `createToken` client wrapper (`anvil-client.js:437`) is deleted.

**Tests**
- Each of the five minters, run against a mocked client, inserts no `portal_tokens` row.
- The quote and invoice emails contain no `/portal/` URL; the dunning body contains no `/portal/` URL and no `[PAY_LINK]`.
- A token request to `view`, `accept_quote`, `pay`, `reorder` and `invoice_pdf` is refused.
- `tokens.js` POST returns 410; PATCH revoke still works.
- A session read of `kind=spares` still works.

**Runbook:** after deploy, revoke every outstanding token (§6).

### PR 3. Delivery challan upload in the SO workspace

**Needs:** N4. **Migration:** none (needs 193 and 226 applied). **Size:** S. **Waits on:** nothing. Decision-free.

**API:** `documents/delivery_note_ingest.js` stops trusting an explicit `order_id`. Today it skips every check when one is passed (`:100-142`) and writes the rows at `:191`. A challan uploaded on the wrong order therefore lands there silently, and PR 17 would then show those despatches to the customer.
- The order must belong to this tenant, or 404.
- If the challan carries `buyer_po_no`, it must match the order's `po_number` under the same `poKey` normalisation the matcher uses.
- If it carries `invoice_no` and an invoice with that number exists on another order, that is a mismatch.
- A mismatch writes nothing and returns `ok: false, reason: 'order_mismatch'`. The response includes the candidates the matcher finds for the challan's own references (the same matcher as the no-`order_id` branch).
- A challan with no PO or invoice reference, or an invoice number not on file (Tally invoices are not mirrored), is accepted against the order the operator chose, and the audit row says so ("order chosen by operator; challan carries no checkable reference").

**Screen:** "Upload delivery challan" in `so-workspace.tsx`:
1. `documents.upload`;
2. `docai.extract({kind:'delivery_note'})`;
3. `documents.ingestDeliveryNote(documentId, extracted, orderId)`.

A refusal renders its reason and candidates, each with an "Open order" link.

**Tests**
- `ingestDeliveryNote` is called with `('doc-1', extracted, 'ord-1')`.
- API: a challan whose `buyer_po_no` names another order returns `order_mismatch` with that order among the candidates and writes no `dispatch_lines` row.
- API: another tenant's `order_id` returns 404.
- API: a challan with no references is written, and the audit detail names the operator's choice.
- The screen renders the mismatch reason and a candidate.

**Wires:** `ingestDeliveryNote` (`anvil-client.js:693-696`, no caller today); `dispatch_lines` (193).

### PR 4. Read the requisition number per PO line, and show it

**Needs:** N4. **Migration:** none. **Size:** S. **Waits on:** nothing. Decision-free.

**DocAI**
- Add `lines[].requisition_no` to the line schema in `claude.js` and `gemini.js`, in the same commit.
- Add it to `CANONICAL_LINE_FIELDS` (`_lib/docai/line-schema.js:33`). Without that, the value is kept but reported as an unknown field on every run (`:106-160`).
- The header-level slot stays.
- The Claude prompt already asks for it per block (`claude.js:186-206`); the Gemini prompt gets the same sentence.

**Screen (the reader, so the new field does not sit unread):**
- The SO workspace reconciliation table shows a "PR no." column whenever any line carries `requisition_no`, with the OCR marker that `stampOcrSources` already puts on every extracted field (`so-intake.tsx:914`).
- When the lines carry more than one distinct normalised value, the workspace shows a non-blocking notice: "This PO's lines carry 2 requisition numbers: 1000343964 (lines 1-4), 1000344102 (lines 5-9)". It is computed at render from the order's current lines. For a large PO it is therefore right once the background worker has merged the full line set, and nothing has to re-derive it.
- The header panel shows the header-level value from `result.salesOrder.customer.requisition_no`, read-only until PR 18 gives it a column.

so-intake keeps `out.normalized.lines` whole (`so-intake.tsx:631-632`) and posts them as `result.salesOrder.lineItems` (`:914-924`), so the field reaches the order by itself.

**Tests**
- A parity test asserts both adapter schemas declare `lines[].requisition_no` and both prompts name it.
- The line-schema conformance test passes with no unknown field.
- `so-intake.test` asserts the create body carries `lineItems[0].requisition_no` from a mocked extraction.
- The workspace renders the PR column with its OCR marker, and renders the notice for two values and not for one.

**Why now:** PR 18 must refuse to auto-link a PO whose lines carry different PR numbers, and it cannot see that without this slot. Gemini runs first, and a fix landing on one adapter only is this repo's most repeated drift; the parity test guards against it. If PR 18 never lands, operators still see every PR number on the PO.

### PR 5. Account owner on customers

**Needs:** N1, N3. **Migration:** 227. **Size:** M. **Waits on:** nothing. Decision-free.

**API**
- Move `resolveAssignee` (`service/visits.js:22-35`) to `_lib/assignee.js`.
- Add a new STATIC_ROUTES row, `/customers/owner`:
  - `GET ?suggest=1` returns, for each unowned customer, the member who owns a strict majority of its opportunities and authored quotes over 365 days, else null.
  - `POST {customer_ids[], owner_user_id|null, move_open_opportunities}` requires `requirePermission('write')` plus `requireAction('customer.assign_owner')` (sales_manager, admin). This PR registers the action in `SERVER_ACTIONS` and in `rbac.ts` ACTIONS, because an unregistered action admits every role (`auth.js:236`).
  - On POST, every id must belong to this tenant and the owner must be an approved member. It writes one audit row per customer. Optionally it also moves open opportunities owned by the previous owner or by nobody.
- `GET /api/customers` returns `owner_user_id` and the owner's name, and accepts `owner=me|<uuid>|none`.
- `admin/members.js` GET returns `status`.
- `credit_review_request.js:52-53` looks up the owner's email with `svc.auth.admin.getUserById`.

**Screen**
- The `customers.tsx` list gets an Owner column, a Mine/All/Unassigned filter, a row checkbox column and a bulk "Assign owner" action.
- A new `AccountOwnerPanel.tsx` sits beside CustomerHierarchyPanel (`customers.tsx:466-475`). The suggestion is preselected and saved only on click.

**Tests**
- `customers.assignOwner` is called with `{customer_ids:['cust-1'], owner_user_id:'u-2', move_open_opportunities:false}`.
- Bulk assign sends the checked ids.
- Accepting a suggestion sends the suggested id.
- API:
  - a non-member owner returns 400;
  - sales_engineer gets 403;
  - another tenant's customer id is rejected;
  - `POST /api/customers` with `owner_user_id` in the body leaves the owner untouched;
  - `customer.assign_owner` is present in both `SERVER_ACTIONS` and `rbac.ts` (the `audit-rbac.mjs` check passes);
  - the migration text uses `if not exists`.

**Wires:** the read of the missing column in `credit_review_request.js:24`; `resolveAssignee`; `requireAction`.

### PR 6. The Opportunities screen reads what the API returns

**Needs:** N1. **Migration:** none. **Size:** M. **Depends on:** 5. **Waits on:** D3 and D1 (the toggle's default only).

**API**
- `opportunities.js` GET (`:63-72`) adds `customer_name` and `owner_name`, using the two-query lookup already used at `quotes/index.js:118-141`.
- GET accepts `owner=me|<uuid>` through a new `_lib/sales-scope.js`, extracted from `analytics/pipeline.js:33-37`.
- POST (`:93`) defaults `owner_id` to the account owner, else the creator.

**Screen:** `opps.tsx`:
- reads `opportunity_name`, `customer_name`, `amount_inr`, `owner_name` and `close_date`;
- shows probability as 0 to 100 (`:404`);
- KPI tiles count real stage ids (`opportunities.js:24`);
- gets a Mine/All toggle;
- the create form also sends `order_mode` (accepted at `opportunities.js:84`) and `close_date`, and shows which owner it will default to.

**Tests**
- Rewrite `opps-list-view.test.tsx` against a fixture copied from a real GET response.
- The `createOpportunity` body is `{opportunity_name, customer_id, stage, amount_inr, order_mode:'SPARES', close_date}`.
- "Mine" calls `listOpportunities({owner:'me'})`.
- API: a POST without an owner defaults to the account owner.

### PR 7. Opportunities become editable

**Needs:** N1, N3. **Migration:** none. **Size:** M. **Depends on:** 6. **Waits on:** nothing (a D2 hierarchy would later narrow who may reassign).

**API**
- Register `opportunity.assign` (sales_manager, admin) in `SERVER_ACTIONS` and `rbac.ts` ACTIONS. Neither has an `opportunity.*` entry today (`auth.js:206-231`), and without one `requireAction` passes every role.
- PATCH (`:108-145`) accepts `owner_id`, with this rule in the handler:
  - a **claim**: the caller sets `owner_id` to their own `ctx.user.id` and the current `owner_id` is null. Needs only `write`;
  - **any other change** of `owner_id` (reassigning an owned opportunity, assigning an unowned one to someone else, or clearing it) calls `requireAction('opportunity.assign')`;
  - in both cases the new owner must be an approved member (`_lib/assignee.js`), and the change writes an audit row and a stage event.
- CLOSE_LOST requires a `lost_reason` code present in the taxonomy (tenant rows or global rows).

**Client:** `predictOpportunity` sends POST. Today `anvil-client.js:1628` sends GET and the server accepts only POST.

**Screen:** the `opps.tsx` detail gets:
- a Stage select that shows a 409 INVALID_STAGE_TRANSITION with its from and to stages;
- close date and probability;
- a "Claim" button on an unowned opportunity, and an Owner select for managers;
- a Lost reason select fed by `admin.listLostReasons`.

**Tests**
- `updateOpportunity` is called with `{id:'o-1', stage:'RFQ'}`, `{id:'o-1', owner_id:'u-2'}` and `{id:'o-1', stage:'CLOSE_LOST', lost_reason:'PRICE_HIGH'}`.
- Claim sends `{id:'o-1', owner_id:<me>}`.
- API:
  - a sales_engineer claiming an unowned opportunity succeeds;
  - a sales_engineer setting `owner_id` on an owned opportunity gets 403;
  - a sales_engineer assigning an unowned opportunity to someone else gets 403;
  - a sales_manager reassigns;
  - a non-member owner returns 400;
  - CLOSE_LOST without a reason returns 400;
  - `opportunity.assign` is present in both action lists.

**Wires:** `updateOpportunity` (`anvil-client.js:1615`); the lost-reason wrappers (`:1757-1759`); `opportunity_stage_events.owner_id` (written at `:137-144`).

### PR 8. Quotes link to opportunities from the UI

**Needs:** N1, N3. **Migration:** none. **Size:** S. **Waits on:** nothing. Decision-free. Pilot-plus.

**API:** the quotes PATCH allows `opportunity_id` in any non-terminal status, validated as this tenant's opportunity for the same customer. It is attribution, not commercial content; the other `editFields` (`quotes/index.js:361-363`) stay DRAFT-only.

**Screen**
- NewQuoteModal (`:104-114`) sends `opportunity_id` from a picker of the customer's open opportunities, preselected when exactly one exists.
- OpportunityQuotesPanel (rendered in the opportunity detail at `opps.tsx:424`) gets a "New quote" button that opens NewQuoteModal with this opportunity and its customer preselected. Today only `quotes.tsx` opens the modal; the panel only lists quotes (`OpportunityQuotesPanel.tsx:25-36`).
- The quote drawer gets an Opportunity field for linking an existing quote.

**Tests**
- The `quotes.create` payload includes `opportunity_id:'opp-1'`.
- "New quote" on the panel opens the modal with `opp-1` and its customer selected.
- API: another customer's opportunity is rejected.

**Wires:** OpportunityQuotesPanel (`:32`, always empty today); P2b attribution (`analytics/pipeline.js:95-102`). It does **not** make the opportunity line prefill (`quotes/index.js:265-283`) useful. That prefill reads `opportunity_line_items`, which cannot be created today because `line_items.js:25,98` writes a column no migration defines. That stays in §9's deliberately-left list.

### PR 9. Team pipeline view for managers

**Needs:** N1. **Migration:** none. **Size:** M. **Depends on:** 5, 6. **Waits on:** D1, D2, D14.

**API**
- `_lib/sales-scope.js` defines a manager as sales_manager or admin, and `pipeline.js` uses it.
- `by_rep` (`pipeline-conversion.js:151-163`) is keyed on the opportunity owner, falling back to `sent_by`.
- `by_rep` gains a spares lane: the value of open SENT and ACCEPTED quotes per owner (as defined in D4).
- Stalled rows carry `opportunity_name` and `customer_name`.

**Screen:** `sales-ops.tsx`:
- a manager-only Rep picker passes `owner_id` (`:29`);
- `by_rep` is rendered with names and an Unassigned row;
- the stalled list shows opportunity and customer names instead of the truncated opportunity id (`:146`);
- "Revenue by rep" shows member names instead of the truncated user id (`:290`).

**Tests**
- `analytics.pipeline` is called with `{granularity:'week', owner_id:'u-2'}` after picking a rep.
- by_rep renders 'Asha Rao' and 'Unassigned'.
- The stalled list renders an opportunity name and customer name.
- A unit test covers owner keying and the spares lane.

### PR 10. Rep touch log on quotes and opportunities

**Needs:** N3. **Migration:** none. **Size:** M. **Waits on:** nothing. Decision-free.

**API**
- The `communications/list.js` GET gains `object_type`, `object_id` and `customer_id` filters (index at `189:52-54`).
- A new POST records a manual touch:
  - channel: call, meeting, whatsapp, visit or note;
  - direction `outbound`, status `sent`, provider `manual`, `document_type` `rep_touch`;
  - `sent_by = ctx.user.id`, and `customer_id` copied from the target;
  - `metadata.next_followup_at` holds the next date.
- A touch is never queued, so the reaper never emails it.

**Screen**
- QuoteDetailDrawer gets a Follow-up tab (tabs near `:449-456`) that lists touches.
- Its Log form is prefilled with the last channel used, the quote's contact, and a next date of today plus 3 business days (`datemath.js:42`).
- The `opps.tsx` detail reuses the same component.

**Tests**
- `communications.log` is called with `{object_type:'quote', object_id:'q-1', channel:'call', body:'Spoke to maintenance', metadata:{next_followup_at:'2026-10-07'}}`.
- API:
  - an unknown channel returns 400;
  - a foreign object returns 404;
  - a filtered GET returns only that object's rows;
  - the metric catalog's customer-comms totals are unchanged by `rep_touch` rows.

### PR 11. My follow-ups: the chase list on Home

**Needs:** N3, N1. **Migration:** none. **Size:** M. **Depends on:** 5, 10. **Waits on:** D4.

**API**
- `GET /api/quotes` gains:
  - `mine=1`: the quote's owner (as defined in D4) is me;
  - `owner=<uuid>`, through sales-scope;
  - `followup=1`: see below.
- `followup=1` returns open quotes: SENT, and ACCEPTED but not CONVERTED.
  - A SENT quote is **superseded**, and left out, when a higher version of the same `quote_number` has `sent_at` set. A revise creates a DRAFT `v(N+1)` and leaves `vN` SENT (`quotes/index.js:148-176`), so without this rule `vN` would sit beside `v(N+1)` once both are sent.
  - Each row carries its owner and its last touch.
  - Each row carries `next_action_at`: the latest touch's `next_followup_at`, else `sent_at` plus 3 business days.
  - Each row carries `next_action_source`: `rep` or `default`.
- A quote with neither a touch nor a sent date goes to "No next step set" with a null date.
- `GET /api/sales/opportunities` gains `followup=1`.

**Screen**
- `home.tsx` reads `.orders` (`:34`).
- Home, where every role lands (`routes.ts:42-46`), gets the My follow-ups card.
- `quotes.tsx` gets Mine/All (default from D1), a "Needs follow-up" tab, and a forward-looking label for future expiry dates (`:262`).

**Tests**
- `quotes.list` is called with `{mine:'1', followup:'1'}`.
- The card renders overdue and due-today rows, the `default` marker and the "No next step" bucket.
- Home reads `.orders`.
- API:
  - the owner order of precedence holds: opportunity owner, then account owner, then `created_by`;
  - `next_action_source` is returned;
  - a SENT v1 is absent once v2 has `sent_at`, and present while v2 is a DRAFT.

### PR 12. Cadence that stops, routes to the owner, and can be switched off

**Needs:** N3. **Migration:** 228. **Size:** M. **Depends on:** 5, 11. **Waits on:** D7, D4.

**API**
- `armQuoteAgentGoals` (`send.js:44-93`):
  - `owner_user_id` is the quote's owner as defined in D4 (today it is the sender, `:485`, always a manager);
  - `next_run_at` is `sent_at` plus the cooldown (today it defaults to `now()`, `011:57`);
  - when the switch is off, it arms neither of the goals that email the customer;
  - sending version N cancels active goals on earlier versions of the same quote number (today it cancels only goals on the same quote id, `:47-54`).
- `quote_accept.js`:
  - `TERMINAL_QUOTE` (`:31`) adds DECLINED, CANCELLED and EXPIRED;
  - **escalate once, then end the goal.** On the first run past `due_at`, and on the first run with no recipient, it returns `escalate`;
  - on the next run, when `goal.last_action` is `escalate`, it returns `give_up` with reason `ran_out`. That sets the goal `failed` (`run.js:59`), so the runner never selects it again;
  - it never returns `noop` for a past-due goal. A noop reschedules in one hour by default (`run.js:68-71`), and the runner takes the 50 oldest due active goals across all tenants (`run.js:329-336`), so dead goals ticking hourly would crowd out live nudges.
- **Replies pause the nudges.**
  - `attributeReply` (`_lib/graph-reply.js:30-66`) also selects `object_type` and `object_id`.
  - When the replied-to outbound row is about a quote (the quote email or a `quote_followup`), it sets that quote's active quote goals to `paused` and records an audit row.
  - This works only for mail sent through the Graph mailbox, the only path that stores the ids a reply is matched on (`graph-reply.js:1-17`).
  - With any other mailer, an emailed answer pauses nothing, and the rep records it with "Record customer response".
- The chase list gains two lanes on the owner's list:
  - "Customer replied": goals paused by a reply;
  - "Automatic follow-ups ran out": quote goals with status `failed` and last action `give_up`.
- The admin bell row is unchanged, and this PR does not claim it reaches sales managers.
- `/api/agents/goals`:
  - GET filters by object and owner, and returns the switch;
  - a PATCH with no goal id and a `quote_customer_nudges_enabled` boolean flips the switch (admin only), as `admin/logistics_monitor_rules.js:43-54` flips its own flag from a body field;
  - if column 228 is missing, that PATCH returns 503 naming the migration, as `admin/so_processing_mode.js:88-97` does.

**Screen**
- `agents.tsx` shows the switch and an owner column.
- `agents.tsx` stops arming `quote_accept` with objectType `'order'` (`:19`).
- QuoteHistoryTab shows the goal's owner and next nudge, via `agents.listGoals({object_type:'quote', object_id})`.

**Tests**
- The toggle PATCHes `{quote_customer_nudges_enabled:false}`, and renders the 503 message when the column is missing.
- QuoteHistoryTab calls `listGoals` with the object filter.
- Through `__test` (`send.js:95`), with the send made by a sales_manager:
  - the goal owner is the account owner, not the sender;
  - `next_run_at > sent_at`;
  - nothing is armed when the switch is off;
  - v1 goals are cancelled when v2 is sent.
- `quote_accept`:
  - DECLINED completes the goal;
  - the first past-due run escalates;
  - the next run gives up with `ran_out`;
  - no past-due run returns `noop`.
- `attributeReply` on a `quote_followup` row pauses that quote's goals and leaves another quote's goals active.
- Home renders the "Customer replied" and "ran out" lanes.

### PR 13. Portal onboarding: invite, set password, recover

**Needs:** N4. **Migration:** none (needs 199 applied). **Size:** M. **Depends on:** 1. **Waits on:** D12, D20.

**API**
- Invite (`invite.js:60`), the redirect:
  - it passes `redirectTo` = `PORTAL_BASE_URL + '/portal'`;
  - Supabase honours that only for URLs on the project's Auth redirect allowlist, and otherwise falls back to the Site URL, which is the staff callback (`docs/SUPABASE_SETUP.md:123-129`, `docs/DEPLOY.md:257`);
  - so this PR updates `SUPABASE_SETUP.md` to list `<PORTAL_BASE_URL>/portal`, and the pilot runbook adds it.
- Invite, who may be invited:
  - it refuses an email that is neither on a `customer_contacts` row of that customer nor on that customer's email domain, unless the inviter holds approve permission and gives a reason (audited);
  - it refuses an email that already has a `portal_users` row **in any tenant**. The check is by email (stored lowercased, `199:22`), with the service role and no tenant filter. Both portal lookups read one row per auth user with no tenant filter (`portal-auth.js:45-47`, `login.js:42-44`), so a second row makes `maybeSingle` fail for that person in every tenant. The refusal names no other tenant or customer: "This email already has an Anvil customer portal account and cannot be invited here";
  - it handles an email that already has an auth account, for example a staff user, or a portal user whose row was deleted. `inviteUserByEmail` fails for such an email, and today that surfaces as a raw 500 (`:60-61`). The invite instead returns 409 "This email already has an Anvil account; a portal identity needs its own email" and links nothing, because a staff identity must never become a portal identity (D12).
- New STATIC_ROUTES row `/portal/auth/set_password`:
  - the Bearer token is the invite or recovery token from the URL fragment, verified with `getUser`;
  - it looks up `portal_users` by `auth_user_id`;
  - it refuses `suspended` and accepts `invited` or `active`;
  - it sets the password and flips invited to active, as `login.js:59-63` does;
  - it cannot use `resolveCustomerContext`, which refuses `invited` users (`portal-auth.js:50`).
- New row `/portal/auth/recover`: calls `resetPasswordForEmail` with the portal redirect and always returns 200.
- Rate limits use `checkRateLimit` and `recordRateLimitAttempt` (`_lib/rate-limit.js:23-55`) on the existing `magic_link_attempts` table (`059:50`), as `auth/magic_link.js:110-119` does. The identifiers are prefixed so they never collide with magic-link's `email:` and `ip:` keys:
  - `login.js`: `portal_login:email:<email>` (5 per 15 minutes) and `portal_login:ip:<ip>` (20), recorded on each failed sign-in;
  - recover: `portal_recover:email:<email>` and `portal_recover:ip:<ip>`, recorded on every request;
  - set_password: `portal_setpw:ip:<ip>`.

**Screen**
- `PortalApp.tsx` (`:8-11`) detects `type=invite|recovery` in the URL hash and renders a new `SetPasswordView.tsx`.
- LoginView gets "Forgot password".
- Staff get a new `PortalUsersPanel.tsx` in the customer detail:
  - lists users (`invite.js:24-33`);
  - invites by picking a contact, with email and name prefilled;
  - shows the refusal reason when an invite is refused;
  - suspends and reactivates users (`:37-48`).
- CustomerContactsPanel edits are fixed. Today every edit returns 400: `anvil-client.js:932` sends the id in the body, but `contacts.js:60` reads it from the query.

**Also:** `api-portal-scope-surface.test.js:38-39` derives its sources from every `src/v3-app/portal/*.tsx`, so later tabs cannot escape it.

**Tests**
- `portal.inviteUser` is called with `{customer_id:'cust-1', email:'asha@plant.example', display_name:'Asha Rao', role:'portal_member'}` after picking a contact.
- SetPasswordView posts `{password}` with the hash token as the Bearer header, never in a URL.
- `updateContact` sends `?id=`.
- API:
  - an invited user sets a password and becomes active;
  - a suspended user is refused;
  - an off-domain email without approve permission returns 403;
  - an email with a `portal_users` row in another tenant returns 409, and the message names no tenant;
  - an `inviteUserByEmail` "already registered" error returns 409, not 500;
  - a sixth failed login for one email returns 429, and the attempts are written to `magic_link_attempts` with the `portal_login:` prefix.

### PR 14. Portal assets: shared matrices and their applicable spares

**Needs:** N2, N4. **Migration:** 229. **Size:** M. **Waits on:** D5, D8, D15.

**API**
- `share.js`:
  - POST stamps `shared_at`/`shared_by`;
  - POST refuses while `recommended_spares` is empty ("Recompute recommended spares first");
  - it returns the `/portal` link; whether a token is still minted alongside it (`:44-71`) is PR 2's business;
  - DELETE unshares.
- Matrix create and update accept `customer_location_id`.
  - The handler checks that the location has `tenant_id = ctx.tenantId` and `customer_id` equal to the matrix's `customer_id`, and returns 400 otherwise.
  - The check runs again when the matrix's customer changes; a location that no longer matches is cleared.
  - `customer_locations` carries both columns (`006:123-137`), and the foreign key alone proves only that the row exists.
- `view.js`, for every caller:
  - `spares` lists only shared matrices;
  - `spare_matrix` returns 404 for an unshared one;
  - no fallback for a missing `shared_at` column.
- `spare_matrix` adds an `applicable` list from `recommended_spares`, projected through `PORTAL_SPARE_KEYS` in a new `_lib/portal-allowlists.js`. The fields are:
  - `part_no`, category and `item_type`;
  - `sheet_count`, from `installed_qty`;
  - `customer_part_no`: the row's own value, else the primary `item_customer_parts` row found by `item_id`;
  - `quote_status_label`.
- Drawings: the matrix lists only committed drawings with `released_at` set, and selects `document_id` (missing at `:124`).
- New STATIC_ROUTES row `/portal/drawing` (GET `?id=`, signed-in session only):
  - it checks that the drawing belongs to a shared matrix of the signed-in customer and is committed and released;
  - it writes `portal_access_log` with path `drawing:<id>` and the `portal_user_id`;
  - it returns a 10-minute signed URL for an upload, or the `link_url` for a link;
  - this is the "log every drawing download, short-lived signed URLs" control from the draft design's Phase 5 (`CUSTOMER_PORTAL_AUTH_DESIGN.md:114-119`).
- `drawings/update.js` accepts `release: true|false`, which stamps or clears `released_at`/`released_by` and calls `requireAction('drawing.release')` (design_manager, sales_manager, admin), registered in `SERVER_ACTIONS` and `rbac.ts` in this PR.

**Screen**
- In `spares.tsx`, Share becomes "Shared on <date>" with an Unshare action.
- The matrix header gets a Plant select, prefilled when the customer has exactly one location, listing only that customer's locations.
- GunDrawingsPanel gets "Release to customer" and "Withdraw from customer", using the existing `drawings.update` (`anvil-client.js:1572`).
- Share warns how many committed drawings are not released and will not be visible.
- PortalHome:
  - renders timer and ATD;
  - groups by plant;
  - opens drawings through `/portal/drawing` (uploads cannot be opened today, `:113`);
  - shows the Applicable spares table;
  - its "Shared spare matrices" heading (`:59`) becomes true.
- `INSTALLED_BASE_CANONICAL.md` gets the dated amendment note (D5).

**Tests**
- PortalHome renders the Timer and "Your part no" columns from `view('spare_matrix','&matrix_id=m-1')`, and opening a drawing calls `/portal/drawing?id=d-1`.
- `spareMatrix.share`, `unshare` and the plant select send their fields.
- GunDrawingsPanel calls `drawings.update({id:'d-1', release:true})`.
- API:
  - an unshared matrix returns 404;
  - mocked rows carrying `recommended_qty`, `priority`, `remarks`, `po_ref` and `lead_time_days` produce keys only within `PORTAL_SPARE_KEYS`;
  - a committed drawing without `released_at` is absent from the matrix and returns 404 from `/portal/drawing`;
  - a drawing open writes an access-log row with path `drawing:d-1`;
  - a sales_engineer releasing a drawing gets 403; `drawing.release` is in both action lists;
  - a `customer_location_id` of another customer, or another tenant, returns 400;
  - Share with no recommended rows returns 409 and writes no `portal_tokens` row;
  - the 229 CI step: a non-JSON `audit_events.detail` row does not abort the migration.

**Wires:** `share.js` and its button; `recommended_spares.customer_part_no`, `quote_id` and `item_id`; `item_customer_parts`; the drawings update API.

### PR 15. Portal Quotes tab on the real quotes table

**Needs:** N4, N3. **Migration:** none. **Size:** M. **Depends on:** 13. **Waits on:** D6, D16.

**API:** `view.js` `kind=quotes` (`:83-89`) reads `quotes` instead of orders.
- Which quotes:
  - the customer's quotes where `ingest_source is null and sent_at is not null`;
  - status SENT, ACCEPTED, CONVERTED, DECLINED, EXPIRED, or CANCELLED after it was sent.
- Versions:
  - the **current** version of a quote number is the highest version with `sent_at` set;
  - a DRAFT revision is internal and never counted, so the customer never sees "Superseded" for a revision that has not reached them;
  - earlier sent versions read "Superseded by vN" once vN is sent.
- Labels describe what the customer did:
  - a quote the customer marked not needed reads "You marked this not needed on <date>" (from the response row, PR 16);
  - "Withdrawn" is used only for a cancellation with no customer response.
- Fields:
  - `PORTAL_QUOTE_KEYS`: number, version, revision, sent date, expiry, currency, status label, total;
  - `PORTAL_QUOTE_LINE_KEYS`: part, customer part, description, qty, uom, discounted unit price, amount.
- PDF: a 10-minute signed URL of `<tenant>/quotes/<id>_v<ver>.pdf` (`send.js:289`), else "PDF not available".
- Opening a quote's detail is logged as `quote:<id>`.
- `kind=summary` is gated on the `quotes` scope (`view.js:53`), so granting that scope opens it too. It is rewritten behind `PORTAL_SUMMARY_KEYS`:
  - it returns the customer name and quote counts (open, awaiting response);
  - the open-invoice count and the contact email (`:73-82`) are dropped;
  - PR 17 adds the open-order count.
- `SESSION_SCOPES` adds `quotes`.

**Email:** `send.js` replaces the dead `/portal/<token>?quote=` line (`:125`) with `/portal?quote=<id>` when the customer has an active portal user; otherwise the email carries only the signed PDF link it already sends. Whether a token row is still minted is PR 2's business.

**Screen**
- A new `PortalQuotes.tsx`.
- PortalApp opens the `?quote=` quote after login, and shows "N awaiting your response" on the tab from `view('summary')`.
- The chase list shows "Viewed <date>".

**Tests**
- PortalQuotes calls `view('quotes')` and renders "Awaiting your response", with no internal status names.
- PortalApp calls `view('summary')` and renders the badge.
- API:
  - a staff DRAFT, an ingested quote, a quote CANCELLED before it was sent, and another customer's quote are all absent;
  - with v1 SENT and v2 DRAFT, v1 is current and not labelled superseded; with v2 sent, v1 reads "Superseded by v2";
  - keys stay within the allowlists when mocked rows carry cost and margin keys;
  - summary keys stay within `PORTAL_SUMMARY_KEYS` and carry no invoice count or email.
- Send adds the `/portal?quote=` link only when the customer has an active portal user.
- Home renders "Viewed 2 Oct".
- The scope-surface test passes with `quotes`.

### PR 16. The customer responds: PR raised, revise, not needed

**Needs:** N4, N3. **Migration:** 230. **Size:** M. **Depends on:** 15. **Waits on:** D9, D13.

**API:** a new `_lib/quote-response.js` `recordQuoteResponse`, shared by two separate routes that never mix staff and portal auth:
- Portal: `/api/portal/accept_quote` (`router.js:653`). With a signed-in session (`resolveCustomerContext`) it records a response. A legacy token keeps today's quote-accept behaviour until PR 2 retires it.
- Staff: `POST /api/quotes?action=respond&id=`, with `requirePermission('write')`, `channel = 'staff'` and `recorded_by = ctx.user.id`.

Rules, by response kind. Every response needs a quote of this customer that is its quote number's **current** version (highest version with `sent_at`), else 409:

| Response | Allowed from | Moves the quote to | Goals |
|---|---|---|---|
| `pr_raised` | SENT, not expired | ACCEPTED, `accepted_*` set. Needs a PR number of 6 to 20 letters and digits once normalised | cancelled |
| `revision_requested` | SENT, not expired | stays SENT | paused |
| `not_needed` | SENT | DECLINED, with `declined_reason` (this also fixes `quotes/index.js:411`) | cancelled |
| `not_needed` | ACCEPTED (a PR was raised earlier, no PO yet) | CANCELLED (`quotes/index.js:39`), with the reason on the response row | cancelled |

- `not_needed` on a CONVERTED quote, and `pr_raised` or `revision_requested` on an ACCEPTED one, return 409.
- This PR cancels or pauses the quote's own goals itself, so it does not depend on PR 12's terminal-status fix (`quote_accept.js:31` treats only ACCEPTED and CONVERTED as terminal until then).
- Every response writes a row (IP, user agent, and `payload_hash` as at `accept_quote.js:57-70`) and an audit event.
- The legacy order-path code, already answering 410 since PR 1, is deleted.
- `GET /api/quotes` rows gain `latest_response` (kind, PR number, date, channel), which the chase list and the account panel read.
- The D9 consequences:
  - `computeRevenueByRep` (`_lib/ops-kpis.js:89-99`) counts CONVERTED quotes, and the card is relabelled "Won by rep (PO received)";
  - `sent_to_accepted` (`:75`) is relabelled "Sent to customer answer".

**Screen**
- Three actions on PortalQuotes, with the PR date prefilled as today. On a "PR raised" quote, only "Not needed" is offered.
- QuoteDetailDrawer shows the response and a prefilled "Record customer response" form.
- `quotes.tsx` splits the Won tab into "PR raised, awaiting PO" and "Converted".
- The chase list gains "Revision requested" and "PR raised, no PO yet" with its age.
- Sales Ops renders the relabelled cards.

**Tests**
- The portal POST body is `{quote_id:'q-1', response:'pr_raised', pr_number:'1000343964', pr_date:'2026-10-04', signature_name:'Asha Rao'}`.
- The drawer sends `quotes.respond({id:'q-1', response:'pr_raised', pr_number:'1000343964'})`.
- API:
  - another customer's quote returns 403;
  - a superseded version returns 409; v1 can still be answered while v2 is a DRAFT;
  - `not_needed` on an ACCEPTED quote moves it to CANCELLED and keeps the reason;
  - `not_needed` on a SENT quote moves it to DECLINED and persists `declined_reason`;
  - `pr_raised` on an ACCEPTED quote returns 409;
  - a revision request pauses goals; `pr_raised` and `not_needed` cancel them;
  - `pr_number_norm` normalises the input;
  - `computeRevenueByRep` counts a CONVERTED quote and not an ACCEPTED one.
- PortalQuotes renders "You marked this not needed" for a quote the customer cancelled.
- A new `api-portal-write-surface.test.js` asserts every non-legacy `/portal` write handler calls `resolveCustomerContext`.

**Wires:** the `acceptQuotePath` logic; `portal_quote_acceptances`; the `accepted_*` and `declined_reason` columns (068).

### PR 17. Portal Orders tab

**Needs:** N4. **Migration:** none. **Size:** M. **Depends on:** 3, 13. **Waits on:** D10, D12.

**API**
- A new `_lib/portal-orders.js` builds the view directly on `buildDispatchRegister` (`dispatch-register.js:170-290`), which is customer-safe by design.
  - Its inputs are `extractPoLines(order)` (`:70-74`) and that order's `dispatch_lines`, selecting `lr_number` and `carrier`. The staff pending query does not select `lr_number` (`pending_sales_orders.js:77`).
  - Order statuses are a parameter, set to APPROVED, EXPORTED_TO_TALLY and RECONCILED, so an order still under review is not shown.
  - It never passes `shipments`. Those are inbound import consignments, and with no line-grain despatch the register falls back to consignment headers that print the supplier's invoice number (`:151-167,255-257`).
  - Rows go through `PORTAL_ORDER_LINE_KEYS` = `SAFE_KEYS` (`:80-84`) plus `po_number`, `po_date`, `customer_part_number`, `committed_date` and `committed_label`. The register's `lr_numbers` and `invoice_numbers` arrays are joined into `lr_number` and `invoice_number`.
  - Fully despatched lines are kept for 90 days after their last despatch date.
  - Orders are read newest first by PO date.
- The committed date is only `orders.committed_delivery_date`. It is never the pending model's `promised_date`, which prefers the customer's own schedule (`pending_sales_orders.js:183`), nor its `ready_date` (`:160`).
- A despatch matched by `line_index` (`buildDispatchRegister` tries that first) whose `part_no` disagrees with the PO line is not counted on that line, and the order shows "Some despatch details are being confirmed".
- `SESSION_SCOPES` adds `orders`; the summary gains the open-order count.
- **In passing, on the staff side,** `pending_sales_orders.js` gets two one-line fixes. Its output is otherwise unchanged, and it is not the portal's base:
  - it drops the nonexistent `customers.display_name` from its select (`:64`), so its customer header is no longer null;
  - it applies its status filter in the query (`:65-70`), so closed orders stop using up the 500-row limit.

**Screen:** a new `PortalOrders.tsx`.

**Tests**
- PortalOrders calls `view('orders')` and renders "Not committed yet" and "Despatched 2 of 5, LR 12345".
- API:
  - a RECONCILED order appears; a PENDING_REVIEW order is absent;
  - mocked rows carrying `rate`, `supplier`, `source_po_no`, `vessel_or_flight` and `ready_date` produce keys only within the allowlist;
  - an order with a linked import shipment and no `dispatch_lines` shows no consignment line;
  - a part mismatch is not counted;
  - a line despatched 100 days ago is absent; one despatched 10 days ago is shown.
- Staff: the pending endpoint returns the customer's name in its header, and an open order is returned even when 500 closed orders are older.
- The scope-surface test passes.

### PR 18. The PO closes the quote, matched by PR number

**Needs:** N4, N3, N1. **Migration:** 231. **Size:** M. **Depends on:** 4, 16. **Waits on:** D17.

**Capture**
- so-intake (header defaults at `:957-978`) sets `customer_requisition_no`:
  - the line value, when every line that carries one agrees;
  - null, when they differ;
  - else the header value.
- For a large PO that value comes from the page-1 preview. The background merge (`cron/extraction_jobs.js:749-765`) therefore re-derives `customer_requisition_no` from the merged lines and customer block, unless a person has edited the field (its header field source is `human`).
- `orderRow` accepts it as an optional key, like `MIG_106_HEADER_KEYS` (`orders/index.js:20-28`).
- `APPROVE_INPUTS` (`[id].js:12`) adds it.
- OrderHeaderEditor shows it with the OCR marker, editable.

**Link:** a new `_lib/quote-link.js`. It runs inside `reconcile_quotes` and after a header save that changes the field. `reconcile_quotes` is called at intake for small POs and by the workspace's Reconcile button (`so-workspace.tsx:1094-1110`). The link never trusts a value computed at intake:
- it recomputes line agreement from the stored `orders.result.salesOrder.lineItems` every time it runs;
- it refuses to auto-link while the order has an `extraction_jobs` row in `queued`, `profiling`, `chunking`, `extracting` or `merging` (`117:51-52`), and says "lines still extracting";
- on exactly one `pr_raised` response with the same customer and normalised PR, within 365 days, on an ACCEPTED quote, with every line agreeing, it sets `orders.quote_id`, `quote_link_source = 'pr_number'` and `matched_by: 'pr_number'`;
- with no match, today's behaviour applies;
- with several matches, or with lines that disagree, it makes no link and adds a non-blocking finding `requisition_multiple` that lists the candidates or the distinct PR numbers;
- `reconcile_quotes.js:254` keeps a `pr_number` or `manual` link instead of overwriting it.

**Convert at approval** (`orders/[id].js:168-187`)
- A quote linked by `pr_number` or `manual` becomes CONVERTED with `converted_order_id`, the way `quotes/convert.js:173` writes it.
- `orders.opportunity_id` is filled from the quote when null.
- The conversion is audited, naming the response and the order.
- A quote reached only through part overlap (reconcile's primary quote, or a line's `source_quote_id`, `quote-reconcile.js:284`) is never converted automatically. QuotesStrip offers "Mark Q-... answered by this PO", which sets `manual`.

**Screen**
- QuotesStrip shows "Matched by PR 1000343964", or the finding.
- The header field.
- The portal label "PO <number> received <date>" after conversion.

**Tests**
- The so-intake create body carries `customer_requisition_no`.
- The header save sends it.
- QuotesStrip renders `matched_by`.
- API:
  - a unique match links;
  - two candidates give a finding and no link;
  - differing line PRs give no link;
  - **a large PO** whose page-1 lines carry PR A and whose merged lines carry A and B: after the merge, `customer_requisition_no` is null, and the link step raises `requisition_multiple` and links nothing;
  - with an `extraction_jobs` row in `extracting`, no link is made even on a unique match;
  - a hand-edited `customer_requisition_no` survives the merge;
  - reconcile keeps the PR link;
  - approval converts the linked quote and leaves a part-overlap quote alone;
  - an order with no requisition falls back to part matching;
  - the backfill reads both result paths.

**Wires:** the stored requisition number; `reconcile_quotes`; `converted_order_id`; `orders.opportunity_id` (204, which until now had only a backfill writer).

### PR 19. Committed-date suggestion

**Needs:** N4. **Migration:** none. **Size:** S. **Waits on:** D11. Pilot-plus.

**Screen:** `SOWorkspaceOrderPanels.tsx` (`:189-191`) shows a suggestion chip, for example "PO date 12 Oct + 30 days (customer lead time) = 11 Nov".
- The number of days comes from `customer_lead_times` for this customer, matching the product category first.
- Only rows saved on or after the relabel date give a chip. The relabel date is a constant set in this PR, compared with `updated_at`.
- An older row shows "Lead time on file was entered before its meaning was defined; confirm it in Admin", and no chip, because it may be the handling time `promise.js` assumed.
- With no lead-time row, it shows "No lead time on file" and no chip.
- The date is saved only on click. There is no "commit all".
- Admin: the lead-time card labels the customer field "Days from PO date to delivery" (`admin.tsx:3522`).
- `delivery/promise.js` (no screen caller) stops reading `customer_lead_times` as internal handling time and keeps its default of 3 (`:50-56`).

**Tests**
- Clicking "Use suggestion" saves `{committed_delivery_date:'2026-11-11'}`.
- Nothing is saved before the click.
- There is no chip without a lead time, and none for a row last saved before the relabel date.
- `promise.js` uses 3 days of handling whatever `customer_lead_times` holds.

### PR 20. Spare quote prices prefilled from rate contracts and history

**Needs:** N2, N3. **Migration:** none. **Size:** M. **Waits on:** nothing. Decision-free. Pilot-plus.

**API**
- A new `_lib/spare-price-prefill.js` picks the price in this order:
  1. an active, date-valid rate-contract price (`contract_lines.unit_price`) for the customer and part;
  2. else the last discounted price on an authored SENT, ACCEPTED or CONVERTED quote line to this customer within 365 days, in the same currency;
  3. else null.
- `to_quote.js:101` uses it and records the price source per line in `field_sources`.
- `send.js` returns 409, listing the zero-priced lines, unless the body carries `confirm_zero_price`. A free-of-charge line therefore stays possible. Send is a manager's action (D21), so the manager sees this confirmation.

**Screen**
- QuoteDetailDrawer Lines shows a price-source chip: "ARC", "Last quoted 12 Aug" or "No price".
- Send asks for confirmation when zero-priced lines exist.

**Tests**
- Signed in as a sales_manager, the drawer resends with `{id:'q-1', confirm_zero_price:true}` after confirming.
- The chip renders.
- API:
  - a rate-contract price beats history;
  - a price in another currency is ignored;
  - a null price stays 0 and is flagged;
  - a sales_manager's send with a zero-priced line and no confirmation returns 409;
  - `to_quote` regression test.

### PR 21. The customer requests a spares quote from the portal

**Needs:** N2, N4. **Migration:** none. **Size:** M. **Depends on:** 14, 15, 20. **Waits on:** D19. Pilot-plus.

**API**
- Extract the draft builder from `to_quote.js:64-190` into `_lib/spare-quote-draft.js`. Two guards keep a customer's request and the rep's own drafts apart:
  - the re-sync lookup in `to_quote` (`:113-124`) excludes drafts whose `field_sources.origin` is `portal_request`. Without that guard, a `to_quote` call without `force` would take the customer's draft as its existing draft (its missing `matrix_group` defaults to `all`) and replace the customer's lines (`:130-132,167`). This is latent today only because `spares.tsx:753-755` always sends `force: true`;
  - for a portal draft, the back-link to `recommended_spares.quote_id` (`:184-190`) is written only where `quote_id` is null. A request therefore never overwrites a spare's link to the rep's quote, and both the per-spare quote status in the portal and PR 23's "M quoted" count stay true.
- A new STATIC_ROUTES row `/portal/request_quote`, signed-in session only:
  - body `{matrix_id, lines:[{recommended_spare_id, qty}], note, customer_ref}`;
  - the matrix must be shared and must belong to the signed-in customer;
  - every line must be on its applicable list, with qty above 0;
  - at most 100 lines;
  - rate-limited per portal user.
- It always creates a new DRAFT:
  - `created_by` null;
  - `field_sources = {origin:'portal_request', portal_user_id, note, customer_ref}`;
  - prices from PR 20.
- It does **not** take to_quote's fallback for a missing column, which strips `field_sources` (`to_quote.js:156-158`). Without the column it refuses.
- The quotes view also returns these drafts as "Requested, being prepared", without prices.

**Screen**
- The Applicable spares table gets quantity inputs, prefilled from the last quoted quantity for this customer and part, else the sheet count, and a "Request quote" button.
- `quotes.tsx` shows a "Customer request" chip.
- The chase list puts these requests first.

**Tests**
- The POST body is `{matrix_id:'m-1', lines:[{recommended_spare_id:'r-1', qty:4}], note:'Line 3 shutdown'}`.
- The quantity prefill and the chip.
- API:
  - an unshared matrix returns 404;
  - a foreign id returns 400;
  - a `customer_id` in the body is ignored;
  - 101 lines return 400;
  - the draft carries no price in the portal;
  - a `to_quote` call without `force`, on a matrix that has a portal-request draft, creates or re-syncs a staff draft and leaves the portal draft's lines untouched;
  - a portal request leaves a spare's existing `quote_id` (pointing at a staff quote) unchanged, and fills `quote_id` for a spare that had none.
- The write-surface test covers the route.

### PR 22. Load already-sent quotes through the existing ingest

**Needs:** N3. **Migration:** none. **Size:** M. **Waits on:** nothing. Decision-free. Pilot-plus.

**API**
- `quote-ingest.js` sets `created_by = ctx.user.id`.
- It sets `expires_at` from an extracted validity when there is one; otherwise `expires_at` stays null and reads "Validity unknown".
- A new client wrapper for `/api/quotes/ingest` (`router.js:929`).

**Screen:** "Upload sent quotes" in `quotes.tsx`:
1. upload;
2. `docai.extract({kind:'quote'})`;
3. one review table;
4. one ingest call.

Ingested quotes enter the chase list and can take staff-recorded responses (PR 16), so PR matching works on them. They stay out of the portal (D6).

**Tests**
- `quotes.ingest` is called with `{quotes:[{customer_id:'cust-1', quote:{quote_number:'OB-1234'}, lines:[...], source_document_id:'doc-1'}]}`.
- API: an ingested quote is absent from the portal view.

### PR 23. Account panel: pipeline and spares coverage

**Needs:** N1, N2. **Migration:** none. **Size:** S. **Depends on:** 5, 16. **Waits on:** D14. Pilot-plus.

**API:** no new route.
- `GET /api/spare_matrix` returns header rows only today (`spare_matrix/index.js:20-29`). It accepts `with_counts=1` and adds `applicable`, `quoted` and `never_quoted` counts per matrix.
- The counts come from one grouped `recommended_spares` query, rather than one `/recommended` call per matrix.
- The quotes list already carries `latest_response` (PR 16).

**Screen:** a new `AccountPipelinePanel.tsx` in the customer detail. It shows:
- open opportunities (the filter at `opportunities.js:67`);
- open quotes with their latest response;
- matrices, shared or not;
- per matrix, "N applicable parts, M quoted, K never quoted".

**Tests**
- The three list calls carry `customer_id:'cust-1'`, and the matrix call carries `with_counts:'1'`.
- The never-quoted count renders.
- API: `with_counts` returns the three counts from mocked `recommended_spares` rows.

### PR 24. Supply against a raised PR: Expected-PO internal SO

**Needs:** N4, and the first step of the forecast north star. **Migration:** none (needs 230). **Size:** S. **Depends on:** 16. Not in the pilot.

**Screen**
- `internal-sos.tsx:56` reads `internalSos`, which is what `internal_so.js:34` returns, so the Internal SOs list stops being empty.
- On an ACCEPTED quote with a PR, QuoteDetailDrawer offers "Supply against PR". It opens the internal SO form prefilled with:
  - `iso_type = 'EXPECTED_PO'` (`006:38-47`);
  - `expected_po_reference` = the PR number from the response row;
  - the customer, the required date and the quote's lines.

**Tests**
- The list reads `internalSos`.
- The create call carries `{iso_type:'EXPECTED_PO', expected_po_reference:'1000343964', customer_id:'cust-1'}`.

### PR 25. Portal go-live bar: MFA and session refresh

**Needs:** N4. **Migration:** none. **Size:** M. **Depends on:** 13. **Waits on:** D20. Required before production at an auto OEM under the recommended default.

**API**
- Move the TOTP gate from `auth/password_login.js:57-112` into a shared `_lib/totp-gate.js` used by both logins. It replaces the placeholder at `login.js:55-57`.
- New rows `/portal/auth/mfa` (enrol and verify against `user_security_settings`) and `/portal/auth/refresh`.
- Invites default `require_mfa` to true (today false, `invite.js:73`).

**Screen**
- A TOTP step in LoginView.
- A new MfaEnrollView.
- `portal/api.ts` refreshes the session before `expires_at`.

**Tests**
- The second login call sends `totp_code`.
- Refresh sends the refresh token in the body, not the URL.
- API: returns `mfa_required` when the user is enrolled.

---

## 6. Pilot slice

**Minimum: 17 PRs** (1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18), plus migrations 227 to 231.

- **Wave A (decision-free, in parallel, now):** 1, 3, 4, 5, 10.
- **Wave B (each as soon as its decision is recorded):** 2 (D18), 6 and 7 (D3), 9 (D1, D2, D14), 11 (D4), 12 (D4, D7), 13 (D12, D20), 14 (D5, D8, D15).
- **Wave C:** 15, 16, 17, 18.
- **Invite gate. No customer user is invited** until PRs 1, 13 and 14 are deployed and migrations 197, 199 and 229 are confirmed applied. Before PR 14, a signed-in session can list every matrix of its customer, published or not (`view.js:103-109`), and see drawings nobody released (`:124`), because the session's one scope, `spares`, reaches both kinds (`portal-auth.js:34`). Test invites before then go to an internal test customer only.

What the prospect sees end to end, on their own data:

- **N1:**
  - reps own accounts;
  - each rep has a "Mine" pipeline of opportunities and open spares quotes;
  - managers pick a rep, or see the team, on Sales Ops.
- **N2:** shared gun matrices in the portal, grouped by plant, with applicable spares, the customer's own part numbers, quote status, and the drawings someone released.
- **N3:**
  - Home lists whom to chase today;
  - touches carry a next date;
  - automatic customer emails are off;
  - a portal answer, a response the rep records, or the PO stops the cadence;
  - an emailed reply pauses it only when it can be traced to our message through the Graph mailbox; otherwise the rep records the answer.
- **N4:**
  - the customer signs in and sees assets, quotes and orders;
  - they answer with a PR number, and see "PO received" once the PO is approved;
  - committed dates appear only when someone committed to them;
  - despatch appears once the challan is uploaded against the right order.

**First follow-ups, in this order:**
1. PRs 20 and 21: the portal "Request quote" button. It needs prices prefilled to obey the no-blank-entry rule.
2. PR 22: history of quotes already sent from Excel or PDF.
3. PR 19: the date chip.
4. PR 23: the account panel.
5. PR 8.

Until PR 21 lands, the customer asks for quotes by email as today, and the rep builds the quote from the matrix.

**Before any OEM user outside a supervised pilot:** PR 25, under the recommended D20.

### How their data gets in (existing loaders first, prefilled, no blank entry)

1. **Staff:** reps and managers sign in and request access. An admin approves them in the existing `tenant_members` approval flow, as `sales_engineer` or `sales_manager`.
2. **Accounts and plants:**
   - customer ledgers come from the Tally masters sync, or are created by so-intake on the first PO;
   - plants go into `customer_locations` through `admin/customer_locations.js`.
3. **Contacts:** from extracted PO headers (email, phone) and from CustomerContactsPanel (edits fixed in PR 13). There is no contact importer, and we should say so.
4. **Owners:** bulk "Assign owner" (PR 5), one pass per rep. Suggestions come from existing opportunities and quotes. A brand-new tenant has none, so the first pass is one pick per group of accounts.
5. **Installed base:**
   - the spare-matrix Excel import, per line or plant (`spares.tsx:574-590`);
   - gun BOMs through Import BOM;
   - matchSpares autofill, then recompute recommended spares;
   - customer part numbers from the `item_customer_parts` admin bulk import, or learned from sent quotes;
   - then pick the plant, release drawings and Share (PR 14).
6. **Quotes:** generated from the matrix (to_quote, price, then a manager approves and sends). Already-sent PDFs can be loaded once PR 22 lands.
7. **Open POs:** through so-intake (DocAI). The requisition number is shown per line after PR 4 and, after PR 18, stored in the header and editable.
8. **Despatch:** the delivery challan PDF, per order, in the SO workspace (PR 3).
9. **Portal users:** invited from contacts (PR 13), after the invite gate.
10. **Settings:**
    - nudge switch off (PR 12), before the first Send;
    - confirm the tenant's `so_processing_mode` (221), because conversion happens at approval (§8).

### Pilot runbook

1. Run the apply-state query (§3). Apply any missing prerequisite first.
2. Apply 227 to 231 by hand, each before the PR that reads it, and re-run the query with their columns added.
3. Supabase Auth, URL Configuration: add `<PORTAL_BASE_URL>/portal` to Redirect URLs (PR 13).
4. Before the pilot tenant's first Send: confirm 228 is applied (the Agents toggle saves instead of returning 503) and the switch is off.
5. Confirm `so_processing_mode` with the tenant.
6. Data residency: confirm the region the OEM requires before the first invite (D20).
7. D18, before PR 2 merges, run the measurement query:
   ```sql
   select path, status, count(*) as hits, max(created_at) as last_hit
   from portal_access_log
   where token_id is not null and created_at > now() - interval '90 days'
   group by path, status
   order by last_hit desc;
   ```
   Also check `select count(*) from portal_tokens where last_used_at > now() - interval '90 days';` and the gateway records that carry `anvil_portal_token_id`.
8. D18, after PR 2 is deployed: `update portal_tokens set revoked_at = now() where revoked_at is null;`
9. The invite gate above.
10. During the pilot, no merge of customers that have portal users, shared matrices or quotes (§8).
11. Do not install the welding vertical pack (§8).

### Acceptance script on their data

1. A plant maintenance engineer signs in and sees one line's guns, with applicable spares, their own part numbers and the released drawings.
2. The rep prepares a tips-and-shanks quote from that matrix, and the manager sends it.
3. The engineer opens it (the rep's Home shows "Viewed") and clicks "PR raised", entering 1000343964.
4. Purchasing's PO is uploaded through so-intake. The workspace shows 1000343964 on its lines, QuotesStrip shows "Matched by PR 1000343964", the order is approved and the quote converts.
5. The rep sets the committed date, and the challan is uploaded on that order.
6. The portal shows "PO received", then the committed date, then "Despatched 2 of 5, LR 12345".
7. The manager sees all of it, per rep, on Sales Ops.

**Baseline to measure.** `handle_replies.js:92-114` already writes an `inbound_delivery_query` event for every "where is my order" email, and nothing reads those events. Count them per week for the pilot customer, before and after the invitations. It is the only existing measure of N4 demand.

---

## 7. What we will not build, and what must not be claimed

### Not building

- Teams, territories, `reports_to`, quotas, targets, commission, rep forecasting or activity scoring (D1, D2).
- A tasks or follow-ups table, a Kanban, or per-user push notifications. `lib/push.ts` stays unmounted.
- New agent goal types, or WhatsApp sending from the cadence (`whatsapp/send.js` stays server-only).
- Reading quote intents from emailed replies (`handle_replies.js:34`). A traced reply pauses nudges; it does not record an answer.
- Linking the matrix to `equipment_hierarchy`, timers as their own assets, FMECA or MEIO in the portal, or the jbm-importer duplicate fix.
- Forecast-driven procurement. The hook is left in place: ACCEPTED quotes with a PR number are the highest-confidence demand signal Anvil will hold, and the planner reads none of it today.
- Per-line ready-date commitments, ETAs from import shipments, or a "Delivered" state (`customer_receipts` stays unwired).
- Portal invoices, payments, reorder, invoice download, e-sign, or CAR and complaint status.
- SSO, httpOnly cookie sessions, drawing watermarks, or idle and absolute session timeouts. MFA arrives only in PR 25.
- Group-level, per-plant or multi-tenant portal users (D12).
- Kit lines (`docs/KIT_LINE_SCOPE.md`), an `order_lines` table, or a work-order entity for locally made lines.
- Lead conversion, recording a lost order in win/loss, opportunity line items, or bulk opportunity import.
- Price automation beyond the rate-contract and last-quote prefill.
- Letting a `sales_engineer` send quotes, unless D21 changes.

### Must not be claimed to the prospect until it exists

- **"Reps only see their own accounts."** Rep scope is a filter, not a wall (D3).
- **"Invite-only portal."** Until PR 2 lands, a legacy URL token still reads portal data without a sign-in.
- **"Enterprise-grade portal security" or "TISAX-ready."** Sign-in is password-only until PR 25, the token is kept in localStorage (`portal/api.ts:8`), there is no SSO, and the draft design's go-live bar is an open decision (D20).
- **"Your installed base is in Anvil."** The portal shows the spare worksheet we share. The count is guns on that sheet, not a register of their plant.
- **"Live shipment tracking" or "ETA."** The portal shows dates we committed to and despatches recorded from challans. Nothing else.
- **"Delivered."** We know when we despatched, not when it arrived.
- **"Spares due" or predictive consumption.** No consumption basis exists.
- **"Automatic PR-to-PO matching for every PO."** It needs the customer to give the PR number, a readable requisition on the PO, a single PR across the whole PO, and the full PO extracted.
- **"Reply to our email and the reminders stop."** Only for replies traced through the Graph mailbox, and even then the answer itself still has to be recorded.
- **"Reorder, pay or download invoices in the portal."**
- **"Automatic follow-up emails"** for the pilot tenant: they are off by design.
- **"Request a quote in the portal"**, until PR 21 ships.

---

## 8. Risks, the most dangerous step, and containment

**The most dangerous step is PR 18's automatic conversion.** CONVERTED has no way back out (`quotes/index.js:42`). A wrong link stops the quote's cadence, removes it from the chase list, and tells the customer "PO received" for something they never ordered.

It is contained by:
- converting only on a **unique** normalised PR match, for the same customer, within 365 days, on a quote the customer itself marked "PR raised";
- linking at reconcile, where staff can see it and reverse it by editing the PR number, but converting only when a person **approves** the order, after the blocker check at `orders/[id].js:175-179`;
- recomputing line agreement from the **stored** lines every time the link runs, never from a value captured at intake. A large PO whose later pages carry a second PR number is therefore caught after the background merge (`so-intake.tsx:997-1035`, `cron/extraction_jobs.js:749-765`);
- refusing to link while the order still has an extraction job in flight;
- refusing to link when line-level PR numbers differ (PR 4 makes them visible) or when two responses match, and saying so in a finding;
- never converting through part overlap, which is how reconcile pools quotes (`reconcile_quotes.js:1-10`);
- an audit row naming the response and the order behind every conversion.

| Risk | Containment |
|---|---|
| **Migrations are applied by hand.** 227 to 231 may be merged but not applied, or a prerequisite may be missing; 197, 199 and 226 are not confirmed live. | The apply-state query in the runbook, covering every column a pilot PR reads (§3). `shared_at`, `released_at` and the response columns fail closed (no fallback for a missing column). `owner_user_id` and the requisition columns are nullable and degrade to today's behaviour. |
| **The nudge switch fails open.** If 228 is merged but not applied, the code treats the switch as on, and the pilot tenant emails customers. | The toggle returns 503 naming 228 when the column is missing; the runbook confirms 228 and the switch before the first Send. |
| **Identity hole before PR 1.** A portal JWT is auto-onboarded into `tenant_members` through five callers; one wrong approval makes a customer a staff user. | PR 1 goes first; no invites before it ships. A missing `portal_users` table means no portal identity; any other read error fails closed. |
| **Inviting before PR 14.** A session sees every matrix of its customer and unreleased drawings. | The invite gate (§6): PRs 1, 13 and 14 deployed, 197, 199 and 229 applied. |
| **One person, two portal identities.** Portal lookups read one row by `auth_user_id` with no tenant filter, so a second row in any tenant breaks that person's sign-in everywhere. | The cross-tenant invite guard (PR 13). |
| **First exposure of data to customers** (PR 14, 15, 17). | One allowlist constant per row type, including the summary. Tests whose mocked rows carry the forbidden keys. Scope-surface and write-surface tests derived from the source files. The orders view is built on the customer-safe despatch register and never on the staff pending model. |
| **Legacy tokens outlive the plan.** Five minters and five endpoints; minting after a revoke would undo it. | One PR (PR 2) stops every minter and closes every route; the revoke runs only after it is deployed. |
| **The extraction quality of the requisition number is unmeasured**, and Gemini runs first. | The per-line display with OCR markers (PR 4); an editable header field; the parity test; a fallback to part matching, stated in the result. Count matched versus unmatched on the pilot's own POs. |
| **A challan uploaded on the wrong order.** Despatches would show to the customer on someone else's order. | PR 3 checks the challan's references against the chosen order and refuses a mismatch. |
| **Mode B.** If the tenant's clerks process orders in Tally and never approve them in Anvil, conversion never fires and the portal stays at "PR raised". | Decide the mode in the runbook. The "PR raised, no PO yet" lane shows the age. |
| **An order cancelled after approval leaves its quote CONVERTED.** | The audit row records the link. Listed as a known limit. |
| **Line positions are used as keys.** `dispatch_lines.line_index` is an array position, and removing a line shifts it (`so-workspace.tsx:1638`). | A `part_no` recheck before a despatch is shown on a line (PR 17). |
| **Renaming a matrix column** orphans `recommended_spares` rows, which are keyed on part and category name (`159:101`), and loses customer part numbers and quote status in the portal. | spares.tsx warns before renaming a column of a shared matrix. |
| **Cadence and the quote email depend on the external cron tick** (`tick.js`), and the drawer says "sent" while the email is still queued (`QuoteDetailDrawer.tsx:403-404`). | Nudges are off for the pilot. The portal shows the quote at send time regardless of the email. The toast is left as a known bug. |
| **Dead goals crowd the runner.** The runner takes the 50 oldest due goals across all tenants; a goal left active and rescheduled hourly never leaves that queue. | PR 12 ends a goal with `give_up` after its one escalation. |
| **Customer merge breaks portal data.** The live merge is `customers/merge.js` (admin only). It re-points opportunities and `portal_quote_acceptances` (`:37-53`) but not quotes, `spare_matrix` or `portal_users`. By default it then deletes the duplicate (`:169-174`). That sets `quotes.customer_id` and `spare_matrix.customer_id` to null (`068:46`, `159:27`), so the response rows that carry PR numbers point at quotes with no customer. It also deletes that customer's `portal_users` (`199:20`). The other implementation, `_lib/customer-merge.js`, re-points quotes but not opportunities, and has no caller outside its test. | Runbook: no merges of customers that have portal users, shared matrices or quotes during the pilot. The merge fix needs its own PR (§9). |
| **New actions are open by default.** `hasAction` admits every role for an action missing from `SERVER_ACTIONS` (`auth.js:236`). | Every new action (`customer.assign_owner`, `opportunity.assign`, `drawing.release`) is registered on both sides in the PR that uses it, with a test that it is present. |
| **Rep scope is not a wall, and the client-side role can be changed** (`rbac.ts:142-146`). | Every new rule is enforced on the server; see the claim list in §7. |
| **Tests mock Supabase**, so enum-label and wire-shape bugs pass (the `view.js` statuses survived this way), and CI's tables are empty. | Assertions against the migration text and enum text for every new literal; fixtures copied from real responses; the 229 CI step seeds the rows that could break it. |
| **The welding vertical pack seeds tables that do not exist** (`admin/install_vertical_pack.js:73-120`). | Do not use it to onboard the prospect. |

---

## 9. Bugs found during the survey

### Fixed in passing

| Bug | Where | PR |
|---|---|---|
| Legacy accept sets any order of the token's customer to APPROVED, with no status check | `accept_quote.js:108-140` | 1 |
| Any token can accept a quote that has no customer | `accept_quote.js:46` | 1 |
| The acceptance audit writes a nonexistent `actor_id` column | `accept_quote.js:87,144` | 1 |
| SCHEDULED and DISPATCHED in the customer status list are not enum values | `view.js:27-29` vs `001:118-121` | 1 |
| Legacy `kind=invoices` serves draft and void invoices | `view.js:97-101` | 1 |
| A portal JWT is auto-onboarded into `tenant_members` | `auth.js:134`, `verify.js:26`, `password_login.js:53`, `passkey/auth_finish.js:144`, `signup.js:94` | 1 |
| Every portal link Anvil emails is a 404, and five paths keep minting tokens for it | `quotes/send.js:102-126`; `invoices/send.js:35-54`; `pay-link.js:28-48`; `share.js:44-71`; `tokens.js:31-52`; `vercel.json:45-46` | 2 (and 15 for the quote link) |
| The token minter stores a null creator | `portal/tokens.js:43` (`ctx.userId`) | 2 (POST retired) |
| The delivery-note ingest writes to an explicit `order_id` with no check | `delivery_note_ingest.js:100-142,191` | 3 |
| Reads a nonexistent owner column and a nonexistent `users` table | `credit_review_request.js:24,52-53` | 5 |
| The member directory returns unapproved members without saying which | `admin/members.js:46-74` | 5 |
| The Opportunities screen reads fields the API never returns and multiplies probability by 100; a test locks the drift in | `opps.tsx:33-47,404`; `opps-list-view.test.tsx:42` | 6 |
| Opportunity owner is not editable | `opportunities.js:113` | 7 |
| The Predict button always fails (GET vs POST) | `anvil-client.js:1628` | 7 |
| The stalled list shows truncated opportunity ids, and "Revenue by rep" shows truncated user ids | `sales-ops.tsx:146` (opportunity id), `:290` (user id) | 9 |
| Finance is treated as a sales manager | `analytics/pipeline.js:33` | 9 |
| Home is always empty | `home.tsx:34` | 11 |
| A future expiry date is shown as a negative age | `quotes.tsx:262` | 11 |
| Nudges continue after decline, cancellation or expiry | `quote_accept.js:31` | 12 |
| The first nudge goes out within the hour | `011:57`; `send.js:44-93` | 12 |
| Escalates on every run after the due date and never ends the goal | `quote_accept.js:95-101`; `run.js:60-63` | 12 |
| An emailed reply never stops the nudges | `handle_replies.js:34`; `graph-reply.js:42-53` | 12 (traced replies only) |
| The Agents screen arms the quote goal on an order | `agents.tsx:19` | 12 |
| The invite lands on the staff sign-in callback | `invite.js:60` | 13 |
| An invite for an email that already has an auth account fails with a raw error | `invite.js:60-61` | 13 |
| Every contact edit returns 400 | `anvil-client.js:932` vs `contacts.js:60` | 13 |
| Portal login has no rate limit | `login.js` | 13 |
| The scope-surface test reads only three named files | `api-portal-scope-surface.test.js:38-39` | 13 |
| The Share link is dead, and Share reuses broad tokens that never expire | `share.js:44-71,83` | 2, 14 |
| Every matrix of the customer is visible; uploaded drawings cannot be opened; unreviewed drawings are shown | `view.js:103-109,124`; `PortalHome.tsx:113` | 14 |
| Portal "quotes" read orders | `view.js:83-89` | 15 |
| The summary returns the open-invoice count and the contact email with no allowlist | `view.js:53,73-82` | 15 |
| `declined_reason` is dropped unless the quote is already DECLINED | `quotes/index.js:411` | 16 |
| The pending view's customer header is always null (nonexistent `display_name`) | `pending_sales_orders.js:64` | 17 |
| The pending view takes the oldest 500 orders before filtering status | `pending_sales_orders.js:65-70` | 17 |
| Reconcile overwrites the quote link | `reconcile_quotes.js:254` | 18 |
| `promise.js` reads customer lead times as handling time (under the D11 default) | `delivery/promise.js:50-56` | 19 |
| Spare quotes are priced at 0 | `to_quote.js:101` | 20 |
| Ingested quotes have no `created_by` | `quote-ingest.js:268-292` | 22 |
| The Internal SOs list is always empty | `internal-sos.tsx:56` vs `internal_so.js:34` | 24 |

### Deliberately left

| Bug | Where | Why left |
|---|---|---|
| Schedule paste stamps the paste row number as `line_index` | `so-workspace.tsx:1500-1512` | The portal does not read schedule lines (D10). The staff `promised_date` still prefers them (`pending_sales_orders.js:183`). Needs its own PR. |
| Removing a line shifts `dispatch_lines` and schedule positions | `so-workspace.tsx:1638` | Contained by the `part_no` recheck, not fixed. |
| The customer upsert wipes fields on partial edits, including `parent_customer_id` | `customers/index.js:133-176`; `customers.tsx:206-216` | The owner column is kept out of it and pinned by a test. The fix needs its own PR. |
| `current_tenant_ids()` ignores member status | `001:40-43` | A row-level-security change across every table, and the API bypasses RLS anyway. Needs its own security PR. |
| The planner reads a view that has no tenant column | `085:431-456` | A security fix outside this scope; flag it before enabling planning. |
| The live customer merge leaves out quotes, `spare_matrix` and `portal_users`, then deletes the duplicate, which nulls the first two and deletes the third. It also names `portal_access_log.customer_id`, which does not exist | `customers/merge.js:37-53,169-174`; `068:46`; `159:27`; `199:20` | Covered by the runbook guard in §8. Needs its own PR, which should also decide whether `_lib/customer-merge.js` replaces it or is deleted. That file re-points quotes but not opportunities, and has no caller outside its test. |
| A PATCH to SENT and a revise do not arm the cadence | `quotes/index.js:148-183,402-409` | The chase list covers every SENT quote regardless of goals. |
| The drawer says "sent" while the email is still queued | `QuoteDetailDrawer.tsx:403-404` | Unrelated to the loop's data. |
| Recompute overwrites the operator's min/max | `recompute_recommended.js:129-131` | Matters only if D8 changes. |
| `notifyAdmins` deduplication does nothing | `notifications.js:38-51` | Escalations no longer depend on it. |
| Win/loss cannot record a loss; lead conversion does not work | `winloss.js:18-20`; `leads.js:64` | Not in the loop. |
| Opportunity line items write a nonexistent column, so none can be created and the quote line prefill from an opportunity is always empty | `line_items.js:25,98`; `quotes/index.js:265-283` | Not in the loop; PR 8 does not claim the prefill. |
| Copilot quote tools read orders and nonexistent columns | `erp-chat-tools.js:231-321` | Not in the loop. |
| The replenishment handler reads `orders.line_items`, which does not exist | `replenishment_suggestion.js:35-42` | North-star work. |
| The vertical pack seeds tables that do not exist | `admin/install_vertical_pack.js:73-120` | Covered by the runbook warning. |

---

## Review notes

- PR numbers shifted by one from the old PR 2 onward, because the token retirement became its own PR 2 (old PR N is now PR N+1).
- Customer merge (§8, §9): accepted with a correction. `_lib/customer-merge.js` has no caller outside its test, so it is not a second live merge path. The live path is `customers/merge.js`, and the tables it orphans or deletes are listed against it.
- Migration 229 backfill: the suggested `CASE WHEN detail ~ '^\s*\{' THEN detail::jsonb END` guard was not used, because a malformed row that starts with `{` would still abort the cast. The backfill reads the customer id with a regular expression and never casts.
- D15: of the two fixes offered, the separate customer-release stamp was chosen over relabelling `approval_status`, so the provisioned engineering column keeps its meaning. The relabel is recorded as the alternative.
- Portal-request back-link (PR 21): of the two fixes offered, "write `quote_id` only where it is null" was chosen over skipping the back-link, so a never-quoted spare still shows that it was requested.
- Legacy pay path (D18): the recommendation is to retire it rather than keep it, because OEMs pay by SAP bank transfer and the link it emails is a 404 today. Keeping it is recorded as the alternative.