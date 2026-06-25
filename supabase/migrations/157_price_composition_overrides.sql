-- 157_price_composition_overrides.sql
--
-- Per-line overhead adjustments. Pricing-profile components (freight, duty,
-- insurance, CHA, margin, discount, ...) are otherwise fixed by the profile;
-- this lets an operator adjust a component's rate/amount for a single quote
-- line. Shape: { "<component_code>": <number> } where the number replaces the
-- component's rate (pct_of / margin / discount) or amount (per_unit).
-- Empty {} = use the profile defaults.

alter table price_composition_lines
  add column if not exists overrides jsonb not null default '{}'::jsonb;
