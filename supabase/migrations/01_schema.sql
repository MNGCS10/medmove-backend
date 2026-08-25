-- =============================================================
-- MedMove — Ambulance / Medical Transport Booking
-- Supabase (PostgreSQL) schema — multi-tenant + RLS
-- Stack: Supabase + Hono/Bun + LINE LIFF
-- Convention: ทุกตารางธุรกิจมี tenant_id (clone-per-clinic -> multi-tenant)
-- Writes จาก webhook/backend ใช้ service_role (bypass RLS)
-- RLS ปกป้องเฉพาะ admin dashboard (Supabase auth)
-- =============================================================

create extension if not exists pgcrypto;

-- ---------- ENUM types (idempotent) ----------
do $$ begin
  create type booking_status as enum (
    'draft','pending_confirm','confirmed','awaiting_payment',
    'paid','dispatched','en_route','arrived','completed',
    'cancelled','rejected'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending','verified','rejected','manual_verified','waived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type driver_status as enum ('available','on_trip','offline');
exception when duplicate_object then null; end $$;

-- ---------- updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =============================================================
-- 1) TENANTS + membership (สำหรับ RLS)
-- =============================================================
create table if not exists public.tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  line_channel_id       text,                       -- LINE OA channel
  emergency_hotline     text default '1669',        -- แสดงใน disclaimer โหมดด่วน
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- แมป Supabase auth user -> tenant (ใครดูแล OA ไหน)
create table if not exists public.tenant_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'admin',        -- admin | owner | dispatcher
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- helper: tenant_ids ของ user ที่ล็อกอิน (ใช้ใน RLS policy)
create or replace function public.current_tenant_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.tenant_members where user_id = auth.uid();
$$;

-- =============================================================
-- 2) CUSTOMERS (จาก LINE profile — ไม่ซ้ำด้วย line_user_id ต่อ tenant)
-- =============================================================
create table if not exists public.customers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  line_user_id   text not null,
  display_name   text,
  phone_number   text,
  picture_url    text,
  pdpa_consent   boolean not null default false,     -- ต้อง true ก่อนจองครั้งแรก
  pdpa_consent_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, line_user_id)
);
create trigger trg_customers_updated before update on public.customers
  for each row execute function public.set_updated_at();

-- =============================================================
-- 3) DRIVERS + VEHICLES
-- =============================================================
create table if not exists public.drivers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  name           text not null,
  phone          text,
  vehicle_plate  text,
  vehicle_type   text,                               -- เปลปกติ / มีออกซิเจน / ICU
  status         driver_status not null default 'offline',
  -- ตำแหน่งล่าสุด (อัปเดตสด, ให้ dashboard/LIFF subscribe ผ่าน Supabase Realtime)
  current_lat    double precision,
  current_lng    double precision,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_drivers_updated before update on public.drivers
  for each row execute function public.set_updated_at();
create index if not exists idx_drivers_tenant_status on public.drivers(tenant_id, status);

-- =============================================================
-- 4) PRICING CONFIG (versioned ด้วย effective_date — เก็บประวัติราคา)
-- =============================================================
create table if not exists public.pricing_configs (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants(id) on delete cascade,
  fuel_price_per_liter        numeric(8,2)  not null default 32.50,
  fuel_consumption_km_per_l   numeric(6,2)  not null default 10.0,
  margin_per_km               numeric(8,2)  not null default 15.0,
  base_fee                    numeric(10,2) not null default 100.0,
  min_distance_charge_km      numeric(6,2)  not null default 5.0,
  night_surcharge_percent     numeric(5,2)  not null default 20.0,
  night_start_hour            int not null default 22,   -- 22:00
  night_end_hour              int not null default 5,     -- 05:00
  waiting_fee_per_hour        numeric(10,2) not null default 100.0,
  effective_date              date not null default current_date,
  created_at                  timestamptz not null default now()
);
create index if not exists idx_pricing_tenant_date
  on public.pricing_configs(tenant_id, effective_date desc);

