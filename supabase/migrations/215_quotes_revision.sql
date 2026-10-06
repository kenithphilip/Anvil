-- 215_quotes_revision.sql
--
-- Give an ingested quotation somewhere to put its revision.
--
-- WHY. Real quotations are revised. The one that prompted this carries
-- "REV-1" inside its own number and a "Revised Dt" printed separately from the
-- issue date — two different facts, both meaningful: an operator comparing a
-- PO against a quote needs to know WHICH revision priced it, and "when was
-- this agreed?" is answered by the revision date, not the original one.
--
-- Migration 214's sibling problem: PR #462 taught the extractor to read both
-- (claude.js QUOTE_TOOL: revision, revised_date) and there was no column to
-- put them in, so they were parsed and dropped. This is the column.
--
-- WHY NOT REUSE quotes.version. version is Anvil's OWN revision counter, part
-- of the unique key (tenant_id, quote_number, version) and incremented by our
-- quote builder. A seller's printed "REV-1" is THEIR marker, arrives inside
-- the quote number string, and does not increment as we re-ingest. Folding one
-- into the other would make re-ingesting a corrected PDF look like a new
-- version of our own — and quotes are keyed on that, so it would create a
-- duplicate row rather than update in place.
--
-- revised_date is a date, not a timestamp: quotations print a day.

alter table quotes
  add column if not exists revision text,
  add column if not exists revised_date date;

comment on column quotes.revision is
  'The ISSUER''s own revision marker as printed (''REV-1'', ''R2''), usually a '
  'suffix on the quote number. Distinct from quotes.version, which is Anvil''s '
  'internal counter and part of the unique key.';
comment on column quotes.revised_date is
  'A revision date printed SEPARATELY from the quote date. Null when the '
  'document carries only one date. Prefer this over sent_at when showing '
  '"as of when was this priced".';
