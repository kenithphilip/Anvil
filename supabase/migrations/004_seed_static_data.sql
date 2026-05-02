-- 004_seed_static_data.sql
-- Seeds public holiday calendar (tenant_id null) for India, China, Japan, Korea, USA in 2026
-- and provides a function to populate default lead times when tenants onboard.

insert into holiday_calendar (tenant_id, country, date, name) values
  (null, 'IN', '2026-01-26', 'Republic Day'),
  (null, 'IN', '2026-03-21', 'Holi'),
  (null, 'IN', '2026-04-03', 'Good Friday'),
  (null, 'IN', '2026-05-01', 'Maharashtra Day'),
  (null, 'IN', '2026-08-15', 'Independence Day'),
  (null, 'IN', '2026-08-26', 'Janmashtami'),
  (null, 'IN', '2026-09-15', 'Ganesh Chaturthi'),
  (null, 'IN', '2026-10-02', 'Gandhi Jayanti'),
  (null, 'IN', '2026-10-19', 'Dussehra'),
  (null, 'IN', '2026-11-08', 'Diwali'),
  (null, 'IN', '2026-12-25', 'Christmas Day'),
  (null, 'CN', '2026-01-01', 'New Year'),
  (null, 'CN', '2026-02-17', 'Spring Festival eve'),
  (null, 'CN', '2026-02-18', 'Spring Festival'),
  (null, 'CN', '2026-02-19', 'Spring Festival'),
  (null, 'CN', '2026-02-20', 'Spring Festival'),
  (null, 'CN', '2026-02-21', 'Spring Festival'),
  (null, 'CN', '2026-04-04', 'Qingming'),
  (null, 'CN', '2026-05-01', 'Labour Day'),
  (null, 'CN', '2026-06-19', 'Dragon Boat Festival'),
  (null, 'CN', '2026-09-25', 'Mid-Autumn'),
  (null, 'CN', '2026-10-01', 'National Day'),
  (null, 'CN', '2026-10-02', 'National Day'),
  (null, 'CN', '2026-10-03', 'National Day'),
  (null, 'JP', '2026-01-01', 'New Year'),
  (null, 'JP', '2026-01-12', 'Coming of Age Day'),
  (null, 'JP', '2026-02-11', 'Foundation Day'),
  (null, 'JP', '2026-04-29', 'Showa Day'),
  (null, 'JP', '2026-05-03', 'Constitution Day'),
  (null, 'JP', '2026-05-04', 'Greenery Day'),
  (null, 'JP', '2026-05-05', 'Children Day'),
  (null, 'JP', '2026-07-20', 'Marine Day'),
  (null, 'JP', '2026-08-11', 'Mountain Day'),
  (null, 'JP', '2026-09-21', 'Respect for the Aged Day'),
  (null, 'JP', '2026-11-03', 'Culture Day'),
  (null, 'JP', '2026-11-23', 'Labour Thanksgiving'),
  (null, 'KR', '2026-01-01', 'New Year'),
  (null, 'KR', '2026-02-16', 'Seollal eve'),
  (null, 'KR', '2026-02-17', 'Seollal'),
  (null, 'KR', '2026-02-18', 'Seollal'),
  (null, 'KR', '2026-03-01', 'Independence Day'),
  (null, 'KR', '2026-05-05', 'Children Day'),
  (null, 'KR', '2026-05-25', 'Buddha birthday'),
  (null, 'KR', '2026-06-06', 'Memorial Day'),
  (null, 'KR', '2026-08-15', 'Liberation Day'),
  (null, 'KR', '2026-09-24', 'Chuseok eve'),
  (null, 'KR', '2026-09-25', 'Chuseok'),
  (null, 'KR', '2026-09-26', 'Chuseok'),
  (null, 'KR', '2026-10-03', 'National Foundation Day'),
  (null, 'KR', '2026-12-25', 'Christmas Day'),
  (null, 'US', '2026-01-01', 'New Year'),
  (null, 'US', '2026-01-19', 'MLK Day'),
  (null, 'US', '2026-02-16', 'Presidents Day'),
  (null, 'US', '2026-05-25', 'Memorial Day'),
  (null, 'US', '2026-07-03', 'Independence Day observed'),
  (null, 'US', '2026-09-07', 'Labor Day'),
  (null, 'US', '2026-11-26', 'Thanksgiving'),
  (null, 'US', '2026-12-25', 'Christmas Day')
on conflict do nothing;

create or replace function seed_default_lead_times(tenant uuid) returns void language plpgsql as $$
begin
  insert into supplier_lead_times (tenant_id, supplier, country, product_category, lead_days, notes)
  values
    (tenant, null, 'IN', null, 7, 'India local'),
    (tenant, null, 'CN', null, 21, 'China inter-company'),
    (tenant, null, 'JP', null, 21, 'Japan inter-company'),
    (tenant, null, 'KR', null, 14, 'Korea inter-company'),
    (tenant, null, 'US', null, 30, 'External / EXTERNAL')
  on conflict do nothing;
end $$;

select seed_default_lead_times('00000000-0000-0000-0000-000000000001'::uuid);
