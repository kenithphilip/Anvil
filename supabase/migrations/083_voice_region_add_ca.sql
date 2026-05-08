-- 083_voice_region_add_ca.sql
--
-- Add 'CA' to voice_configs.region's CHECK constraint. The May 2026
-- critic noted that Canadian +1 numbers were silently bucketed under
-- US, which runs the wrong recording-disclosure copy and the wrong
-- compliance regime (CRTC + CASL vs FCC + TCPA). The compliance
-- helper now distinguishes them; this migration lets the column
-- store the new value.
--
-- Idempotent.

alter table voice_configs
  drop constraint if exists voice_configs_region_check;

alter table voice_configs
  add constraint voice_configs_region_check
  check (region in ('IN', 'US', 'CA', 'EU', 'UK', 'AE', 'SG', 'OTHER'));
