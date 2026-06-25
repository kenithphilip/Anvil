# Operator Actions - Design

Status: **proposed** (design-first; schema to be locked in review before code).
Owner: Joel. Next free migration number at time of writing: **150**.
Feature flag (off by default): `operator_actions_enabled` on tenant_settings.

This document specifies a governed "operator action" path: a way to bring
the API-less last 30-40% of workflows (thick clients, VDI sessions, admin
consoles, portals with no reliable endpoint) onto the **same approval +
audit rails** as everything else in Anvil. v1 is fully human-in-the-loop
and needs no external computer-use dependency; the schema + interface are
designed so an automated computer-use (CUA) driver can later sit behind
the same contract without changing it.

---

## 1. Motivation

Anvil is entirely API/connector-based, so it structurally cannot touch
workflows with no endpoint: keying a value into a thick-client ERP screen,
downloading a report from a portal, approving something in an admin
console over VDI. Today those steps fall outside the system: no record,
no audit, no reconcile. Operators do them by hand and Anvil never learns
they happened.

The "operator action" is a first-class, auditable record of such a step:
an ordered checklist, captured evidence (screenshot / exported file /
diff), and a reconcile-back into Anvil's system of record - so even a
manual, off-system step is governed and visible.

---

## 2. Design overview

```
 create (proposed)
   -> start    (in_progress)        operator works the steps off-system
   -> attach   (evidence_captured)  screenshots / exported files via documents+OCR
   -> reconcile(reconciled)         write the outcome back to Anvil's record
   -> (or) abandon (abandoned)
```

- An **operator_action** is a typed, ordered checklist bound to an
  optional Anvil object (order / source PO / invoice / etc.).
- Each **operator_action_step** is one instruction with a done flag +
  per-step notes; advancing a step writes an audit row.
- **operator_action_evidence** links captured artifacts (reusing the
  existing `documents` + `documents/ocr` path) to the action / a step.
- **Reconcile** is the governed write-back. When it mutates an Anvil
  system of record it goes through the same approval gating as a normal
  write (requireApprovedOrder-style); it always writes an audit row.

Repo invariants apply: tenant_id first non-id column, RLS + standard
policies, `resolveContext` + `requirePermission` on every route,
`recordAudit` per transition, idempotent numbered migrations, no em/en
dashes, additive only.

---

## 3. State machine

States: `proposed -> in_progress -> evidence_captured -> reconciled`,
with `abandoned` reachable from any non-terminal state. Terminal:
`reconciled`, `abandoned`.

| From | Event | To | Gate |
| --- | --- | --- | --- |
| (none) | create | proposed | write |
| proposed | start | in_progress | write |
| in_progress | attach_evidence | evidence_captured | write |
| in_progress / evidence_captured | advance_step / update | (same) | write |
| evidence_captured | reconcile | reconciled | approve (if it mutates a record) |
| any non-terminal | abandon | abandoned | write |

`evidence_captured` is not forced to require evidence rows unless the
action's `requires_evidence` flag is set (some actions are checklist-only).
Reconcile from `in_progress` is allowed when `requires_evidence=false`.

The transition function is pure and unit-testable: `nextState(current,
event, { requiresEvidence, hasEvidence })` returns the new state or an
error - so the rules are tested without a DB.

---

## 4. Schema (migration 150)

All tables: tenant_id first, FK to tenants on delete cascade, RLS +
standard select/write policies, created_at/updated_at.

### 4.1 operator_actions
| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `action_type` | text | neutral label, e.g. `erp_screen_entry` \| `portal_download` \| `console_approval` (tenant-defined) |
| `title` | text not null | |
| `target_system` | text | the API-less system, e.g. "Legacy SAP GUI", "GST portal" |
| `object_type` | text | optional Anvil object this relates to: `order` \| `source_po` \| `invoice` \| ... |
| `object_id` | uuid | the related Anvil row (no cross-table FK; validated in code) |
| `status` | text default `'proposed'` | check in (proposed, in_progress, evidence_captured, reconciled, abandoned) |
| `requires_evidence` | boolean default true | |
| `reconcile_contract` | jsonb default `{}` | what reconcile will write back (see 6); inert until reconcile |
| `reconcile_result` | jsonb | set on reconcile |
| `created_by` / `started_by` / `reconciled_by` | uuid -> auth.users | provenance (ctx.user.id) |
| `started_at` / `reconciled_at` | timestamptz | |
| `driver` | text default `'human'` | `human` now; `cua` later (the driver seam, 7) |

### 4.2 operator_action_steps
| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `operator_action_id` | uuid -> operator_actions on delete cascade | |
| `seq` | int not null | order; `unique (tenant_id, operator_action_id, seq)` |
| `instruction` | text not null | what the operator does |
| `expected` | text | what "done" looks like |
| `status` | text default `'pending'` | check in (pending, done, skipped) |
| `notes` | text | |
| `done_by` | uuid -> auth.users | |
| `done_at` | timestamptz | |

### 4.3 operator_action_evidence
| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `operator_action_id` | uuid -> operator_actions on delete cascade | |
| `step_id` | uuid -> operator_action_steps on delete set null | optional |
| `document_id` | uuid -> documents on delete set null | the uploaded artifact (reuses documents bucket) |
| `kind` | text | `screenshot` \| `export` \| `diff` \| `note` |
| `ocr_text` | text | optional, from documents/ocr |
| `captured_by` | uuid -> auth.users | |
| `created_at` | timestamptz | |