-- คำนวณราคา: ระยะ × (น้ำมัน/กม. + มาร์จิ้น) + base, + night surcharge
create or replace function public.calculate_price(
  p_tenant_id   uuid,
  p_distance_km numeric,
  p_scheduled_at timestamptz default now()
) returns numeric
language plpgsql stable as $$
declare
  cfg           public.pricing_configs%rowtype;
  per_km        numeric;
  charge_km     numeric;
  total         numeric;
  hr            int;
  is_night      boolean;
begin
  select * into cfg from public.pricing_configs
   where tenant_id = p_tenant_id and effective_date <= (p_scheduled_at at time zone 'Asia/Bangkok')::date
   order by effective_date desc limit 1;
  if not found then
    raise exception 'no pricing config for tenant %', p_tenant_id;
  end if;

  per_km    := (cfg.fuel_price_per_liter / cfg.fuel_consumption_km_per_l) + cfg.margin_per_km;
  charge_km := greatest(p_distance_km, cfg.min_distance_charge_km);
  total     := cfg.base_fee + (charge_km * per_km);

  hr := extract(hour from (p_scheduled_at at time zone 'Asia/Bangkok'));
  is_night := case
    when cfg.night_start_hour > cfg.night_end_hour
      then (hr >= cfg.night_start_hour or hr < cfg.night_end_hour)
    else (hr >= cfg.night_start_hour and hr < cfg.night_end_hour)
  end;
  if is_night then
    total := total * (1 + cfg.night_surcharge_percent / 100.0);
  end if;

  return round(total, 2);
end $$;

-- =============================================================
-- 5) BOOKINGS (core — state machine)
-- =============================================================
create table if not exists public.bookings (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete restrict,
  driver_id             uuid references public.drivers(id) on delete set null,

  origin_address        text,
  origin_lat            double precision not null,
  origin_lng            double precision not null,
  destination_address   text,
  destination_lat       double precision not null,
  destination_lng       double precision not null,

  scheduled_at          timestamptz,                 -- null ได้ถ้าเป็นเคสด่วน (ทันที)
  distance_km           numeric(8,3) not null,
  price_calculated      numeric(10,2) not null,

  status                booking_status not null default 'draft',
  is_emergency          boolean not null default false,   -- โหมดด่วน: ข้าม payment ก่อน dispatch
  reminder_sent_at      timestamptz,                 -- กัน cron ส่งเตือนซ้ำ

  patient_count         int default 1,
  special_equipment     text,                         -- เปล / ออกซิเจน
  contact_phone         text,
  notes                 text,

  idempotency_key       text,                         -- กันกดส่งฟอร์มซ้ำ
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create trigger trg_bookings_updated before update on public.bookings
  for each row execute function public.set_updated_at();
create index if not exists idx_bookings_tenant_status on public.bookings(tenant_id, status);
create index if not exists idx_bookings_scheduled on public.bookings(scheduled_at)
  where status = 'paid';
create index if not exists idx_bookings_customer on public.bookings(customer_id);

-- =============================================================
-- 6) PAYMENTS (สลิป + verification + manual fallback)
-- =============================================================
create table if not exists public.payments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  booking_id            uuid not null references public.bookings(id) on delete cascade,
  amount                numeric(10,2) not null,
  slip_image_url        text,
  slip_hash             text,                         -- กันสลิปซ้ำ (duplicate)
  verification_status   payment_status not null default 'pending',
  verified_by           uuid references auth.users(id),  -- ถ้า admin ตรวจเอง
  verified_at           timestamptz,
  transaction_ref       text,
  raw_verify_response   jsonb,                        -- เก็บผลจาก SlipOK/EasySlip ไว้ debug
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_payments_updated before update on public.payments
  for each row execute function public.set_updated_at();
create index if not exists idx_payments_booking on public.payments(booking_id);
create unique index if not exists uq_payments_slip_hash
  on public.payments(tenant_id, slip_hash) where slip_hash is not null;

