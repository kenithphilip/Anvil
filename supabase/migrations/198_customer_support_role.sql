-- 198_customer_support_role.sql — add the customer_support member role.
--
-- The support team views spare matrices + customer / quote / order data and can
-- share a spare matrix to the customer portal (see /api/spare_matrix/<id>/share).
-- It is read-only across the app (inherits `viewer` in rbac.ts) but is a
-- server-side writer so it can create portal share links.
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent (PG12+); the new value is
-- not referenced elsewhere in this migration. Applied manually.
alter type anvil_role add value if not exists 'customer_support';
