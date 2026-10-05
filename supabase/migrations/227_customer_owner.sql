-- 227_customer_owner.sql
--
-- The account owner: the member of the seller's team who owns a customer.
--
-- WHY. Accounts have no owner today, so a rep's pipeline, a chase list and a
-- follow-up cadence have nobody to route to. The column name is the one the
-- code already reads: agents/_handlers/credit_review_request.js selected
-- customers.owner_user_id before it existed, so that select failed on every
-- run and the credit-review agent never reached a recipient.
--
-- SHAPE. Same foreign key as opportunities.owner_id (migration 006): a user,
-- nullable, and set to null when the auth user is deleted, so removing a
-- person never removes or blocks a customer.
--
-- NO BACKFILL, on purpose. An owner nobody chose is not known, and a guessed
-- owner would read exactly like a chosen one. Every existing customer starts
-- null and shows as "Unassigned". The app computes a SUGGESTION at read time
-- (GET /api/customers/owner?suggest=1: the member who owns a strict majority of
-- the account's opportunities and authored quotes over 365 days) and saves it
-- only when a person clicks.
--
-- WRITES. Only POST /api/customers/owner writes this column (sales_manager and
-- admin, action customer.assign_owner). The POST /api/customers upsert never
-- writes it, so saving an unrelated customer field cannot clear an owner.
--
-- Additive and idempotent.

alter table customers
  add column if not exists owner_user_id uuid null references auth.users(id) on delete set null;

-- The Mine and Unassigned filters on the Customers screen. Partial: an
-- unowned customer is found by "owner_user_id is null", which this index does
-- not need to serve, and leaving nulls out keeps it the size of the owned set.
create index if not exists customers_owner_idx
  on customers (tenant_id, owner_user_id)
  where owner_user_id is not null;

comment on column customers.owner_user_id is
  'Account owner (a tenant member). Written only by POST /api/customers/owner. NULL means Unassigned; never backfilled by guess.';
