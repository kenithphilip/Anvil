# Role-Based Access Control

## Roles

Seven roles, each with a short code, label, scope, and an explicit purpose.

| Role | Code | Label | Scope |
| --- | --- | --- | --- |
| `sales_engineer` | ENG | Sales Engineer | Owns intake to draft to validation. Can edit own orders. Cannot approve. |
| `sales_manager` | MGR | Sales Manager | Approves orders within delegate cap, oversees team queues, edits any order in tenant. |
| `procurement` | PRC | Procurement | Owns source POs, supplier scorecards, lead times, items, BOM. Read-only on sales side. |
| `finance` | FIN | Finance | Approves above-cap orders, owns Tally / e-invoice / cost-margin. Read-only on intake. |
| `admin` | ADM | Admin | Full access to a tenant: members, settings, security, audit. |
| `operator` | OPS | Operator | Internal SO operator (warranty, FOC, transfers). Limited to internal flow. |
| `viewer` | VWR | Viewer | Read-only across the tenant. No mutations anywhere. |

The `obara_role` enum in migration 001 already encodes 6 of these
(`sales_engineer`, `sales_manager`, `procurement`, `finance`, `admin`,
`viewer`). Migration 010 will add `operator` if not present (idempotent).

The Vercel API enforces a parallel `requirePermission(ctx, "read" | "write"
| "approve" | "admin")` permission set, mapped from role at request time
inside `_lib/auth.js`. The v3 UI mirrors that mapping so it never offers an
action the API would refuse.

## Membership status (Phase 5)

In addition to `role`, `tenant_members` carries a `status` column
(migration 042) that determines whether a user can sign in at all:

| Status | Meaning | Sign-in | Visible to admins |
| --- | --- | --- | --- |
| `pending` | Self-service signup awaiting admin review | No, returns 403 `MEMBERSHIP_PENDING` | Admin Center → Access requests (default filter) |
| `approved` | Active member; role determines permissions | Yes | Admin Center → Members |
| `denied` | Admin rejected; the user sees the denial reason | No, returns 403 `MEMBERSHIP_DENIED` | Admin Center → Access requests, filter "denied" |
| `deactivated` | Was approved, then turned off (offboarded employee, compromised account) | No, returns 403 `MEMBERSHIP_DEACTIVATED` | Admin Center → Access requests, filter "deactivated" |

Status is checked twice on every request:
1. `password_login` and `passkey/auth/finish` refuse to mint a
   session for any non-approved member.
2. `_lib/auth.resolveContext` re-checks status on every
   authenticated API call so a session that survives the sign-in
   gate (or pre-dates a status flip) is still refused.

The first user on a fresh tenant always lands `status='approved'`
with role `admin`; otherwise the loop could never start.

## Permission verbs

- `read`. View the route, its tables, its detail panels.
- `write`. Create, edit, delete rows on the route.
- `approve`. Click the "approve" / "decide" / "release" buttons on items
  that require approval (orders, source POs, contracts).
- `admin`. Tenant-level configuration: members, RBAC, security, audit
  retention, integrations.

## Route matrix

`R` = read, `W` = write, `A` = approve, `X` = admin-only, `.` = no access.
A nav id is hidden in the sidebar entirely if the role has `.` for it.

| Route | ENG | MGR | PRC | FIN | ADM | OPS | VWR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| home | R | R | R | R | R | R | R |
| intake | RW | RW | R | R | R | R | R |
| so | RW | RW | R | R | R | R | R |
| internal | R | RW | R | R | RW | RW | R |
| approvals | R | RWA | . | RWA | RWA | . | R |
| leads | RW | RW | . | R | R | . | R |
| opps | RW | RW | . | R | R | . | R |
| projects | RW | RW | R | R | R | . | R |
| shipments | RW | RW | RW | R | R | R | R |
| spo | R | R | RWA | R | R | . | R |
| spares | RW | R | RW | R | R | . | R |
| svc-visits | R | R | . | . | R | RW | R |
| amc | R | R | . | . | RW | RW | R |
| car | R | R | . | . | RW | RW | R |
| tally | R | R | R | RWA | RW | . | R |
| einvoice | R | R | . | RW | RW | . | R |
| cost | R | RW | R | RW | RW | . | R |
| customers | RW | RW | R | R | RW | R | R |
| items | R | R | RW | R | RW | R | R |
| graph | R | R | R | R | R | . | R |
| forecasts | R | R | R | RW | RW | . | R |
| evals | R | R | . | . | RW | . | R |
| studio | R | RW | . | . | RW | . | R |
| anomaly | R | R | R | R | RW | . | R |
| duplicates | R | R | R | R | RW | . | R |
| comms | RW | RW | R | R | RW | . | R |
| email | R | RW | R | R | RW | . | R |
| security | . | . | . | . | X | . | . |
| audit | R | R | R | R | RW | . | R |
| admin | . | . | . | . | X | . | . |

**Reading the matrix.**
- ENG can intake POs, draft SOs, and edit them but cannot approve them.
- MGR can approve up to delegate cap (typically 25%); above cap routes to
  FIN.
- FIN owns Tally + e-invoice + cost workflows; doesn't see intake details.
- PRC sees source POs, items, BOM, supplier scorecards. They get sales
  read-only because they need to know what to source against.
