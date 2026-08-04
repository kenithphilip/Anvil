# Customer Portal Authentication — Design

Status: **draft for review** · Owner: (tbd) · Prerequisite for: onboarding auto-OEM
customers to the customer portal (spare-matrix / drawing / quote / invoice sharing).

## 1. Problem

The customer portal today is a **shared bearer token placed in the URL**
(`/api/portal/view?token=…`). All five customer-facing endpoints
(`view`, `pay`, `reorder`, `accept_quote`, `invoice_pdf`) authenticate the same
way: `validateToken(token)` against `portal_tokens` (migration 022), scope-gated.
There are **no customer users, no login, no MFA, no per-user identity**, and the
token can live forever (`expires_at` is nullable). Audit is per-token
(`portal_access_log`), not per-user.

This is fine for a low-friction share link, but it is **not compatible with
strict automotive-OEM compliance** (TISAX / VDA-ISA / ISO 27001). What we would
be sharing — spare matrices and **EG / 2D / 3D CAD drawings — is the OEM's own
IP**, which their security teams guard hardest. A token-in-URL link leaks through
server logs, browser history, referrer headers and proxies, and fails supplier
security assessments.

## 2. What we already have (reuse, don't rebuild)

Internal (Anvil-staff) auth is a mature stack we can extend to customers:

- **Supabase Auth** (JWT). `resolveContext(req)` reads a Bearer JWT →
  `supa.auth.getUser()` → looks up `tenant_members` for tenant + role
  (`src/api/_lib/auth.js`).
- **Password login** proxied server-side (`src/api/auth/password_login.js`) —
  keeps the anon key off the client, single audit point.
- **MFA / TOTP** (`src/api/auth/mfa.js`, `src/api/_lib/totp.js`) — enroll /
  verify / unenroll, `totp_enrolled` + `require_mfa` per user.
- **RBAC + portal `scopes`** — the *authorization* model (what a customer may
  see/do) already exists on `portal_tokens.scopes`; the gap is *authentication +
  identity*, not authorization.
- **Audit infra** (`audit_events`, `portal_access_log`).

**Design principle: authenticate customer users with the same Supabase Auth
stack, strictly segregated from internal users.** Customer identities live in a
new `portal_users` table (NOT `tenant_members`), scoped to a single `customer_id`
by RLS, and are never granted an internal role.

## 3. Identity model

```
portal_users
  id              uuid pk
  tenant_id       uuid  -> tenants
  customer_id     uuid  -> customers        (the OEM this user belongs to)
  auth_user_id    uuid                       (Supabase auth.users id; null until first login for SSO JIT)
  email           text
  display_name    text
  role            text  check (portal_admin | portal_member)   -- portal-side role
  status          text  check (invited | active | suspended)
  require_mfa      boolean default true       -- default ON for OEM customers
  invited_by       uuid                        -- internal actor
  last_login_at    timestamptz
  created_at / updated_at
  unique (tenant_id, customer_id, lower(email))
```

- `resolveCustomerContext(req)` — mirrors `resolveContext` but for the portal:
  Bearer JWT → `supa.auth.getUser()` → `portal_users` lookup by `auth_user_id`
  (active, not suspended) → `{ portalUserId, customerId, tenantId, role, scopes }`.
  A JWT that resolves to a `tenant_members` (internal) user is **rejected** on the
  portal, and vice-versa — the two identity planes never cross.
- RLS: `portal_users` and every portal read are scoped to
  `customer_id = <the caller's customer>`; a portal user can never see another
  customer's data even by guessing ids.

## 4. Phased plan

Each phase is one or more independently-shippable PRs. Existing token links keep
working throughout (dual-auth) and are sunset at the end.

### Phase 1 — Customer identity + invite (foundation)
- Migration: `portal_users` (+ RLS) and a `portal_user_id` column on
  `portal_access_log` (per-user audit; nullable for legacy token hits).
- Invite flow: internal admin / `customer_support` invites a customer user by
  email → creates a Supabase Auth user (invite) + a `portal_users` row
  (`status=invited`) bound to `customer_id`. Reuses the internal invite pattern.
- Admin/support UI: list / invite / suspend customer users per customer.
- **No behaviour change to existing token links yet.**

### Phase 2 — Authentication: per-user login + session (token OUT of the URL)
- `resolveCustomerContext(req)` (Bearer JWT session).
- Customer login endpoint (email + password via Supabase, mirroring
  `password_login.js`) → returns a session the browser stores as an **httpOnly,
  Secure, SameSite=strict cookie** — never in the URL.
