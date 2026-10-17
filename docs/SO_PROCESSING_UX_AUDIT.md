# Sales-order processing: UX audit for a Mode B sales engineer

Read-only audit. No code was changed.

> **Status (2026-10-16).** This is a snapshot of 2026-10-14. Most of its PRs
> have since merged: PR 2 as #603, PR 3 as #605, PR 4 as #604, PR 5 as #606,
> PR 6 as #608, PR 7 as #607, PR 8 as #609, PR 9 as #600, PR 10 (read path) as
> #601 and PR 12 as #602. PRs 1, 11 and 13 to 20 and the owner decisions in
> section (e) are still open. `docs/SO_EXECUTION_COHESION.md` carries them
> forward as A-PRn and A-Dn, and re-verifies what is left.

| | |
|---|---|
| Base | `origin/main` at `c2f3ebf8` (2026-10-14). It includes #597 and #598. #599 (LLM wording judge) is still open. #566 (tick scheduler) and #238 (header defaults) are open and held. |
| Line numbers | Exact on `c2f3ebf8`. They drift. Search for the symbol if a line moved. |
| Live app | Opened the production app at `#/so` signed out. It shows the marketing page only. The rules forbid sign-in, so every finding comes from the code. |
| Paths | `so-intake.tsx`, `so-workspace.tsx`, `approvals.tsx`, `pipeline-kanban.tsx`, `so-register.tsx`, `home.tsx` are in `src/v3-app/screens/`. Component files are in `src/v3-app/components/`. API files are under `src/api/`. |

---

## 0. Summary

- **Happy path today: about 30 clicks and 4 to 5 typed fields** (about 300 keystrokes), over three people and an email client. The approver gets no signal, so the elapsed time has no bound.
- **Proposed: about 12 clicks and 0 typed fields.** Engineer 5, approver 2, handoff 2, ERP SO upload 3 (unchanged).
- **Exception path today** (one price mismatch and one terms flag): about 41 clicks and 7 typed fields. With one return loop it is about 55 clicks. **Proposed: about 18 clicks and 0 to 2 typed fields.**
- The two biggest costs:
  1. **The approval loop is open.** The Approvals queue never changes the order. Nobody is notified at any stage. Orders have no submitter and no assignee.
  2. **The Mode B handoff is still manual.** Its settings shipped in #580. The send (plan PR 16) is not built.
- **Flags are spread over at least eight places.** A price mismatch has no decision control. The anomaly rules run only when someone clicks "run validation".
- **The PO delivery date that #589 extracts is read by nothing in the order flow.** The workspace grid does not read it. The Header tab does not read it. The SO PDF does not read it.

---

## (a) The journey today

The table assumes a clean PO, the customer in the master with a GSTIN, and Mode B. A "click" is one pointer action. Picking a file in the OS dialog counts as 1.

