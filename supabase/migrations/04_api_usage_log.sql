-- =============================================================
-- MedMove — API Usage Log (ต้นทุน Google Maps ต่อ tenant)
-- ใช้ log ทุกครั้งที่ backend เรียก Google Maps API แทนลูกค้า
-- เก็บเป็น event log (1 แถวต่อ 1 เรียก) ไม่ aggregate ตอน insert
-- เพื่อให้ query ย้อนหลังได้ละเอียด (รายวัน/รายเดือน/ราย tenant)
-- =============================================================

create table if not exists public.api_usage_log (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  api_type    text not null,        -- 'static_map' | 'geocode' | 'places_autocomplete' | 'directions' ฯลฯ
  booking_id  uuid references public.bookings(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_api_usage_log_tenant_month
  on public.api_usage_log (tenant_id, created_at);

alter table public.api_usage_log enable row level security;

create policy "tenant reads own usage log" on public.api_usage_log
  for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

-- view สรุปรายเดือนต่อ tenant ต่อประเภท API — ใช้ตั้งราคาแพ็กเกจ/เช็คต้นทุนได้ตรง
create or replace view public.api_usage_monthly as
select
  tenant_id,
  api_type,
  date_trunc('month', created_at) as month,
  count(*) as call_count
from public.api_usage_log
group by tenant_id, api_type, date_trunc('month', created_at);