- Migrate the five portal endpoints to accept **either** the session (new,
  preferred) **or** the legacy URL token (deprecated, behind a per-tenant sunset
  flag). Scopes derive from `portal_users.role`.
- Session lifecycle: expiry, refresh, explicit logout + server-side revocation.

### Phase 3 — MFA enforcement for customer users
- Reuse `/api/auth/mfa` + `_lib/totp.js` on the `portal_users` identity: enroll /
  challenge / verify.
- Policy: `require_mfa` per customer user (default **on**); block portal access
  until enrolled when required.

### Phase 4 — SSO / SAML / OIDC federation (the auto-OEM requirement)
- Most auto OEMs mandate **federated SSO** so *their* IT owns identity, MFA and
  deprovisioning. Per-customer IdP config:
  ```
  portal_sso_configs (customer_id, protocol[saml|oidc], entity_id/metadata_url,
                      cert, attribute_mapping, jit_provisioning bool, active)
  ```
- SAML/OIDC login flow; **JIT-provision** a `portal_users` row on first SSO login
  (mapped to `customer_id`); honour the IdP's deprovisioning.
- Implementation options (decision below): Supabase native SSO (SAML, paid tier)
  · an identity gateway (WorkOS / Auth0 / Cognito) · custom SAML/OIDC handler.

### Phase 5 — Compliance hardening + CAD-IP controls
- **Per-user audit:** `portal_access_log.portal_user_id` + action detail (what
  was viewed / downloaded); immutable + exportable for assessments.
- **CAD-IP controls:** log every drawing download; **short-lived signed URLs**
  for drawing files (no permanent links); optional per-user watermarking
  (email + timestamp) on shared drawings; per-customer view-only vs download
  policy.
- **Session hardening:** idle + absolute timeouts; concurrent-session limits;
  re-auth for sensitive actions.
- **Data residency / crypto:** confirm the Supabase region required by the OEM
  (EU / India); document encryption at rest + in transit; DPA template.
- **Access reviews:** per-customer user list + periodic review + deprovision on
  OEM offboarding.
- **Control mapping appendix:** TISAX / VDA-ISA / ISO 27001 → where each control
  is satisfied.

### Sunset
- Once a customer is on authenticated access, disable their legacy `portal_tokens`
  (revoke), and eventually remove URL-token auth from the five endpoints.

## 5. Key decisions (need product/CISO input)

1. **Identity store** — Supabase Auth for customer users (reuse password + MFA)
   vs a dedicated portal auth store. *Recommendation:* Supabase Auth, strictly
   segregated via `portal_users` + RLS (no `tenant_members` crossover).
2. **SSO at launch or fast-follow** — is SAML/OIDC federation required for the
   **first** auto-OEM, or is per-user password + MFA acceptable initially with
   SSO as a fast-follow? (Most OEMs mandate SSO → likely **required pre-launch**;
   this decides whether Phase 4 is before or just after go-live.)
3. **SSO implementation** — Supabase native SSO vs an identity gateway (WorkOS /
   Auth0) vs custom. Trade-off: time/cost vs control. A gateway is usually the
   fastest route to a multi-OEM SAML story.
4. **Customer-facing frontend** — there is **no `v3-app` portal screen** today
   (the portal is API/JSON, rendered by an external consumer). The login / MFA /
   session UI has to live somewhere: a new set of public routes in this repo, a
   separate customer app, or the existing external consumer. **This is a large,
   separate scope item** and gates Phases 2–4's UX.
5. **Data residency** — which region must customer data live in (EU / India)?
   Affects the Supabase project + any hosting.

## 6. Recommended sequencing

- **Pre-launch for a strict auto-OEM:** Phases 1–3 (identity + per-user login/
  session + MFA) **and** Phase 5's per-user audit + drawing-download controls +
  data-residency confirmation. **Phase 4 (SSO) if the specific OEM mandates it**
  — assume yes until told otherwise.
- The existing token link stays for **internal validation and low-strictness
  pilots** during the transition, then is sunset per customer.
- Decisions #2 and #4 most affect the timeline; resolve them first.

## 7. Out of scope (here)

The internal-staff SSO story (federating Anvil *employees* to an IdP) is related
but separate; this document covers only *customer* portal authentication.