| # | Step | Screen and controls | Clicks and typed fields | Prefill and its source | Waits | Issues | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Upload the PO | SO list "New from PO", then Intake. Intake has order-mode cards (default SPARES), a customer select, a drop zone with "browse" and "photo", and "continue". | 4 clicks (New, browse, file, continue). 0 typed. | Order mode defaults to SPARES. It is not inferred from the PO. Customer: see step 3. | (1) Upload. (2) Sync extraction, up to the 45 s run budget. Its bar is an asymptotic estimate, not real progress. (3) On "continue", the client waits for order create (server item map, auto reconcile up to 8 s, terms check), then a **Mistral OCR call**, then a reconcile read. The only sign is "creating…". (4) A PDF over 40 pages reads page 1 now. The rest becomes a background job. | (1) The OCR call is awaited, though the comment says "don't block navigation". (2) "Profile match" is static text. "Estimated cost ₹ 2.40" is hardcoded. (3) The stepper reads "step 1 of 6 … Push to Tally" in Mode B. | `orders.tsx:183`; `so-intake.tsx:23-60` (bar), `:933-1104` (continue), `:1035-1037` (awaited OCR), `:1111`, `:1121`, `:1415-1439`; `_lib/docai/run.js:343`; `docai/extract.js:43` |
| 2 | Attach the quote | Workspace QuotesStrip, above the tabs. It is not on the intake screen. | 0 clicks when the quote is already in Anvil. The reconciler pools every non-draft, non-cancelled quote of the customer. Otherwise 2 clicks ("Attach quote PDF" and file; several files are allowed). | Customer quotes are found automatically. A PDF of our own quote is recognised by its number and is not re-extracted. | Per file, in sequence: upload, quote extraction, attach, re-reconcile. | (1) A quote needs a customer on the order. (2) The customer cannot be set after create (step 3). (3) This step is otherwise well designed. | `QuotesStrip.tsx:135-266`; `orders/attach_quote.js:65-69`, `:99-140`; `_lib/order-reconcile.js:33`; `so-workspace.tsx:2191-2266` |
| 3 | Check the customer | Intake right column: "Customer" card, "From PO header" card, mismatch banner, new-customer dialog. In the workspace there is only the name in the meta row and a "Customer · from PO header" card. | 0 clicks on an auto-match. 2 to 3 clicks when the dialog opens: pick an existing customer, or confirm create. "Update customer" for PO-vs-master differences: 2 or more clicks. | GSTIN exact, then vendor code, then name with bill-to corroboration. The dialog is prefilled from the PO block. | None extra. | (1) **The run-level 0.85 confidence gate also blocks exact GSTIN and vendor-code matches.** A PO with low line confidence then opens "New customer detected" for a buyer we already have (duplicate risk). (2) The match basis appears in a toast only and is not saved. (3) **`customer_id`, `po_number` and `po_date` are not in the PATCH allowlist**, so a wrong customer, PO number or date cannot be fixed after the draft exists. (4) The mismatch banner exists only on intake. | `so-intake.tsx:405-512` (gate at `:408`), `:833-837`, `:1390-1413`; `orders/[id].js:13-41`; `so-workspace.tsx:2147`, `:2608-2626` |
| 4 | Scan the lines | Workspace Reconcile tab (the default): PO PDF beside the line grid. The grid has editable cells, OCR and edited pills, an Issues column, map chips, "Suggest mappings", "+ Add line" and "Save line edits". | 0 clicks to read. Each fix: click the cell, type, then "Save line edits". | Lines come from extraction. The item-master map runs at create. HSN and tax come from the quote through the reconciler. | The workspace makes six or more fetches on open (`soPerf` console probes). | (1) No delivery-date column, though #589 reads `lines[].delivery_date`. (2) The header fields sit in a collapsed `<details>`. (3) "Extraction quality" is collapsed. | `so-workspace.tsx:2557-2832`, `:2596-2607`, `:2627`; `SOWorkspaceReviewCells.tsx:88-158`; `orders/index.js:154-165` |
| 5 | Review flags | Eight surfaces (F3). | About 4 clicks: run validation, Why tab, Terms tab, back. Each terms flag: 3 clicks and a reason of at least 10 characters. A price mismatch has no control at all. | The reconcile and the terms check run on the server, at create and on every line save. | The "run validation" call. | (1) No single list. (2) Price, description and unmatched flags are banner text with no decision and no reason record. (3) Anomaly rules run only on a click. (4) Engineers may not accept a high or critical terms flag, and nothing sends the flag to a manager. | `so-workspace.tsx:2156-2433`, `:996-1044`, `:2093-2104`, `:2885-2934`, `:2975-2984`; `TermsPane.tsx:22`, `:141-232`; `lib/rbac.ts:149` |
| 6 | Set the delivery date | Header fields tab: committed delivery date, delivery contact, dispatch mode, incoterm, delivery terms text. The Schedule tab takes per-line dates as a TSV paste. | 5 clicks: tab, date, contact select (2), "Save header". 1 typed field (the date). | Only `vendor_code` is stamped from the PO. The committed date is blank. The PO delivery date (#589) is behind a canary: `po_extractor@v4`, weight 0.05, off unless `docai_prompt_variants` is on. It lands in `result.salesOrder.customer.delivery_date` and `lines[].delivery_date`. Nothing in the SO flow reads it. | None. | (1) Two date ideas, the PO date and our committed date, with no source labels. (2) **The SO PDF due date reads schedule lines or `result.salesOrder.delivery_date`. Nothing writes the second.** (3) The only check against PO date plus quoted lead time is a terms rule, and only when the terms check is on. (4) Saving the header can patch `result`, which re-hashes the order and re-runs the reconcile. | `SOWorkspaceOrderPanels.tsx:20-259` (date `:241-243`, contact `:228-239`, sources `:127-135`); `so-intake.tsx:957-958`, `:999`; `orders/so_pdf.js:80`; `_lib/terms/compare.js:255-280` |
| 7 | Send for approval | Workspace header button "send for review". | 1 click. No confirm, no note, no gate. | The payload hash is stamped. `quote_approvals` rows are created only when a threshold matches. | None. | (1) **No approver is assigned and no one is notified.** The bell renders for admin and operator only, and it is one tenant-wide row. (2) Orders have no submitter or owner column. (3) An order can be sent with open flags, no lines or no date. | `so-workspace.tsx:972-984`, `:2108-2117`; `orders/[id].js:228-237`, `:363-378`; `_lib/approval-evaluator.js`; `components/Shell.tsx:600`; `_lib/notifications.js:35-94`; `supabase/migrations/001_init.sql:134-162` |
| 8 | Approver decides | (a) The Approvals queue lists threshold rows only. (b) The SO workspace has approve, "return for fix" and cancel. (c) The Kanban approves on a drag. To find the order the approver uses the Register status filter or the Home "In approval" count. | 4 to 5 clicks to find the order, plus approve (1). Return: 1 click, typed text, OK. | None. | None. | (1) **The queue's approve and reject write `quote_approvals` only, never `orders.status`.** Only the queue's "return for fix" touches the order. (2) No REJECTED status exists. Reject records no reason. Cancel records no reason. (3) "Return for fix" uses `window.prompt`, which a browser can suppress. (4) The toasts say "operator notified". Nobody is. (5) The Approval tab says decisions come from the queue. (6) Approve is enabled on DRAFT, and the server refuses it there. (7) The approval TTL is 24 h. After it, status changes return 409. (8) The server checks only that a hash is present, not that it matches. (9) A Kanban drop approves without opening the order. | `approvals.tsx:203-245`, `:251-269`, `:358`; `admin/quote_approvals.js:121-131`; `so-workspace.tsx:697-766`, `:2123-2138`, `:2986-3001`; `orders/[id].js:59-70`, `:177-200`; `pipeline-kanban.tsx:155-178`; `so-register.tsx:205-211`; `home.tsx:39-44` |
| 9 | SO generated | Header buttons "Download SO" and "Excel". "ERP voucher" appears after APPROVED. | 1 to 2 clicks. | The SO PDF builder. | Render. | (1) The SO PDF voucher number is always blank: `so_voucher_no` is read and written nowhere. (2) Payment terms print the customer default or the literal "30 Days", not the PO's terms or the decided term. (3) The dispatch default is "By Road". (4) The stepper ends at "Push to Tally" and never completes in Mode B. (5) The primary header button is "push to Tally", which returns 409 in Mode B. The mode is stated only on the Tally tab. | `so-workspace.tsx:1995-2008`, `:2139-2144`, `:2464-2501`; `orders/so_pdf.js:106-111`; `SOWorkspaceOrderPanels.tsx:474-485` |
| 10 | Mode B handoff | Nothing in the workspace. Admin settings exist from #580. The Register "Handoff" column is a placeholder. The ERP SO upload is on the "PO vs ERP" tab. | Outside Anvil: about 8 clicks and 3 to 4 typed fields (date, contact, phone, shipment mode, PO number; about 150 to 300 characters). ERP SO upload: 3 clicks. | None. The inputs exist only in scattered places. | None. | (1) The engineer retypes everything. (2) Anvil holds no record that the handoff happened. (3) No "changed since handoff" signal. | `components/OrderHandoffSettingsEditor.tsx`; `admin/order_handoff_settings.js`; `_lib/internal-recipients.js`; `so-register.tsx:302-303`; `ErpSalesOrderUpload.tsx`; `docs/SO_TERMS_AND_HANDOFF_SCOPE.md` §8 |

### Click counts

| Path | Engineer | Approver | Handoff | ERP SO upload | Total | Typed fields |
|---|---|---|---|---|---|---|
| Happy path today | 11 to 12 (New, browse, file, continue, run validation, Header tab, date, contact ×2, save, send for review) | 5 to 7 (find in Register, approve) | about 8, outside Anvil | 3 | **about 30** | 4 to 5 |
| Exception path today (one price mismatch, one high terms flag) | +4 to 7 (Terms tab, decision, reason, submit; a rate edit and save if they "fix" the price) | +4 (Terms tab, accept, reason, submit) | same | same | **about 41** | about 7 |
| Same, with one return loop | +7 (find the returned order, fix, resend) | +7 (prompt, find again, approve) | same | same | **about 55** | about 8 |

---

## (b) Friction ranked by impact

Impact is the touch time saved per order multiplied by the share of orders it hits. Elapsed latency is shown apart, because it dominates time to SO but costs no clicks. Minutes are estimates from the click and wait counts above.

| Rank | Friction | Who | Touch time | Share of orders | Impact (min per order) | Elapsed effect |
|---|---|---|---|---|---|---|
| 1 | **F1. The Mode B handoff is manual.** | Engineer | 5 to 8 min | 100% (Mode B) | about 6 | Handoff waits for the engineer to find time |
| 2 | **F2. The approval loop is open:** the queue does not decide the order, nobody is notified, nobody is assigned. | Both | 2 to 4 min (find the order, chase by phone or chat) | 100% | about 3 | **Hours to days. This is the largest share of time to SO.** |
| 3 | **F3. Flags are in eight places**, with no single "what needs my decision" list, and price flags have no decision control. | Both | 2 to 4 min | 100% | about 3 | Missed flags become returns (F5) |
| 4 | **F4. The delivery date and contact are typed by hand**, and the PO date that #589 extracts is unused. | Engineer | 1 to 2 min | 100% | about 1.5 | Wrong dates reach Tally |
| 5 | **F5. The return and reject loop has no notification**, no reject reason and no resubmit diff. | Both | about 10 min per loop | 10 to 20% | about 1.5 | Each loop adds hours |
| 6 | **F6. Waits show no real progress**, and OCR blocks navigation. Large POs do not refresh in the workspace. | Engineer | 0.5 to 1.5 min idle | 100% (large POs about 5 to 10%) | about 1 | Large POs: minutes, or no end if the tick is not scheduled |
| 7 | **F7. The anomaly rules run only on a click** and are not run by the server. | Engineer | 0.5 min | 100% | about 0.5 | When skipped, the approver sees no anomaly |
| 8 | **F8. Customer match has gaps:** the 0.85 gate blocks exact GSTIN matches; customer, PO number and PO date cannot be changed; the match basis is not saved. | Engineer | 1 to 5 min | 15 to 25% | about 0.7 | A wrong customer means cancel and redo; duplicates grow |
| 9 | F9. Header overload and Mode B mislabels. | Both | about 0.3 min | 100% | about 0.3 | Training cost; wrong clicks get a 409 |
| 10 | F10. Role confusion: unregistered actions allow every role; approve shows on DRAFT; no route for "manager must accept". | Both | small | 5 to 10% | about 0.2 | Engineers stall on high terms flags |

### F1. The Mode B handoff is not built

- The settings shipped in #580: `tenant_settings.order_handoff_*` (migration 251), the editor, and `resolveInternalRecipients` with role tokens.
- The send, `/api/orders/handoff` (plan PR 16), does not exist. The Register "Handoff" column always reads "not sent" (`so-register.tsx:302-303`).
- So the engineer:
  1. downloads the SO PDF;
  2. finds the original PO;
  3. opens Outlook;
  4. retypes the material date, contact, phone, shipment mode and PO number;
  5. sends.
- Anvil keeps no record that this happened.
- The design is complete in `docs/SO_TERMS_AND_HANDOFF_SCOPE.md` §8. Only owner decisions 3, 5, 6, 7, 8 and 10 block it.

### F2. The approval loop is open

- **The queue does not decide the order.** `approvals.tsx:203-217` posts to `/api/admin/quote_approvals?type=approvals`. The handler updates `quote_approvals` only (`admin/quote_approvals.js:125-131`). The order stays PENDING_REVIEW after "approve" and after "reject".
- **The queue is often empty.** Rows exist only when a `quote_approval_thresholds` row matches (`_lib/approval-evaluator.js`). The queue says so: "Pending approvals appear here when an SO breaches policy" (`approvals.tsx:358`).
- **No notification at any step.**
  - `orders/[id].js` sends nothing on PENDING_REVIEW, on approve, or on return.
  - The bell is one tenant-wide row (`_lib/notifications.js:62-94`).
  - It renders only for admin and operator (`components/Shell.tsx:600`).
  - Sales engineers and sales managers never see it.
- **No assignee and no submitter.**
  - The `orders` table has no `created_by`, `submitted_by` or approver column (`001_init.sql:134-162`).
  - Home "My queue" is every open order, not mine (`home.tsx:39-41`).
- **The approver must hunt.** Path: Sales orders, Register, status filter, row.
- **The workspace misleads.**
  - The Approval tab says decisions come "via the Approvals queue" (`so-workspace.tsx:2996-2998`).
  - Approve is enabled on DRAFT (`:2134`), where the server refuses the transition (`orders/[id].js:59-70`).
- **Approval is not bound to the hash.** The server checks only that `approval.payloadHash` exists. It does not compare it with `orders.payload_hash` (`orders/[id].js:185`). An engineer's line edit after the approver loaded the page is still approved.
- **The Kanban approves blind.** A drop on "Approve" approves without opening the order (`pipeline-kanban.tsx:170-178`).

### F3. Flags are spread over eight places

| # | Surface | What it shows | Can you decide there? | Evidence |
|---|---|---|---|---|
| 1 | QuotesStrip verdict column | n/n matched, money above or below the quote, unpriceable count, incoterm missing | No | `so-workspace.tsx:2198-2265` |
| 2 | Quote check banner | Price, description and unmatched lines (first 10); payment and incoterm verdicts; quoted-only gaps | Gaps only ("Add as variance") | `:2267-2433` |
| 3 | MOD-BOM banner | Provisional `-MOD` parts. They block approval. | No (the blocker is cleared in the Why tab) | `:2156-2175` |
| 4 | Extraction quality card (collapsed) | Validator and anomaly issues from the extraction run | No | `SOWorkspaceReviewCells.tsx:88-158` |
| 5 | Grid "Issues" column | `rule_findings` per line. Empty until "run validation". | No | `so-workspace.tsx:1375-1382` |
| 6 | Why tab | Every finding. Resolving a blocker needs `approve`. | Blockers only, approvers only | `:2885-2934`; `orders/[id].js:142-154` |
| 7 | Terms tab (only when `terms_check_mode` is on, or shadow for an admin) | Terms flags, four decisions, a reason of 10 characters or more | Yes | `:2975-2984`; `TermsPane.tsx` |
| 8 | Intake mismatch banner (intake only) | PO vs master customer fields | Update the master | `so-intake.tsx:1390-1413` |
| (9) | Tally tab | Drift findings (Mode A) | Resolve | `SOWorkspaceOrderPanels.tsx:445-471` |

- A price mismatch, the most common exception, has no "accept PO rate", "use quote rate" or "request amendment" control. The engineer can edit the rate cell, which rewrites the customer's own number, or leave it. The approver sees no record of why it was accepted.
- The marketing page shows the pattern the product lacks: an inline anomaly row with "Use ₹184 / Confirm ₹1,840" buttons (seen live, signed out).

### F4. The delivery date and contact are typed by hand

- #589 extracts `customer.delivery_date`, `customer.contact_name` and `lines[].delivery_date`, but behind a 5% canary that is off by default (`_lib/docai/prompt-versions.js`, `po_extractor@v4`).
- Even when it is on, nothing in the order flow reads the values. Every SO-side reader:
  - `so_pdf.js:80` reads schedule lines or `result.salesOrder.delivery_date` (a key nothing writes);
  - the workspace grid has no date column;
  - the Header tab's committed date starts blank (`SOWorkspaceOrderPanels.tsx:28`, `:241-243`);
  - the register does not show it.
- There are two date concepts and no source labels:
  - the PO's required date;
  - our committed date (used for OTD).
- The only cross-check against the PO date plus the quoted lead time is the terms rule `leadTimeRule` (`_lib/terms/compare.js:255-280`). It runs only when the terms check is on, and the PO side comes from the operator's typed `delivery_terms` or the terms pass.
- The delivery contact is a manual select. Held PR #238 would prefill it from the primary customer contact.

### F5. The return and reject loop has no notification

- Workspace "return for fix" collects the reason with `window.prompt` (`so-workspace.tsx:738`). The file itself notes that browsers can suppress native dialogs (`:214-217`).
- The engineer is not notified. The toasts claim "operator notified" (`:758`; `approvals.tsx:263`). The banner appears only when the engineer happens to reopen the order (`so-workspace.tsx:2514-2529`).
- There is no REJECTED status (`orders/[id].js:59-70`).
  - Queue "reject" records no reason, because `comments` is not sent (`approvals.tsx:213`).
  - Cancel records no reason (`so-workspace.tsx:687`).
- A resubmit notifies nobody. It shows the approver nothing about what changed since the last review.
- The 24 h approval TTL (`orders/[id].js:199-200`) blocks any later status change (`:177-179`). In Mode B, APPROVED is where the order rests, so a cancel or return after a day fails. The approve button is disabled on APPROVED, so the only way out is to edit a line, which clears the approval.

### F6. Waits show no real progress

- The intake extraction bar is an asymptotic estimate capped at 95% (`so-intake.tsx:23-60`). The run budget is 45 s (`_lib/docai/run.js:343`).
- On "continue", the client awaits the Mistral OCR call before navigating (`so-intake.tsx:1035-1037`). It awaits a reconcile read after that (`:1082`). The only label is "creating…".
- **Large POs (over 40 pages) and dense POs** become background jobs:
  - The workspace progress strip renders only while a local action is busy (`so-workspace.tsx:2443-2447`).
  - So after intake, the engineer sees no progress and no auto-refresh when the lines land.
- The jobs drain through `/api/cron/tick`, but `vercel.json` schedules only `/api/cron/daily`.
  - `docs/CRONS.md` relies on an external cron-job.org ping.
  - #566, which adds a scheduler, is open.
  - If that external ping is not configured, a large PO waits until something else drains the queue. **Verify the external cron.**

### F7. The anomaly rules run only on a click

- `/api/anomaly/compute` has 18 rules covering rate, margin, GST, credit, alias and hygiene.
- It runs only from "run validation" (`so-workspace.tsx:996-1044`). The server reconcile does not call it (`_lib/order-reconcile.js`; `orders/index.js:251`; `orders/[id].js:386-388`).
- The stepper's "Validate" step lights on that click or on PENDING_REVIEW (`:2486-2488`). So "send for review" marks Validate done even when no rule ever ran.

### F8. Customer match has gaps

- **The gate.** `matchCustomerFromExtraction` returns null for every tier when the run confidence is below 0.85 (`so-intake.tsx:408`). That run confidence mostly reflects the lines. An exact GSTIN match, which the code itself calls "can't false-positive" (`:412`), is then dropped, and the "New customer detected" dialog opens.
- **No fix after create.** `customer_id`, `po_number` and `po_date` are absent from the PATCH allowlist (`orders/[id].js:13-41`).
  - A wrong auto-match means cancel and redo.
  - Inbound email orders with no customer carry "assign one before approval" (`inbound/email/draft_orders.js:53-55`), but no screen or endpoint can assign one.
- **No saved basis.** The match basis (`exact_gstin`, `exact_vendor_code`, `exact_name`) is shown in a toast (`so-intake.tsx:833-837`) and not saved, so neither the workspace nor the approver can see how the customer was chosen.

### F9. Header overload and Mode B mislabels

- The workspace header has 16 controls (`so-workspace.tsx:1981-2145`): email customer, quote PDF, Download SO, Excel, ERP voucher, new invoice, share link, audit pack, cancel, engine select, run extraction, run validation, send for review, return for fix, approve, push to Tally.
- **The primary (dark) button is "push to Tally"**, which always returns 409 in Mode B (`tally/push.js`).
- Both steppers end at "Push to Tally" (`so-intake.tsx:1121`; `so-workspace.tsx:2501`).
- Home KPIs show "Pushed today" and "Pushed MTD" (`home.tsx:115-116`).
- The Mode B banner is on the Tally tab only (`SOWorkspaceOrderPanels.tsx:474-485`).

### F10. Role confusion

- `canDo` returns true for any action that is not in `ACTIONS` (`lib/rbac.ts:205-210`). `so.write` and `so.admin` are not registered, so `canWrite` and `canAdmin` are true for every role, viewers included (`so-workspace.tsx:650-651`). Write buttons look enabled and the server refuses them with 403. This is the client twin of design defect A5 (`_lib/auth.js:269-274`).
- The Approvals decision POST needs only `write` (`admin/quote_approvals.js:122`). The UI hides it from engineers, but the API does not.
- Engineers may not accept a high or critical terms flag (`lib/rbac.ts:149`, by design, decision 2). No flow sends that flag to a manager.

---

## (c) The proposed flow

### Principles

- **One screen per role.** The engineer reviews and decides in one place. The approver decides in one place.
- **Prefill everything Anvil already holds:** extraction, the quote, the customer master, contacts, the PO date and the quoted lead time.
- **No new manual entry.** Every new field arrives prefilled with its source label.
- **Every flag has an inline action.** Every decision records who, when and why. Canned reasons replace typing (owner decision 12).
- **Notify, never queue.** Use the direct-send pattern (`comms/dispatch_register.js`). A `queued` result is reported as not sent.

### The engineer's "Review and decide" surface

This replaces the Reconcile tab as the default view. Other tabs stay for depth.

```
+-------------------------------+--------------------------------------------------+
| PO PDF (existing ReviewDocPane)| SUMMARY STRIP                                   |
| hover = highlight              | Customer: Acme Pvt Ltd  [matched by GSTIN] change|
|                                | PO 4500123 dated 02 Oct   Quote Q-202609-0041    |
|                                | Value 4.2 L  Margin 23% (cost.view)              |
|                                | Required by: 30 Oct [from PO]  Committed: 30 Oct |
|                                | Contact: buyer, 98xxxx [from PO]                 |
|                                +--------------------------------------------------+
|                                | NEEDS YOUR DECISION (2)                 0 blockers|
|                                | ! L4 BR-6205: PO 1,840 vs quote 1,750 (+5.1%,    |
|                                |   +9,000 on 100)                                 |
|                                |   [Accept PO rate] [Request amendment] [Not an issue] |
|                                | ! Payment terms: PO "90 days GRN" vs quote       |
|                                |   "30 days invoice" (high)                       |
|                                |   [Request amendment] [Ask manager to accept]    |
|                                | Decided (3)  v                                   |
|                                +--------------------------------------------------+
|                                | Lines (18) all matched  v (collapsed when clean) |
+-------------------------------+--------------------------------------------------+
| [More v]                         Note to approver (optional) [ Send for approval ]|
+----------------------------------------------------------------------------------+
```

**One exceptions list.** A pure server library builds it, `_lib/order-exceptions.js`, from what Anvil already computes:

| Kind | Source today | Inline actions |
|---|---|---|
| Price, qty or description mismatch | `result.quoteReconciliation.flags` | Accept PO value; Use quote value (a line edit, marked); Request amendment; Not an issue |
| Unmatched line, quoted-only gap | `flags`, `quoted_not_ordered` | Map to item (existing picker); Add as variance (existing); Request amendment |
| Payment terms, incoterm | Reconcile header verdicts, or terms flags when the terms check is on | Route to the existing `terms_decide` |
| Terms flags | `order_term_flags` | Existing four decisions. "Ask manager to accept" assigns a high flag to the manager. |
| Anomaly | `rule_findings` (server-run, PR 8) and extraction-run anomalies | Confirm value; Not an issue; Edit |
| Blocking finding | `rule_findings` blockers, MOD-BOM | Resolve (approver), as today |
| Customer | Match basis and confidence; PO vs master field differences | Change customer; Update master (existing dialog); Ignore |
| Delivery date | PO date vs PO date plus quoted lead time vs committed date | Use PO date; Use quoted date; Request amendment |
| Missing handoff input | Date, contact, shipment mode (PR 16) | Pick from prefilled candidates |

- Rows carry the evidence box for the hover highlight. Decided rows collapse under "Decided".
- **"Send for approval" is one click.** It is disabled only by blocking rows, and it names them.

### Send for approval, routing and notification

1. Send stamps `submitted_by` and `submitted_at`.
2. It resolves the approver with a rule (owner decision 1). Suggested rule:
   - the threshold's `approver_role` when a threshold matches;
   - else `role:sales_manager`;
   - never the submitter.
3. It sends a direct email with a deep link through `resolveInternalRecipients` (#580 already supports role tokens).
4. It writes a bell row that sales roles can see.
5. Register and Home gain "Awaiting my approval" and "Returned to me" filters.

### The approver's single screen

- The Approvals queue lists every PENDING_REVIEW order, not only threshold rows. Its drawer reuses the same summary strip and exceptions list. It shows each engineer decision with its reason, the PO pane, and "changed since last review" when the order is a resubmit.
- Three actions:
  - **Approve:** one click, sent with the payload hash, and the server compares the hash.
  - **Return for fix:** reason chips plus optional text, in-app.
  - **Reject:** reason required (owner decision 3).
- A high terms flag that the engineer sent to the manager can be accepted inline.

### The loop back

- A return or reject emails the submitter with the reason and a link. The order shows "Returned by X: reason" at the top of the decision list.
- A resubmit notifies the same approver. The drawer shows the diff: lines hash, new decisions, edited fields.

### SO generation and handoff

- After approval (or before it, per decision 10), the summary strip shows **"Send to order processing"**. The modal is plan PR 16 as designed:
  - the date, contact and shipment mode per origin group, each prefilled with its source;
  - recipients with the reason for each address;
  - the SO PDF and the original PO attached.
- One click sends it. The register "Handoff" column then becomes real.
- The SO PDF prints:
  - the PO's or the decided payment terms, never a literal "30 Days";
  - the line or PO delivery date;
  - the ERP voucher number once the ERP SO is attached.

### The delivery date has one source of truth

- `required_by` is the PO date. Its order of precedence:
  1. the header delivery date;
  2. else the earliest line date;
  3. else a deterministic "Delivery date:" parse of the description.
- `committed_delivery_date` is ours. It is prefilled from `required_by` when the quoted lead time allows it, else from PO date plus the quoted lead time, and each option is labelled with its source.
- A disagreement is one exception row with three buttons. Per-line dates show in a "Due" grid column only when they differ.

### Click counts, proposed

| Path | Engineer | Approver | Handoff | ERP SO upload | Total | Typed fields |
|---|---|---|---|---|---|---|
| Happy path | 5 (New, file ×2 counted as browse and pick, continue, Send for approval) | 2 (notification link, Approve) | 2 (Send to order processing, Send) | 3 | **about 12** | 0 |
| One price mismatch and one high terms flag | +4 (two inline actions and two reason chips, or "Ask manager to accept") | +2 (accept the routed flag, then Approve) | 2 | 3 | **about 18** | 0 to 2 |

---

## (d) PRs in merge order

Each PR is small, testable and ships its caller. "DF" means decision-free. "ND" means it needs an owner decision (section e). Migrations continue at **264**, the next free number in the memory registry. Check it against the registry file before use.

| # | PR | Caller it ships | Migration | Status | Depends on | Test |
|---|---|---|---|---|---|---|
| 1 | **feat(metrics): SO cycle and rework metrics, baseline first.** Catalog entries for submit time, approval wait, returns per order, actions per order, exceptions per order and handoff lag, derived from `audit_events` and `processing_events` (section f). | `/api/metrics` and the copilot tool that already read the catalog | none | DF | none | Unit test per reducer on fixture events |
| 2 | **fix(approvals): the queue decides the ORDER.** List every PENDING_REVIEW order, with threshold rows shown as reasons. Approve PATCHes the order with the payload hash, then closes the `quote_approvals` rows. "Return for fix" uses the in-app reason box. The decision POST requires `approve`. Hide "reject" until decision 3. | `approvals.tsx` | none | DF | none | API test: approve moves `orders.status`; the decision POST refuses an engineer |
| 3 | **fix(orders): approval is bound to the hash.** `orders/[id].js` refuses an approve whose `payloadHash` differs from `orders.payload_hash` (409 `STALE_APPROVAL`), and the client reloads. | workspace, queue, Kanban | none | DF | 2 | API test: a stale hash is refused |
| 4 | **fix(so-workspace): Mode B labels and dead buttons.** In Mode B, hide "push to Tally" and end the stepper at "Hand off". Enable approve only in PENDING_REVIEW. Correct the Approval tab text. Return for fix and cancel use an in-app modal with a required reason, recorded in the audit. | `so-workspace.tsx`, `so-intake.tsx`, `home.tsx` | none | DF | none | Component tests per mode |
| 5 | **fix(rbac): register `so.write` and `so.admin`.** Add a parity test that every `canDo` key used by the SO screens is registered on both sides. | `so-workspace.tsx` | none | DF | none | Parity test; a viewer sees disabled buttons |
| 6 | **fix(intake): no blocking OCR, and live background progress.** OCR runs fire-and-forget. The workspace polls `extraction_status` while a job is in flight and reloads when the lines land. Remove the static "Profile match" and "Estimated cost" cards. | `so-intake.tsx`, `so-workspace.tsx` | none | DF (the drain still needs #566 or the external cron) | none | Component test with a mocked in-flight job |
| 7 | **feat(orders): fix the customer, PO number and PO date while DRAFT or PENDING_REVIEW.** Add them to the PATCH allowlist for those statuses. A customer change re-runs the item map and the reconcile. Save the match basis at intake. Add a "change" link in the workspace. | `so-workspace.tsx` summary | none | DF | none | API test: allowed in DRAFT, refused after APPROVED |
| 8 | **feat(orders): the server runs the anomaly rules** at the end of `autoReconcileOrder`, before approval only. The button becomes "re-run". | the existing grid Issues column and Why tab | none | DF | none | API test: create yields `rule_findings` without a click |
| 9 | **feat(orders): one exceptions list.** `_lib/order-exceptions.js` (pure) and `GET /api/orders/exceptions`. A read-only "Needs decision" card at the top of Reconcile replaces the banner's bullet list. | `so-workspace.tsx` | none | DF | 8 | Unit tests per source; snapshot of the card |
| 10 | **feat(orders): the delivery date read path.** A "Due" column from `lines[].delivery_date`. The summary shows the PO date with its source. The SO PDF and Excel due date falls back to the line date, then the PO header date, then the committed date. A delivery-date conflict becomes an exception row. | grid, `so_pdf.js`, `export.js` | none | DF (the read path); the committed-date prefill is decision 7 | 9 | Unit test on `buildSalesOrderData`; conflict fixture |
| 11 | **feat(orders): decisions on line and anomaly exceptions.** Migration 264 `order_exception_decisions`: append-only, reason required, carried forward by exception fingerprint. `POST /api/orders/exceptions/decide`. Inline buttons on the card. Terms rows call the existing `terms_decide`. | `so-workspace.tsx` card | 264 | **ND** (decisions 4 and 12) | 9 | API and RLS tests; decision carry-forward test |
| 12 | **feat(so-workspace): the "Review and decide" layout.** PO pane, summary strip, exceptions list, a grid that collapses when clean, a "More" menu for the eight secondary actions, a sticky "Send for approval" that names blockers, and an optional note. | `so-workspace.tsx` | none | DF | 9 (11 for actions) | Component tests: clean order, blocked order |
| 13 | **feat(orders): submitter and approver assignment.** Migration 265: `orders.submitted_by`, `submitted_at`, `assigned_approver_role`, `assigned_approver_id`. Send for review resolves the approver (never the submitter). "Awaiting my approval" and "Returned to me" filters on Register and Home. | `so-register.tsx`, `home.tsx` | 265 | **ND** (decision 1) | 2 | API test: maker-checker refusal |
| 14 | **feat(notify): direct-send notifications** on submit, approve, return and reject, plus a bell row visible to sales roles. Use `resolveInternalRecipients` role tokens and the direct-send pattern. A `queued` result is shown as not sent. | `orders/[id].js`; `components/Shell.tsx` | none | **ND** (decision 5) | 13 | API test with a mocked mailer; queued shown as not sent |
| 15 | **feat(approvals): the approver's one screen.** The queue drawer reuses the summary and the exceptions list with the engineer's decisions, the PO pane, and "changed since last review". Approve, return with a reason, reject with a reason. Accept a routed high terms flag inline. | `approvals.tsx` | none (reject may need one) | **ND** (decision 3) | 2, 9, 11, 13 | Component tests per decision |
| 16 | **Plan PR 16: the handoff send**, as designed in `SO_TERMS_AND_HANDOFF_SCOPE.md` §8, launched from the summary strip. It makes the Register "Handoff" column real. | `so-workspace.tsx`, `so-register.tsx` | uses 251 | **ND** (design decisions 3, 5, 6, 7, 8, 10) | 12, 13 (#580 is already merged) | As in the design |
| 17 | **fix(so-pdf): print what the order says.** Payment terms come from the decided term or the PO, never a literal "30 Days". `attach_sales_order` writes `so_voucher_no` from the ERP SO it reads. | `so_pdf.js`, `ErpSalesOrderUpload.tsx` | none | DF | none | Unit test on `buildSalesOrderData` |
| 18 | **fix(intake): exact GSTIN and vendor-code matches ignore the 0.85 run gate.** Name matches keep it. | `so-intake.tsx` | none | **ND** (decision 6) | 7 | `so-intake-name-match` style tests |
| 19 | **fix(orders): approval TTL in Mode B.** No 24 h expiry lock when no push follows. | `orders/[id].js` | none | **ND** (decision 11) | 4 | API test per mode |
| 20 | **Un-hold #238** (header defaults from the customer master, including the primary contact). | `orders/index.js`, Header tab | none | **ND** (owner held it) | 12 | Its own tests |

- **Decision-free and ready now:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17, and the read path of 10.
- **Suggested first wave:** 1 (baseline), 2, 4, 6, 8, 9.

---

## (e) Owner decisions

| # | Decision | Suggested default | Blocks |
|---|---|---|---|
| 1 | **Approval routing.** Who approves an order? | The threshold's `approver_role` when a threshold matches, else any `sales_manager`. Never the submitter (maker-checker). Use the customer account owner (migration 227) only for the CC. | PR 13 |
| 2 | **Is approval needed for a clean Mode B order?** | Optional auto-approve: zero open exceptions, value below a tenant threshold, off by default. The audit records "auto-approved, clean". | A later PR after 13 |
| 3 | **What "reject" means.** | A new `REJECTED` order status with a required reason. It also gives win/loss a loss state. The lighter option is CANCELLED with `reject_reason`. | PR 15 |
| 4 | **Who may accept a line price deviation, and up to what size?** | Engineer up to ±2% or ₹10,000 per line. Above that it goes to the manager, like a high terms flag. | PR 11 |
| 5 | **Notification channel.** | Email (Graph shared mailbox if connected, else the mailer) and a bell row. Show the bell to sales roles. | PR 14 |
| 6 | **Can exact GSTIN and vendor-code matches bypass the 0.85 run-confidence gate?** | Yes. Name matches keep the gate. | PR 18 |
| 7 | **The delivery date source of truth.** This is existing design decision 8. | Required-by = the PO date. Committed = ours, prefilled with its source. The SO PDF and the handoff print the committed date and list the PO date when they differ. | PR 10 prefill, PR 16 |
| 8 | **Handoff before or after approval** (existing design decision 10). | Before approval in Mode B, gated by blockers, as the design suggests. | PR 16 |
| 9 | **Turn on the #589 canary and the terms check** (`shadow` then `on`) for the first tenant. | Yes, after a golden-set check. The rest of this plan gets more valuable once the PO date and terms are read. | Value of PRs 10 and 16 |
| 10 | **Client click telemetry.** | Allow a minimal `ui_action` event (screen, control id, order id; no field values). Without it, clicks are estimated from server actions. | PR 1 (the full click metric) |
| 11 | **Approval TTL in Mode B.** | No expiry in Mode B. A line edit still clears the approval. | PR 19 |
| 12 | **Canned reasons for decisions.** | Allow reason chips (for example "Customer confirmed by phone", "Within tolerance") as the reason, with optional text. Today the terms check needs 10 or more typed characters. | PR 11, PR 15 |
| 13 | **Un-hold #238.** | Yes, rebased on PR 12. | PR 20 |

---

## (f) Metrics

### What already exists

| Source | What it holds | Usable for |
|---|---|---|
| `audit_events` (`recordAudit`) | `create_order`, `update_order` (full before and after rows, so status transitions can be derived), `approve_order`, `manager_requested_correction`, `order_finding_resolved`, `order_quote_attached`, `order_term_decided`, `approval_decision` | Status timeline, returns, decisions, actor per action |
| `processing_events` (`recordEvent`) | `order_created`, `order_updated`, `manager_approved`, `correction_requested`, `term_decided`, `item_customer_part_confirmed`, extraction events | Same timeline, keyed by `case_id` = order id |
| `extraction_runs` | Adapter, confidence, duration, anomalies, validator issues, prompt version | Extraction wait time, quality |
| Metric catalog (`_lib/metrics/catalog.js`) | `order_approval_time_median` (created to approved, **in days**), `orders_created`, five `extraction_*` metrics | Baseline for time to SO, though too coarse |
| Line `_field_sources` (`ocr` or `human`) and `docai/correction` rows | Which fields a person changed | Line-edit rate (rework on extraction) |
| Client | No click telemetry. `soPerf` writes only console logs. `lib/telemetry.ts` is shell status, not usage. | Nothing for clicks today |

**Gaps:**
- No submitter or approver column, so "per person" cuts need the audit actor.
- `approved_at` is overwritten on each approval.
- There is no click data.

### Proposed metrics (PR 1, before any UX change)

| Metric | Definition | Source | Today (to measure) | Target after the plan |
|---|---|---|---|---|
| **Time to SO** | P50 and P90 hours, from order created to first APPROVED | audit status transitions | Baseline in PR 1 | P50 down 50% |
| Engineer time to submit | Created to first PENDING_REVIEW | audit | Baseline | Under 10 min P50 for a clean PO |
| **Approval wait** | First PENDING_REVIEW to the first decision | audit | Baseline | Under 2 h P50 in working hours |
| **Re-work rate** | Share of orders with one or more returns; returns per order | `manager_requested_correction` | Baseline | Down 50% |
| Line-edit rate | Human-edited fields over all extracted fields | `_field_sources`, corrections | Baseline | Trend down, a proxy for extraction quality |
| Exceptions per order | Rows in the exceptions list at submit; share decided by the engineer vs the approver | PR 9 and PR 11 tables | n/a | Tracked |
| Clean-order rate | Share of orders with zero exceptions at submit | PR 9 | n/a | Tracked; feeds decision 2 |
| **Actions per order** | Count of state-changing user actions per order, by role | audit and processing events | Baseline (about 15 server actions on the happy path) | Down 50% |
| Clicks per order | UI actions per order, by role | client `ui_action` (decision 10) | Estimated about 30 | About 12 |
| Handoff lag | APPROVED (or submit) to handoff sent; handoff to ERP SO attached | PR 16 columns, `order_documents` | n/a | Same day |
| Customer auto-match rate | Share auto-matched, by basis | match basis saved in PR 7 | n/a | Above 90% for repeat buyers |
| Large-PO completion lag | Job enqueued to lines landed | `extraction_jobs` | Baseline | Under 10 min |

---

## Appendix: side defects found during the audit

These are outside the UX scope unless a PR above names them.

| # | Defect | Evidence | Handled by |
|---|---|---|---|
| S1 | The server accepts any `approval.payloadHash`; it does not compare it with the stored hash. | `orders/[id].js:185` | PR 3 |
| S2 | The `quote_approvals` decision POST needs only `write`, so an engineer can decide through the API. | `admin/quote_approvals.js:122` | PR 2 |
| S3 | `canDo` allows every unregistered action. `so.write` and `so.admin` are unregistered. | `lib/rbac.ts:205-210`; `so-workspace.tsx:650-651` | PR 5 |
| S4 | The SO PDF prints "30 Days" when the customer has no default, ignoring the PO. The voucher number is always blank. | `orders/so_pdf.js:106-108` | PR 17 |
| S5 | Inbound email orders with no customer cannot be assigned one anywhere. | `inbound/email/draft_orders.js:53-55`; `orders/[id].js:13-41` | PR 7 |
| S6 | A 24 h approval TTL locks Mode B orders against cancel or return. | `orders/[id].js:177-179`, `:199-200` | PR 19 |
| S7 | Intake shows static and hardcoded cards ("Profile match", "Estimated cost ₹ 2.40"). | `so-intake.tsx:1415-1439` | PR 6 |
| S8 | `/api/cron/tick` is not scheduled in the repo. Background extraction depends on an external ping. | `vercel.json` crons; `docs/CRONS.md`; #566 open | #566 or verify the external cron |
| S9 | The Kanban "Flagged" KPI is hardcoded to 0. | `pipeline-kanban.tsx:228` | Could read from PR 9 |
| S10 | The workspace and queue "return for fix" toasts both say "operator notified", but no notification is sent. | `so-workspace.tsx:758`; `approvals.tsx:263` | PR 14 |
