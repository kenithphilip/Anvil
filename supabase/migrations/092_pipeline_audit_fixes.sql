-- 092_pipeline_audit_fixes.sql
--
-- Audit fixes for the Phases B-F unified pipeline. The audit
-- against migrations 029, 088, 089, 090, 091 + run.js + claude.js
-- found two CHECK gaps that would cause runtime errors on real
-- traffic:
--
--   1. customer_format_templates.kind CHECK (091) does not list
--      'rfq', but run.js calls buildTemplate(...) after every
--      ok run with whatever kind the caller passed. /api/docai/
--      extract accepts kind='rfq' (Phase A intent). The first
--      successful 'rfq' run would CRASH the safeFire() insert
--      with a CHECK violation.
--
--   2. extraction_runs.status_reason CHECK (088) does not list
--      'non_ack'. claude.js emits reason='non_ack' when the
--      classifier decides a supplier-ack PDF isn't actually an
--      ack (e.g., a marketing brochure attached by mistake).
--      Today run.js silently records status_reason='ok' for
--      these, which is misleading. After this migration the run
--      can persist 'non_ack' with status='failed', surfacing the
--      misclassification on the diagnostics tab.
--
-- Both CHECKs are open-ended text-with-CHECK shapes (per 088 / 091
-- design); we drop the existing constraint and re-add with the
-- expanded value list. Idempotent + safe for tenants on the
-- existing constraint.

-- ----- 1. customer_format_templates.kind: add 'rfq' --------------

alter table customer_format_templates
  drop constraint if exists customer_format_templates_kind_check;
alter table customer_format_templates
  add constraint customer_format_templates_kind_check
  check (kind in ('po','rfq','quote','invoice','supplier_ack','eway_bill'));

-- ----- 2. extraction_runs.status_reason: add 'non_ack' -----------

alter table extraction_runs
  drop constraint if exists extraction_runs_status_reason_check;
alter table extraction_runs
  add constraint extraction_runs_status_reason_check
  check (status_reason is null or status_reason in (
    'ok',
    'low_confidence',
    'empty_lines',
    'non_po',
    'non_ack',                -- Phase F.2: supplier-ack classifier said "this isn't an ack"
    'no_adapter_configured',
    'all_adapters_skipped',
    'image_pdf_no_text',
    'parse_failed',
    'model_refused',
    'upstream_error',
    'fail_unknown'
  ));

-- ----- 3. supplier_ack_extractions: forwarded marker -------------
--
-- Phase F.2 follow-through: the operator-confirmed accept flow
-- needs to know which source_po_ack call consumed which extraction
-- review row. We add a forward-pointer so the audit trail is
-- complete and the workspace can render "this ack was applied to
-- source_po X by user Y at <timestamp>" without joining through
-- audit_events.

alter table supplier_ack_extractions
  add column if not exists forwarded_at timestamptz,
  add column if not exists forwarded_by uuid references auth.users(id),
  add column if not exists ack_payload jsonb;       -- snapshot of what we sent into /source_pos/ack

comment on column supplier_ack_extractions.forwarded_at is
  'Phase F.2: stamped when the operator clicked Accept and we forwarded the extracted fields into /api/source_pos/ack.';
comment on column supplier_ack_extractions.ack_payload is
  'The structured payload sent to /api/source_pos/ack. Lets us replay or audit without recomputing.';