-- =============================================================
-- 7) TRIP TRACKING (1 แถวต่อ 1 booking — pattern จากไฟล์ 1)
--    route เก็บเป็น jsonb ได้เลย (ไม่ต้องแบ่ง chunk แบบ Sheets)
-- =============================================================
create table if not exists public.trip_tracking (
  booking_id       uuid primary key references public.bookings(id) on delete cascade,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  started_at       timestamptz,
  ended_at         timestamptz,
  point_count      int not null default 0,
  total_distance_km numeric(10,3) not null default 0,
  last_lat         double precision,
  last_lng         double precision,
  last_accuracy    double precision,
  last_speed       double precision,
  geofence_5km_notified  boolean not null default false,   -- แจ้ง "รถใกล้ถึง"
  geofence_1km_notified  boolean not null default false,
  route            jsonb not null default '[]'::jsonb,     -- [[ts,lat,lng,acc,spd], ...]
  updated_at       timestamptz not null default now()
);
create trigger trg_trip_tracking_updated before update on public.trip_tracking
  for each row execute function public.set_updated_at();

-- =============================================================
-- 8) BOOKING EVENTS (audit trail — ทุกการเปลี่ยนสถานะ/ยืนยันสลิป)
-- =============================================================
create table if not exists public.booking_events (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  booking_id   uuid not null references public.bookings(id) on delete cascade,
  event_type   text not null,                        -- status_change | payment | dispatch | emergency | admin_override
  from_status  booking_status,
  to_status    booking_status,
  actor        text,                                 -- system | line_user:xxx | admin:uuid
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists idx_events_booking on public.booking_events(booking_id, created_at desc);

-- auto-log ทุกครั้งที่ booking เปลี่ยน status
create or replace function public.log_booking_status()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and new.status is distinct from old.status)
     or tg_op = 'INSERT' then
    insert into public.booking_events(tenant_id, booking_id, event_type, from_status, to_status, actor, detail)
    values (new.tenant_id, new.id, 'status_change',
            case when tg_op='UPDATE' then old.status else null end,
            new.status, 'system',
            jsonb_build_object('is_emergency', new.is_emergency));
  end if;
  return new;
end $$;
create trigger trg_bookings_audit after insert or update on public.bookings
  for each row execute function public.log_booking_status();

-- =============================================================
-- 9) ROW LEVEL SECURITY
--    - webhook/backend ใช้ service_role -> bypass ทั้งหมด
--    - admin (auth) เห็นเฉพาะ tenant ตัวเอง
-- =============================================================
alter table public.tenants          enable row level security;
alter table public.tenant_members   enable row level security;
alter table public.customers        enable row level security;
alter table public.drivers          enable row level security;
alter table public.pricing_configs  enable row level security;
alter table public.bookings         enable row level security;
alter table public.payments         enable row level security;
alter table public.trip_tracking    enable row level security;
alter table public.booking_events   enable row level security;

-- tenants: member อ่าน tenant ตัวเองได้
create policy "member reads own tenant" on public.tenants
  for select to authenticated
  using (id in (select public.current_tenant_ids()));

-- tenant_members: เห็นสมาชิกใน tenant ตัวเอง
create policy "member reads own membership" on public.tenant_members
  for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

-- macro-style: ตารางธุรกิจทั้งหมด scope ด้วย tenant_id
create policy "tenant rw customers" on public.customers
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

create policy "tenant rw drivers" on public.drivers
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

create policy "tenant rw pricing" on public.pricing_configs
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

create policy "tenant rw bookings" on public.bookings
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

create policy "tenant rw payments" on public.payments
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

create policy "tenant rw tracking" on public.trip_tracking
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

create policy "tenant reads events" on public.booking_events
  for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

-- =============================================================
-- 10) SEED ตัวอย่าง (Touris Us เป็น tenant #0 — ปรับ/ลบได้)
-- =============================================================
-- insert into public.tenants (name) values ('MedMove Demo') returning id;
-- insert into public.pricing_configs (tenant_id, fuel_price_per_liter, margin_per_km)
--   values ('<tenant_id>', 32.50, 15.0);

-- =============================================================
-- หมายเหตุ Realtime:
--   เปิด Realtime บนตาราง drivers + trip_tracking ใน Supabase Dashboard
--   -> customer LIFF / admin dashboard subscribe ตำแหน่งรถสดได้เลย
--   (แทน Firebase/WebSocket ที่ doc เดิมเสนอ — stack เดียวจบ)
-- =============================================================