> Why a new evidence table rather than the existing `evidence`: that one
> is hard-bound to `order_id not null` and to extraction bbox/field
> semantics. Operator-action evidence is action-bound and artifact-bound,
> so a small dedicated table is cleaner than overloading the extraction
> evidence model. It still points at `documents` for the bytes + OCR.

---

## 5. API surface (route group `operator_actions`)

- `POST /api/operator_actions` (write) - create an action + its steps
  (`{ action_type, title, target_system?, object_type?, object_id?,
  requires_evidence?, reconcile_contract?, steps: [{instruction,
  expected?}] }`). Status `proposed`.
- `GET /api/operator_actions[?status=&object_id=]` (read) - list.
- `GET /api/operator_actions?id=` (read) - one action + steps + evidence.
- `POST /api/operator_actions/advance` (write) - transition / update a
  step: `{ id, event: start|advance_step|attach_evidence|abandon,
  step_id?, step_status?, notes? }`. Drives the state machine; audits.
- `POST /api/operator_actions/evidence` (write) - attach an evidence row
  (`{ id, step_id?, document_id, kind, run_ocr? }`); reuses
  documents/upload (client uploads, passes document_id) + documents/ocr.
- `POST /api/operator_actions/reconcile` (approve) - execute the
  reconcile contract (6); writes back to the Anvil record under the same
  approval gating as a normal write; sets status reconciled; audits.

Parsing/upload of artifacts stays on the existing documents endpoints;
operator_actions only stores the link + the reconcile outcome.

---

## 6. Reconcile contract

`reconcile_contract` (jsonb on the action) declares, declaratively, what
the reconcile step writes back. v1 supports a small, safe set:

- `{ type: "note", target: {object_type, object_id}, text }` - append an
  audited note / event to the related object. No approval needed (it
  records that an off-system step happened; it does not mutate the SOR).
- `{ type: "status", target: {object_type:"order", object_id}, set:
  {field, value}, payload_hash }` - set a status/field on a system of
  record. **Requires `approve`** and passes the same payload-hash /
  approval guard a normal write would (reusing the requireApprovedOrder
  philosophy); rejected if not approved.

Anything not in the supported set is rejected. The contract is data, so
new safe reconcile types are added deliberately, never free-form writes.

---

## 7. The CUA driver seam (future, stubbed only)

`operator_actions.driver` is `human` in v1. The execution boundary is a
single typed interface the human path implements now and a computer-use
driver can implement later WITHOUT changing the contract:

```
runStep(action, step, ctx) -> { ok, evidence?: {document_id, kind, ocr_text?}, notes? }
```

- v1: there is no automated runner. The operator performs the step in the
  real system and the UI/endpoints record done + evidence. The seam is
  defined and documented; the only "driver" is the human path.
- Later: a CUA driver implements `runStep` (drive the thick client,
  screenshot as evidence) and sets `driver='cua'`. Reconcile + approval +
  audit are unchanged. No fake automation is claimed in v1.

---

## 8. RBAC

- View: `read`. Create / start / advance / attach evidence / abandon:
  `write`. Reconcile that mutates a system of record: `approve`
  (note-only reconcile may stay `write`). New routes are auto-covered by
  audit-rbac via their `requirePermission` calls; documented in RBAC.md.

---

## 9. Feature flag + backward compatibility

- Flag-gated: `tenant_settings.operator_actions_enabled` (default false).
  Endpoints return `409 FEATURE_DISABLED` when off. Flipping it on does
  not affect any existing flow.
- Additive only: new tables + new routes + one nullable settings column.
  No existing endpoint, response shape, or migration changes.

---

## 10. Phasing

1. **Schema + API + state machine** (migration 150; route group;
   pure `nextState` + reconcile-dispatch with tests). No UI.
2. **v3 UI**: a checklist runner (work the steps, attach evidence via the
   existing document upload, reconcile) + a list/detail surface.
3. **CUA driver** (separate, later): implement `runStep` behind the seam;
   no contract change.

Each phase is independently shippable and gate-clean.

---

## 11. Acceptance criteria (v1 = phase 1)

- [ ] An operator action can be created with ordered steps, started,
      advanced step-by-step, have evidence attached (linked to a
      `documents` row, optional OCR), and reconciled - with an audit row
      per transition.
- [ ] Reconcile that mutates a system of record passes the same approval
      gating as a normal write; a note-only reconcile records an audited
      event without mutating the SOR.
- [ ] The driver interface is defined + stubbed at the boundary only; the
      human path fully works; no automation is claimed.
- [ ] Flag-gated off by default; on/off does not disturb existing flows.
- [ ] `nextState` rejects illegal transitions (unit-tested); reconcile
      rejects unsupported contract types.
- [ ] All repo gates green; new tables RLS-covered; new routes in the
      RBAC matrix + audit.

---

## 12. Out of scope (v1)

- Shipping an actual computer-use / browser driver or any third-party CUA
  integration.
- Automating specific ERPs / portals.
- Reconcile types beyond `note` + guarded `status`.

---

## 13. Open questions for review

1. Reconcile targets in v1: just `order` (status/note), or also
   `source_po` / `invoice`? (Proposed: `order` + generic note for any
   object_type.)
2. Flag granularity: a single tenant flag (proposed) vs per-action-type
   enablement.
3. Evidence: require at least one evidence row before reconcile when
   `requires_evidence=true` (proposed yes), or always optional?
4. Should an operator action be linkable to a copilot proposal (PR2) so
   the copilot can *propose* an operator action that a human then runs?
   (Natural future tie-in; out of scope for v1.)
5. Do we reuse `recordEvent` (case timeline) for the per-object reconcile
   note so it shows in the order/SO timeline? (Proposed yes.)
