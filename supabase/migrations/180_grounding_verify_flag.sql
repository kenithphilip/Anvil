-- Migration 180: grounding-verify dark flag.
--
-- Adds tenant_settings.grounding_verify_enabled (default false), the dark
-- master switch for the extraction grounding verifier. When enabled, the
-- DocAI pipeline (src/api/_lib/docai/run.js) runs a deterministic
-- verify-and-correct pass that cross-checks the extracted customer against
-- Anvil's own `customers` registry: Phase 1 pins customer identity from a
-- valid, registry-known GSTIN (fill blank customer fields from the canonical
-- row, floor their confidence, flag mismatches / unknown-but-valid GSTINs).
--
-- Additive + idempotent. Default false -> byte-identical for every tenant
-- until one opts in for a pilot. See docs/EXTRACTION_GROUNDING_DESIGN.md.

alter table tenant_settings
  add column if not exists grounding_verify_enabled boolean not null default false;

comment on column tenant_settings.grounding_verify_enabled is
  'Dark master switch for the extraction grounding verifier (docai/run.js). Phase 1: pin customer identity from a registry-known GSTIN. Default false. See docs/EXTRACTION_GROUNDING_DESIGN.md.';
