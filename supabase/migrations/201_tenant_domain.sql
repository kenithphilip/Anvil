-- 201_tenant_domain.sql
--
-- Phase 0 of per-tenant domain mapping. Adds an optional host that resolves to
-- a tenant — either a full custom vanity host (e.g. spares.obara.com) or a full
-- subdomain host. The existing `tenants.slug` (unique) already covers the
-- <slug>.<app-domain> subdomain case (obara.anvil.app -> slug 'obara'); this
-- column is for explicit / custom host mapping.
--
-- Nullable + case-insensitively unique. Ships DARK: src/api/_lib/auth.js
-- resolveContext only consults it as a fallback when no x-anvil-tenant header
-- is sent AND the resolved tenant is one the caller already belongs to, so
-- behaviour is unchanged until a domain is populated and DNS points at it.
--
-- Applied manually like the other migrations. Idempotent.

alter table tenants add column if not exists domain text;

-- Case-insensitive uniqueness over non-null domains (partial index).
create unique index if not exists tenants_domain_lower_key
  on tenants (lower(domain))
  where domain is not null;

comment on column tenants.domain is
  'Optional host (e.g. spares.obara.com, or a full subdomain host) that maps to this tenant. Consumed by src/api/_lib/auth.js resolveHostTenant. Subdomain-of-app-domain mapping uses tenants.slug instead.';
