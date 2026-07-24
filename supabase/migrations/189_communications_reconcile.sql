-- Reconcile `communications` with the twelve writers that actually use it.
--
-- The table was defined once (005_close_remaining_gaps.sql:22-43) and never
-- altered, but twelve call sites grew six mutually-incompatible schemas around
-- it. Only three conform. The rest insert columns that do not exist and
-- statuses the CHECK rejects, so:
--
--   * POST /api/quotes/send and /api/invoices/send THROW on every call
--     (quotes/send.js:443, invoices/send.js:147 — four phantom columns, an
--     invalid status, and the NOT NULL `direction` omitted). Customer-facing
--     quote and invoice email is broken end to end today.
--   * GET /api/communications 400s on every call (list.js:32 selects
--     `updated_at`, which does not exist), so the comms timeline is always
--     empty.
--   * Several writers swallow the error (supplier_rfq/send.js:93,
--     inventory/notifications.js:112), so their messages vanish silently.
--
-- DIRECTION OF THE FIX. Where a writer's vocabulary is genuinely better, the
-- SCHEMA adopts it rather than rewriting twelve call sites to match a weaker
-- original. Concretely:
--
--   * `queued` becomes a legal status. It is load-bearing — agents/run.js:300
--     reaps on it — and it is the correct semantic for "drafted, not yet
--     transmitted". The original CHECK's `draft` conflates "human is editing"
--     with "ready to send".
--   * object_type/object_id are added as a GENERIC subject reference. The
--     original modelled only order_id + source_po_id, but the real writers
--     reference quotes, invoices, inventory exceptions, RFQs and network
--     listings. ar_collect.js:142 already reads object_type/object_id.
--
-- Everything is additive: no column is dropped, no existing row changes
-- meaning, and the three conforming writers are unaffected.

-- ── 1. Recipients: cc/bcc, and the name variants writers already use ───────
alter table communications
  add column if not exists cc_addrs   text[] not null default '{}',
  add column if not exists bcc_addrs  text[] not null default '{}',
  add column if not exists reply_to   text;

comment on column communications.cc_addrs is
  'CC recipients. Required by function-based routing (a dispatch register goes '
  'TO stores with purchase/accounts in CC) — see docs/CUSTOMER_COMMS_DESIGN.md.';

-- ── 2. Generic subject reference ──────────────────────────────────────────
-- order_id/source_po_id stay (FK-enforced, already indexed). These carry the
-- cases those two cannot: quote, invoice, inventory_exception, supplier_rfq,
-- network_listing, prospecting_target.
alter table communications
  add column if not exists object_type text,
  add column if not exists object_id   uuid;

create index if not exists communications_object_idx
  on communications (tenant_id, object_type, object_id)
  where object_type is not null;

-- ── 3. Routing + analytics columns the design doc needs ───────────────────
alter table communications
  add column if not exists customer_id         uuid references customers(id) on delete set null,
  add column if not exists customer_contact_id uuid references customer_contacts(id) on delete set null,
  add column if not exists document_type       text,
  add column if not exists provider            text,
  add column if not exists provider_message_id text,
  add column if not exists sent_by             uuid,
  add column if not exists updated_at          timestamptz not null default now();

comment on column communications.document_type is
  'The shared vocabulary across routing, templates, analytics and suppression: '
  'quote | dispatch_register | invoice | payment_reminder | proof_of_delivery | '
  'service_report | marketing. Intentionally NOT constrained — a tenant may add '
  'its own types, and a CHECK here would need a migration per type.';
comment on column communications.provider_message_id is
  'The provider''s own id (SendGrid x-message-id, Graph internetMessageId). '
  'Required to attribute a delivery receipt or a reply back to this row.';

create index if not exists communications_customer_idx
  on communications (tenant_id, customer_id, created_at desc)
  where customer_id is not null;

-- ── 4. Widen the status CHECK to the states writers actually use ──────────
-- draft   : a human is still editing
-- queued  : ready to transmit; agents/run.js:300 reaps these
-- sent / failed / replied / archived : as before
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'communications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  ) then
    execute (
      select 'alter table communications drop constraint ' || quote_ident(conname)
        from pg_constraint
       where conrelid = 'communications'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%status%'
       limit 1
    );
  end if;
end $$;

alter table communications
  add constraint communications_status_chk
  check (status in ('draft','queued','sent','failed','replied','archived'));

-- ── 5. Backfill direction for any pre-existing row ────────────────────────
-- `direction` is NOT NULL, so nothing can currently be inserted without it —
-- but a row written out-of-band would block the constraint below.
update communications set direction = 'outbound' where direction is null;
