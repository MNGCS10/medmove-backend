-- =============================================================
-- MedMove — Supabase Storage setup
-- payment-slips : private (เฉพาะ service_role + admin ของ tenant)
-- qr-codes      : public (ให้ LINE โหลดรูป QR ได้)
-- รันหลัง medmove_schema.sql
-- =============================================================

-- ---------- buckets ----------
insert into storage.buckets (id, name, public)
values ('payment-slips', 'payment-slips', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('qr-codes', 'qr-codes', true)
on conflict (id) do nothing;

-- ---------- policies: qr-codes (อ่านสาธารณะ, เขียนเฉพาะ service_role) ----------
-- service_role bypass RLS อยู่แล้ว จึงไม่ต้องมี insert policy
create policy "qr public read"
  on storage.objects for select
  using (bucket_id = 'qr-codes');

-- ---------- policies: payment-slips (admin ของ tenant อ่านได้) ----------
-- path convention: {tenant_id}/{booking_id}.jpg  -> ใช้ folder แรกเป็น tenant_id
create policy "slips read by tenant admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'payment-slips'
    and (storage.foldername(name))[1]::uuid in (select public.current_tenant_ids())
  );

-- upload สลิปทำผ่าน backend (service_role) เท่านั้น — ไม่เปิด insert ให้ authenticated
-- =============================================================
-- NOTE: เปิด Realtime ให้ตาราง drivers + trip_tracking (Dashboard > Database > Replication)
--       เพื่อให้ LIFF/dashboard subscribe ตำแหน่งรถสด
-- =============================================================
