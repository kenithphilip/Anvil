-- Quote field provenance.
--
-- Capture the source of each header field so the trail makes clear
-- which values were auto-filled (from customer / opportunity / template)
-- versus explicitly entered or overridden by an operator. Mirrors the
-- `_field_sources` pattern used on SO recon line items in JSONB; here it
-- is a real column on quotes so PostgREST and the drawer can read it
-- without a JSONB dig.
--
-- Shape: { field_name: source_string }, e.g.
--   { currency: "customer.currency",
--     validity_days: "customer.default_quote_validity_days",
--     your_ref: "opportunity.lead.reference",
--     attention_contact: "operator_override" }
--
-- Additive + idempotent. Existing rows get the empty default {}.

alter table quotes
  add column if not exists field_sources jsonb not null default '{}'::jsonb;

comment on column quotes.field_sources is
  'Per-field provenance map. Values are source strings: customer.* / opportunity.* / template / operator_override.';
