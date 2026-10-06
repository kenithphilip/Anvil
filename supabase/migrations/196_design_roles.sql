-- 196_design_roles.sql — add design-team member roles.
--
-- Gun/spare data and drawings can be uploaded by the DESIGN team
-- (engineer or manager) as well as the sales team. The member-role enum
-- was renamed obara_role -> anvil_role in migration 160.
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS is idempotent (PG12+). The new
-- values are NOT referenced elsewhere in this migration, so there is no
-- same-transaction "unsafe use of new enum value" hazard. Applied
-- manually like every migration; run this before assigning a member one
-- of the new roles.

alter type anvil_role add value if not exists 'design_engineer';
alter type anvil_role add value if not exists 'design_manager';
