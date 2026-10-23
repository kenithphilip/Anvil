-- 269_email_action_evidence.sql
--
-- Email accountability, EA-5: the evidence that an action was done.
-- docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.6.
--
--   email_action_evidence  one row per piece of evidence:
--     kind 'outgoing'  a sent message the verifier linked to the action, with
--                      the method (header_reply, conversation_index,
--                      conversation_only), the result (verified, ambiguous,
--                      rejected) and the reasons. One row per action and
--                      outgoing message, so a replayed sync page adds nothing.
--     kind 'manual'    a person's claim ("confirmed by phone"), status
--                      'claimed' until a user with email.verify confirms or
--                      rejects it. The confirmer is never the claimant.
--   A person's decision on ambiguous mail or on a claim sets decided_by,
--   decided_at and decision_reason, and is audited.
--
-- IDs and metadata only: no body. RLS on with no tenant-user policy.
--
-- Additive and idempotent. APPLY BY HAND after 268, then:
--
--   notify pgrst, 'reload schema';
--
-- VERIFY. Expect 1.
--
--   select count(*) from information_schema.tables where table_name = 'email_action_evidence';

create table if not exists email_action_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email_action_id uuid not null references email_actions(id) on delete cascade,
  kind text not null check (kind in ('outgoing', 'manual')),

  connection_id uuid references mailbox_connections(id) on delete set null,
  provider text,
  provider_message_id text,
  internet_message_id text,
  sent_at timestamptz,
  sender text,
  recipients text[] not null default '{}',
  has_attachments boolean,
  web_link text,

  method text not null check (method in ('header_reply', 'conversation_index', 'conversation_only', 'manual')),
  status text not null check (status in ('verified', 'ambiguous', 'rejected', 'claimed', 'confirmed')),
  confidence text check (confidence in ('high', 'medium', 'low')),
  reasons jsonb not null default '[]'::jsonb,

  note text,
  reference text,
  recorded_by uuid references auth.users(id) on delete set null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),

  constraint email_action_evidence_manual_note check (kind <> 'manual' or (note is not null and length(note) >= 10))
);

create unique index if not exists email_action_evidence_outgoing_uq
  on email_action_evidence (email_action_id, (coalesce(internet_message_id, provider || ':' || provider_message_id)))
  where kind = 'outgoing';
create index if not exists email_action_evidence_action_idx
  on email_action_evidence (tenant_id, email_action_id, created_at);
create index if not exists email_action_evidence_open_idx
  on email_action_evidence (tenant_id, status)
  where status in ('ambiguous', 'claimed');

comment on table email_action_evidence is
  'Email accountability: evidence that an action was done (a linked sent message, or a person''s claim). IDs and metadata only. RLS on, no tenant-user policy.';

alter table email_action_evidence enable row level security;
revoke all on email_action_evidence from anon, authenticated;
