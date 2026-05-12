-- Migration 104: return-for-correction columns on orders.
--
-- Bug fix May 2026 (manager-correction report): managers reviewing
-- an SO previously had only "approve" and "cancel" as exits. When
-- the operator entered a wrong ship-to address or misread a rate,
-- the manager had to phone the operator out-of-band; the workspace
-- had no formal "send this back" path.
--
-- The Return-for-correction action transitions the order from
-- PENDING_REVIEW or APPROVED back to DRAFT and records:
--   correction_reason            text   . manager-provided note
--   correction_requested_by      text   . role of the manager
--   correction_requested_at      timestamptz . audit timestamp
--
-- The columns are nullable so old rows are unaffected. The handler
-- at src/api/orders/[id].js writes them on the same PATCH that flips
-- status, so the transition and the reason land atomically.
--
-- The columns are append-only in spirit: a subsequent return-for-
-- correction overwrites them. Historical entries live in
-- audit_events (action = 'manager_requested_correction') and the
-- ThreadDrawer + Activity tab surface the full chain.

alter table orders
  add column if not exists correction_reason text,
  add column if not exists correction_requested_by text,
  add column if not exists correction_requested_at timestamptz;

create index if not exists orders_correction_requested_at_idx
  on orders (tenant_id, correction_requested_at desc)
  where correction_requested_at is not null;
