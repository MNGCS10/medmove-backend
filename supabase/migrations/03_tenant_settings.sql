-- =============================================================
-- MedMove — Tenant Settings (PromptPay on/off + account)
-- แยกจาก pricing_configs เพราะไม่ผูกกับ effective_date/versioning
-- =============================================================

create table if not exists public.tenant_settings (
  tenant_id           uuid primary key references public.tenants(id) on delete cascade,
  promptpay_id        text,                          -- เบอร์พร้อมเพย์ / เลขบัตร ปชช. / เลขนิติบุคคล
  promptpay_enabled   boolean not null default false, -- ปิดไว้ก่อนจนกว่าแอดมินจะกรอกและเปิดเอง
  updated_at          timestamptz not null default now()
);

create trigger trg_tenant_settings_updated before update on public.tenant_settings
  for each row execute function public.set_updated_at();

alter table public.tenant_settings enable row level security;

create policy "tenant rw settings" on public.tenant_settings
  for all to authenticated
  using (tenant_id in (select public.current_tenant_ids()))
  with check (tenant_id in (select public.current_tenant_ids()));

-- seed แถวเปล่าให้ทุก tenant ที่มีอยู่แล้ว (กันกรณี admin.html query ไม่เจอแถว)
insert into public.tenant_settings (tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;
