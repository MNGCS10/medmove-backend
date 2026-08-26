// =============================================================
// MedMove — PromptPay QR generator + upload -> Supabase Storage
// deps: npm i promptpay-qr qrcode @supabase/supabase-js
// เติมแทน stub buildPromptPayQrUrl() ใน webhook.ts
// =============================================================
import generatePayload from "promptpay-qr";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const QR_BUCKET = "qr-codes";  // public bucket

// PromptPay target ต่อ tenant (เบอร์พร้อมเพย์ / เลขบัตร ปชช. / e-wallet)
// จริง ๆ ควรอ่านจาก config ต่อ tenant — ที่นี่รับเข้ามาตรง
type PromptPayTarget = { tenantId: string; promptpayId: string };

/**
 * สร้าง QR PromptPay ผูกยอดเงิน แล้ว upload เป็น PNG คืน public URL
 * cache ต่อ booking (ถ้ามีแล้วไม่ generate ซ้ำ)
 */
export async function buildPromptPayQrUrl(
  target: PromptPayTarget,
  amount: number,
  bookingId: string,
): Promise<string> {
  const path = `${target.tenantId}/${bookingId}.png`;

  // ถ้ามีอยู่แล้ว คืน url เดิม
  const { data: existing } = await sb.storage.from(QR_BUCKET).list(target.tenantId, {
    search: `${bookingId}.png`,
  });
  if (existing?.some((f) => f.name === `${bookingId}.png`)) {
    return sb.storage.from(QR_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // 1) payload EMVCo ผูกยอด (กันกรอกยอดผิด)
  const payload = generatePayload(target.promptpayId, { amount });

  // 2) render PNG buffer
  const png = await QRCode.toBuffer(payload, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
  });

  // 3) upload
  const { error } = await sb.storage.from(QR_BUCKET).upload(path, png, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) throw new Error(`QR upload failed: ${error.message}`);

  return sb.storage.from(QR_BUCKET).getPublicUrl(path).data.publicUrl;
}

// helper: เช็คว่า tenant เปิดใช้ PromptPay ไว้ไหม (ตั้งผ่าน admin.html → ตั้งค่า)
export async function isPromptPayEnabled(tenantId: string): Promise<boolean> {
  const { data } = await sb
    .from("tenant_settings")
    .select("promptpay_enabled, promptpay_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return Boolean(data?.promptpay_enabled && data?.promptpay_id);
}

// helper: ดึง promptpay id ของ tenant จาก tenant_settings (แก้ผ่านหน้า admin ได้ ไม่ต้อง redeploy)
export async function getPromptPayId(tenantId: string): Promise<string> {
  const { data } = await sb
    .from("tenant_settings")
    .select("promptpay_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  // fallback env ไว้เผื่อยังไม่ได้ตั้งผ่านหน้า admin (dev/migration ช่วงแรก)
  return data?.promptpay_id ?? process.env.PROMPTPAY_ID ?? "0000000000";
}
