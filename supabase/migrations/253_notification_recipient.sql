-- 253_notification_recipient.sql
--
-- A notice per person (WM-7, C-17 in docs/SO_EXECUTION_COHESION.md, R-F5).
--
-- WHY. admin_notifications (migration 042) has no recipient. notifyAdmins
-- reads its roles only to decide whether to insert, so every row is a
-- broadcast row and the bell shows it to admin and operator only. Nothing can
-- tell one person that the next step is theirs.
--
-- SHAPE. recipient_user_id is nullable:
--   - null      a broadcast row, as before. The bell shows it to the roles
--               that saw the bell before this migration (admin, operator).
--   - a user    a row for that person only. Only that person sees it and only
--               that person can mark it read.
-- The column decides who sees a row, so a deleted user takes their rows with
-- them (on delete cascade). "set null" would turn a private notice into a
-- broadcast row that admins can read.
--
-- READS. GET /api/admin/notifications lists the caller's own rows, plus the
-- broadcast rows when the caller is admin or operator. The partial index
-- serves that unresolved, newest-first list.
--
-- Additive and idempotent. Applied by hand (no auto-migrate on deploy).

alter table admin_notifications
  add column if not exists recipient_user_id uuid null references auth.users(id) on delete cascade;

create index if not exists admin_notifications_recipient_idx
  on admin_notifications (tenant_id, recipient_user_id, created_at desc)
  where resolved = false;