- OPS lives in the internal SO + service flows; restricted from the sales
  trunk.
- ADM can do everything except for `viewer`-only readings; admin + security
  routes are admin-only by design.
- VWR can read everything that isn't explicitly admin-only.

## Action-level permissions (within a route)

Some routes have route-level access but action-level restrictions. These
override the route matrix:

| Surface | Action | Allowed roles |
| --- | --- | --- |
| Copilot | Propose a write action (create_lead / draft_and_send_comms) | any role with `read` (chat); MCP needs the `write.*` token scope |
| Copilot | Confirm + execute a proposed action | any role with `approve` (POST `/api/copilot/confirm`) |
| Copilot | View pending proposals | any role with `read` (GET `/api/copilot/proposals`) |
| SOWorkspace | Push to Tally | MGR, FIN, ADM |
| SOWorkspace | Approve | MGR if margin ≥ delegate cap, FIN if below cap, ADM always |
| SOWorkspace | Cancel order | MGR, ADM |
| SOWorkspace | Edit after approval | ADM only (and clears approval) |
| Customers | Edit GSTIN / state | MGR, ADM |
| Customers | Add / edit format profile | ENG, MGR, ADM (everyone who handles intake) |
| Items | Mark obsolete | PRC, ADM |
| SourcePOs | Record acknowledgement | PRC |
| SourcePOs | Mark received | PRC |
| Tally | Push voucher | FIN, ADM |
| Tally | Edit master mappings | FIN, ADM |
| EInvoice | Generate IRN | FIN |
| EInvoice | Cancel within 24h window | FIN, ADM |
| AMC | Generate visits manually | OPS, ADM |
| Service visits | Submit closure report | OPS |
| Admin | Add / remove member | ADM |
| Admin | Change member role | ADM |
| Admin | View ERP connector field map / run diagnostics | any role with `read` (GET `/api/<erp>/field_map`, `/api/<erp>/diagnostics`) |
| Admin | Edit ERP connector field map | ADM (PUT `/api/<erp>/field_map`) |
| Admin | Run connector config/schema drift check | ADM (GET `/api/<erp>/diagnostics?drift=1`) |
| Items | Import a BOM (asset + lines) | any role with `write` (POST `/api/bom/import`); creates item_master rows + bill_of_materials edges |
| Items | Link a BOM asset to a project | any role with `write` (POST/DELETE `/api/bom/asset_projects`) |
| Items | View BOM assets / lines / history | any role with `read` (GET `/api/bom/assets`) |
| Items | Preview-parse a BOM file / view source formats | any role with `read` (POST `/api/bom/parse`, GET `/api/bom/source_formats`) |
| Items | Add / edit a BOM source format | ADM (PUT/DELETE `/api/bom/source_formats`) |
| Items | Approve a BOM revision | reserved for `approve` (future; no endpoint in v1) |
| Security | Edit redaction rule | ADM |
| Security | Run injection test | ADM |

## Implementation

### Server-side enforcement (already in place)

Every endpoint calls `requirePermission(ctx, verb)` from `_lib/auth.js` at
the top. The verb is `read` for GETs and `write`/`approve`/`admin` for
mutations. A v3 UI that incorrectly offers an action triggers a 403 from
the server and is logged in `audit_events` with `forbidden=true`.

### Client-side gating

The v3 shell exports two helpers:

```js
window.RBAC = {
  // is the current role allowed to view a route?
  canRead: (navId) => boolean,
  // is the current role allowed to mutate on a route?
  canWrite: (navId) => boolean,
  // is the current role allowed to approve on a route?
  canApprove: (navId) => boolean,
  // is the current role admin?
  isAdmin: () => boolean,
  // for action-level checks
  canDo: (action) => boolean,
};
```

The Shell hides nav items when `canRead(navId) === false`. The Btn
component accepts an optional `permission` prop:

```jsx
<Btn permission="approve" onClick={...}>Approve</Btn>
```

If `RBAC.canApprove(currentRouteId) === false` the button renders disabled
with a tooltip explaining the missing permission.

### Role switching

In dev / preview environments the role pill in the header lets the operator
swap roles for testing. In production the role is read from
`tenant_members.role` and not switchable. The pill becomes a status display
only.

### Audit trail

Every successful action carries the role into the `audit_events.detail`
jsonb field as `{ role: "sales_manager", verb: "approve" }`. This lets us
later compute "who approved what under which role" without joining
`tenant_members` at history time.

## Edge cases

1. **Multi-role users.** A user can hold one role per tenant via
   `tenant_members.role`. To act as a different role they switch tenants.
2. **Delegate cap exceeded.** The MGR approval is recorded with
   `delegate_exceeded=true` and the order is routed to FIN automatically.
3. **VWR with shared dashboards.** Viewer can subscribe to any saved filter
   produced by another role; they cannot create a new one.
4. **Operator boundary.** OPS cannot see external-customer orders (mode !=
   INTERNAL). Enforced both client-side (filter) and server-side (RLS via
   internal_sales_orders join).

## Future

See `docs/ROADMAP.md` for the policy-as-data evolution: replace the
hardcoded matrix with a YAML or DB-backed policy that admins can tune at
runtime.
