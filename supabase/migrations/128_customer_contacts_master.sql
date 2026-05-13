-- 128_customer_contacts_master.sql
--
-- Wave CM 1.3: contact master clean split + tightening.
--
-- customer_contacts (migration 065) was a good start: one row
-- per buyer-side contact, FK to customers, RLS-scoped, ERP
-- external_ref. We add five fields to make it a true Contact
-- master that the dedupe + inbound-email linkage can lean on:
--
--   canonical_email_hash  sha256 of the canonicalised email
--                         (lowercased, trimmed, dot-segment-
--                         folded for gmail-style aliases). Lets
--                         the inbound matcher answer "is
--                         buyer@acme.com the same contact as
--                         BUYER@ACME.COM?" with one index probe.
--   preferred_locale      Operator-confirmed locale (en-IN, ko-KR,
--                         de-DE, ja-JP). Drives the multi-language
--                         translation hint (Wave 2.4 docai).
--   signature_block       Operator-confirmed canonical email
--                         signature (the literal text below
--                         their reply line). Used by the
--                         inbound matcher to disambiguate
--                         when two contacts share an email.
--   confidence            0..1, how confident the matcher is
--                         that this row maps to a real human.
--                         Auto-imported contacts start at 0.5
--                         and rise on operator confirmation.
--   is_active             False on contacts the operator has
--                         marked "no longer at customer".
--                         The matcher excludes inactive rows
--                         from auto-link suggestions.
--
-- Plus FK-tightening: every contact must point at a customer.
-- Today the schema already requires that via NOT NULL but the
-- ON DELETE CASCADE pre-existing rule is preserved.
--
-- Idempotent.

alter table customer_contacts
  add column if not exists canonical_email_hash text,
  add column if not exists preferred_locale     text,
  add column if not exists signature_block      text,
  add column if not exists confidence           numeric(5,4),
  add column if not exists is_active            boolean not null default true;

comment on column customer_contacts.canonical_email_hash is
  'CM 1.3: sha256 of canonicalised email (lowercase, trim, gmail dot-fold).';
comment on column customer_contacts.preferred_locale is
  'CM 1.3: operator-confirmed locale (e.g. en-IN, ko-KR). Drives translation hints.';
comment on column customer_contacts.signature_block is
  'CM 1.3: canonical signature text the inbound matcher uses to disambiguate.';
comment on column customer_contacts.confidence is
  'CM 1.3: 0..1; auto-imported contacts start at 0.5, operator-confirmed at 1.0.';
comment on column customer_contacts.is_active is
  'CM 1.3: false when operator marks the contact as no longer at the customer.';

-- Sanity bound on confidence.
do $$ begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_name = 'customer_contacts'
      and constraint_name = 'customer_contacts_confidence_chk'
  ) then
    alter table customer_contacts drop constraint customer_contacts_confidence_chk;
  end if;
end $$;
alter table customer_contacts
  add constraint customer_contacts_confidence_chk
  check (confidence is null or (confidence >= 0 and confidence <= 1));

-- Backfill canonical_email_hash for existing rows using a
-- deterministic canonicaliser. Implementing the canonicaliser
-- inline so the migration is self-contained: lowercase, trim,
-- strip + after gmail '+tag' suffix, fold dots in gmail local-
-- parts. Other domains keep dots and casing on the local part.
create or replace function _canonicalise_email(raw text) returns text
language plpgsql immutable as $$
declare
  e text;
  local_part text;
  domain text;
  at_pos int;
begin
  if raw is null or btrim(raw) = '' then return null; end if;
  e := lower(btrim(raw));
  at_pos := position('@' in e);
  if at_pos = 0 then return e; end if;
  local_part := substring(e from 1 for at_pos - 1);
  domain := substring(e from at_pos + 1);
  -- Strip +tag suffix on every provider; most providers honour it.
  if position('+' in local_part) > 0 then
    local_part := substring(local_part from 1 for position('+' in local_part) - 1);
  end if;
  -- Gmail / Google Workspace fold the dots in the local part.
  if domain in ('gmail.com', 'googlemail.com') then
    local_part := replace(local_part, '.', '');
  end if;
  return local_part || '@' || domain;
end;
$$;

create or replace function _email_hash(raw text) returns text
language plpgsql immutable as $$
declare
  canon text;
begin
  canon := _canonicalise_email(raw);
  if canon is null then return null; end if;
  return encode(digest(canon::bytea, 'sha256'), 'hex');
end;
$$;

-- pgcrypto's digest() is required. Most projects already enable
-- the extension; idempotent ensure here.
create extension if not exists pgcrypto;

update customer_contacts
   set canonical_email_hash = _email_hash(email)
 where email is not null and canonical_email_hash is null;

-- Lookup by hash so the inbound matcher can find a contact by
-- the SAME canonical email even when the inbound message used
-- different casing or a +tag alias.
create index if not exists customer_contacts_canonical_hash_idx
  on customer_contacts (tenant_id, canonical_email_hash)
  where canonical_email_hash is not null and is_active = true;

-- Trigger maintains canonical_email_hash on insert / update.
create or replace function _customer_contacts_canonicalise() returns trigger
language plpgsql as $$
begin
  if NEW.email is not null then
    NEW.canonical_email_hash := _email_hash(NEW.email);
  else
    NEW.canonical_email_hash := null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists customer_contacts_canonicalise_trg on customer_contacts;
create trigger customer_contacts_canonicalise_trg
  before insert or update of email on customer_contacts
  for each row execute function _customer_contacts_canonicalise();

-- Active-contacts-only index for the matcher's "warm" lookup.
create index if not exists customer_contacts_active_idx
  on customer_contacts (tenant_id, customer_id)
  where is_active = true;
