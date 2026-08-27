-- =============================================================
-- MedMove — Auto-timeout สำหรับ trip ที่ค้างสถานะ (human error guard)
-- ป้องกันคนขับลืมกด "ถึงแล้ว/เสร็จงาน" ใน driver.html แล้วค้างสถานะ
-- "มีงาน" ตลอดไป จนรับงานใหม่ไม่ได้ (เจอจริงระหว่างทดสอบ)
--
-- Logic: booking อยู่ในสถานะ dispatched/en_route/arrived เกิน
-- STALE_HOURS ชั่วโมง (นับจาก updated_at ล่าสุด) → auto mark
-- completed + ปล่อยคนขับกลับเป็น available + log ไว้ตรวจสอบทีหลัง
-- =============================================================

create or replace function public.auto_complete_stale_trips(stale_hours numeric default 4)
returns table(booking_id uuid, driver_id uuid, tenant_id uuid) as $$
begin
  return query
  with stale as (
    select b.id, b.driver_id, b.tenant_id
    from public.bookings b
    where b.status in ('dispatched', 'en_route', 'arrived')
      and b.updated_at < now() - (stale_hours || ' hours')::interval
  )
  update public.bookings b
  set status = 'completed'
  from stale s
  where b.id = s.id
  returning b.id, s.driver_id, s.tenant_id;
end;
$$ language plpgsql security definer set search_path = public;

-- ปล่อยคนขับ + log เป็น booking_events (แยกจากฟังก์ชันหลักเพื่อความชัดเจน)
create or replace function public.run_auto_complete_stale_trips()
returns void as $$
declare
  r record;
begin
  for r in select * from public.auto_complete_stale_trips(4) loop
    update public.drivers set status = 'available' where id = r.driver_id;
    insert into public.booking_events (tenant_id, booking_id, event_type, from_status, to_status, actor, detail)
    values (r.tenant_id, r.booking_id, 'status_change', 'en_route', 'completed', 'system:auto_timeout',
            jsonb_build_object('reason', 'auto-completed after stale timeout — check if driver forgot to mark complete'));
  end loop;
end;
$$ language plpgsql security definer set search_path = public;

-- ตั้งให้รันทุก 15 นาทีผ่าน pg_cron (Supabase เปิด extension นี้ให้ใช้ได้)
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'medmove-auto-complete-stale-trips',
  '*/15 * * * *',
  $$select public.run_auto_complete_stale_trips();$$
);

-- สำคัญ: ปิดสิทธิ์เรียกผ่าน public REST API — Postgres/PostgREST เปิด function
-- ให้ทุก role (รวม anon/authenticated) เรียกได้เป็นค่าเริ่มต้นผ่าน PUBLIC grant
-- ถ้าไม่ revoke ตรงนี้ ใครก็เอา anon key ไปยิง /rest/v1/rpc/... บังคับปิดงานทุก
-- tenant กลางทางได้ทันที ต้องเหลือแค่ service_role (cron + backend) เท่านั้น
revoke execute on function public.auto_complete_stale_trips(numeric) from public;
revoke execute on function public.run_auto_complete_stale_trips() from public;
grant execute on function public.auto_complete_stale_trips(numeric) to service_role;
grant execute on function public.run_auto_complete_stale_trips() to service_role;
