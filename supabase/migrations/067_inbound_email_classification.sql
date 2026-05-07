-- 067_inbound_email_classification.sql
--
-- Audit P5.3 (May 2026). The previous inbox surface used a regex
-- looksLikeRfq() at parse time: if the subject contained
-- "rfq" / "rfp" / "quote" / "po" or the body was longer than
-- 800 characters or there was an attachment, the row got
-- status='linked'. Anything else became status='parsed' and sat
-- unhandled. There was no signal for the operator about whether
-- a parsed-not-linked email was a real customer reply, an
-- out-of-office, marketing spam, or a payment-acknowledgement.
--
-- This migration adds the columns the Haiku-tier classifier
-- (Phase 5.3) writes to: a discrete intent enum and a self-
-- assessed confidence. The inbox screen and the dunning agent's
-- reply-handling loop (Phase 6) read these.

alter table inbound_emails
  add column if not exists classified_intent text,
  add column if not exists classification_confidence numeric(4, 3),
  add column if not exists classification_model text,
  add column if not exists classified_at timestamptz;

-- The intent values are mirrored in src/api/_lib/email-classifier.js
-- INTENT_ENUM. Storing as plain text instead of a Postgres enum
-- so additions in the classifier don't require a migration.

create index if not exists inbound_emails_intent_idx
  on inbound_emails (tenant_id, classified_intent)
  where classified_intent is not null;
