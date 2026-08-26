// =============================================================
// MedMove — Backend entry (Hono/Bun) — ไฟล์รวมพร้อม deploy
// รวม: webhook + bookings + emergency + track + admin + driver + upload-slip
// PromptPay wired เข้ากับ promptpay-qr.ts แล้ว
// deps: bun add hono @supabase/supabase-js promptpay-qr qrcode
// =============================================================
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import {
  flexConfirmBooking, flexPaymentRequest, flexReceipt, flexTracking,
  staticRouteMapUrl,
} from "./flex-messages";
import { buildPromptPayQrUrl, getPromptPayId } from "./promptpay-qr";

// ---------- env ----------
const {
  LINE_CHANNEL_SECRET = "",
  LINE_CHANNEL_ACCESS_TOKEN = "",
  SUPABASE_URL = "",
  SUPABASE_SERVICE_ROLE_KEY = "",
  GOOGLE_MAPS_STATIC_KEY = "",
  ADMIN_LINE_TARGET = "",
  SLIP_VERIFY_URL = "",
  SLIP_VERIFY_TOKEN = "",
  LIFF_UPLOAD_URL = "https://liff.line.me/xxxx/upload",
  LIFF_LIVE_URL = "https://liff.line.me/xxxx/live",
} = process.env;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = new Hono();

app.use("*", cors({
  origin: ["https://medmove-liff.pages.dev"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// ---------- LINE helpers ----------
function verifyLineSignature(body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const hmac = createHmac("sha256", LINE_CHANNEL_SECRET).update(body).digest("base64");
  try { return timingSafeEqual(Buffer.from(hmac), Buffer.from(signature)); }
  catch { return false; }
}
async function linePush(to: string, messages: any[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error("LINE PUSH FAILED", res.status, errBody);
  }
}
async function lineReply(replyToken: string, messages: any[]) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  });
}
async function getLineImage(messageId: string): Promise<Buffer> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  return Buffer.from(await res.arrayBuffer());
}
const flex = (alt: string, contents: any) => ({ type: "flex", altText: alt, contents });
const bkkTime = (d?: string | Date) =>
  new Date(d ?? Date.now()).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =============================================================
// 1) สร้าง booking จาก LIFF  (POST /api/bookings)
// =============================================================
app.post("/api/bookings", async (c) => {
  const b = await c.req.json();
  if (!b.pdpaConsent) return c.json({ error: "ต้องยินยอม PDPA ก่อนจอง" }, 400);

  const { data: customer, error: cErr } = await sb.from("customers").upsert(
    {
      tenant_id: b.tenantId, line_user_id: b.lineUserId, display_name: b.displayName,
      picture_url: b.pictureUrl, phone_number: b.phone,
      pdpa_consent: true, pdpa_consent_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,line_user_id" },
  ).select().single();
  if (cErr) return c.json({ error: cErr.message }, 500);

  const { data: priceRow, error: pErr } = await sb.rpc("calculate_price", {
    p_tenant_id: b.tenantId, p_distance_km: b.distanceKm,
    p_scheduled_at: b.scheduledAt ?? new Date().toISOString(),
  });
  if (pErr) return c.json({ error: pErr.message }, 500);
  const price = Number(priceRow);

  const { data: booking, error: bErr } = await sb.from("bookings").insert({
    tenant_id: b.tenantId, customer_id: customer.id,
    origin_address: b.origin.address, origin_lat: b.origin.lat, origin_lng: b.origin.lng,
    destination_address: b.destination.address, destination_lat: b.destination.lat, destination_lng: b.destination.lng,
    scheduled_at: b.scheduledAt ?? null, distance_km: b.distanceKm, price_calculated: price,
    status: "pending_confirm", patient_count: b.patientCount ?? 1,
    special_equipment: b.specialEquipment, contact_phone: b.phone, notes: b.notes,
    idempotency_key: b.idempotencyKey,
  }).select().single();
  if (bErr) return c.json({ error: bErr.message }, 500);

  const mapUrl = staticRouteMapUrl(b.origin.lat, b.origin.lng, b.destination.lat, b.destination.lng, GOOGLE_MAPS_STATIC_KEY);
  await linePush(b.lineUserId, [flex("ยืนยันการจอง", flexConfirmBooking({
    bookingId: booking.id, mapUrl,
    originAddress: b.origin.address, destAddress: b.destination.address,
    scheduledText: b.scheduledAt ? bkkTime(b.scheduledAt) : "ทันที",
    distanceKm: b.distanceKm, price,
  }))]);

  return c.json({ bookingId: booking.id, price });
});

// =============================================================
// 2) โหมดฉุกเฉิน (POST /api/emergency)
// =============================================================
app.post("/api/emergency", async (c) => {
  const b = await c.req.json();
  const { data: customer } = await sb.from("customers").upsert(
    { tenant_id: b.tenantId, line_user_id: b.lineUserId, display_name: b.displayName, phone_number: b.phone, pdpa_consent: true, pdpa_consent_at: new Date().toISOString() },
    { onConflict: "tenant_id,line_user_id" },
  ).select().single();

  const { data: priceRow } = await sb.rpc("calculate_price", {
    p_tenant_id: b.tenantId, p_distance_km: b.distanceKm, p_scheduled_at: new Date().toISOString(),
  });

  const { data: drivers } = await sb.from("drivers")
    .select("*").eq("tenant_id", b.tenantId).eq("status", "available");
  const nearest = pickNearestDriver(drivers ?? [], b.origin.lat, b.origin.lng);

  const { data: booking } = await sb.from("bookings").insert({
    tenant_id: b.tenantId, customer_id: customer!.id,
    origin_address: b.origin.address, origin_lat: b.origin.lat, origin_lng: b.origin.lng,
    destination_address: b.destination.address, destination_lat: b.destination.lat, destination_lng: b.destination.lng,
    scheduled_at: null, distance_km: b.distanceKm, price_calculated: Number(priceRow),
    status: nearest ? "dispatched" : "confirmed", is_emergency: true, driver_id: nearest?.id ?? null,
    contact_phone: b.phone,
  }).select().single();

  await linePush(ADMIN_LINE_TARGET, [{
    type: "text",
    text: `🚨 เคสด่วน!\nลูกค้า: ${b.displayName} (${b.phone})\nรับที่: ${b.origin.address}\nส่ง: ${b.destination.address}\nคนขับ: ${nearest?.name ?? "⚠️ ยังไม่มีคนว่าง — โทรจัดการด่วน"}`,
  }]);

  return c.json({ bookingId: booking!.id, driver: nearest?.name ?? null, note: "จ่ายเงินภายหลัง" });
});

function pickNearestDriver(drivers: any[], lat: number, lng: number) {
  let best: any = null, bestD = Infinity;
  for (const d of drivers) {
    if (d.current_lat == null || d.current_lng == null) continue;
    const dist = haversineKm(lat, lng, d.current_lat, d.current_lng);
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return best;
}

// =============================================================
// 3) LINE Webhook (POST /webhook)
// =============================================================
app.post("/webhook", async (c) => {
  const raw = await c.req.text();
  if (!verifyLineSignature(raw, c.req.header("x-line-signature"))) return c.text("invalid signature", 401);
  const { events } = JSON.parse(raw);
  queueMicrotask(() => Promise.all(events.map(handleEvent)).catch(console.error));
  return c.text("ok");
});

async function handleEvent(ev: any) {
  if (ev.type === "postback") return handlePostback(ev);
  if (ev.type === "message" && ev.message.type === "image") return handleSlip(ev);
}

async function handlePostback(ev: any) {
  const params = new URLSearchParams(ev.postback.data);
  const action = params.get("action");
  const bookingId = params.get("bookingId")!;
  const { data: booking } = await sb.from("bookings").select("*").eq("id", bookingId).single();
  if (!booking) return;

  if (action === "confirm") {
    await sb.from("bookings").update({ status: "awaiting_payment" }).eq("id", bookingId);
    const promptpayId = await getPromptPayId(booking.tenant_id);
    const qrImageUrl = await buildPromptPayQrUrl(
      { tenantId: booking.tenant_id, promptpayId }, booking.price_calculated, bookingId,
    );
    await linePush(ev.source.userId, [flex("ชำระเงิน", flexPaymentRequest({
      bookingId, qrImageUrl, amount: booking.price_calculated,
      accountName: "MedMove", accountNo: promptpayId, bankName: "PromptPay",
      liffUploadUrl: LIFF_UPLOAD_URL,
    }))]);
    await linePush(ADMIN_LINE_TARGET, [{ type: "text", text: `✅ ลูกค้ายืนยันจอง #${bookingId.slice(0, 8)} รอชำระเงิน` }]);
  }

  if (action === "cancel") {
    await sb.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
    await lineReply(ev.replyToken, [{ type: "text", text: "ยกเลิกการจองแล้ว" }]);
  }
  if (action === "reminder_confirm") {
    await lineReply(ev.replyToken, [{ type: "text", text: "ยืนยันนัดหมายเรียบร้อย แล้วพบกันครับ 🚑" }]);
  }
  if (action === "reschedule") {
    await lineReply(ev.replyToken, [{ type: "text", text: "กรุณาแจ้งวันเวลาที่สะดวก แอดมินจะติดต่อกลับครับ" }]);
    await linePush(ADMIN_LINE_TARGET, [{ type: "text", text: `🕐 ลูกค้าขอเลื่อนนัด #${bookingId.slice(0, 8)}` }]);
  }
}

async function handleSlip(ev: any) {
  const { data: booking } = await sb.from("bookings")
    .select("*, customers!inner(line_user_id)")
    .eq("customers.line_user_id", ev.source.userId)
    .eq("status", "awaiting_payment")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!booking) return;

  const img = await getLineImage(ev.message.id);
  const slipHash = createHash("sha256").update(img).digest("hex");

  const { data: dup } = await sb.from("payments")
    .select("id").eq("tenant_id", booking.tenant_id).eq("slip_hash", slipHash).maybeSingle();
  if (dup) { await lineReply(ev.replyToken, [{ type: "text", text: "⚠️ สลิปนี้ถูกใช้ไปแล้ว กรุณาส่งสลิปที่ถูกต้อง" }]); return; }

  const verify = await verifySlip(img, booking.price_calculated);
  const status = verify.ok ? "verified" : "pending";
  await sb.from("payments").insert({
    tenant_id: booking.tenant_id, booking_id: booking.id, amount: booking.price_calculated,
    slip_hash: slipHash, verification_status: status, raw_verify_response: verify.raw, transaction_ref: verify.ref,
  });

  if (verify.ok) await markPaidAndReceipt(booking, ev);
  else {
    await lineReply(ev.replyToken, [{ type: "text", text: "ได้รับสลิปแล้ว กำลังตรวจสอบ สักครู่นะครับ 🙏" }]);
    await linePush(ADMIN_LINE_TARGET, [{ type: "text", text: `🧾 ต้องตรวจสลิปเอง #${booking.id.slice(0, 8)} ยอด ${booking.price_calculated} — ใช้ Dashboard` }]);
  }
}

async function markPaidAndReceipt(booking: any, ev?: any) {
  await sb.from("bookings").update({ status: "paid" }).eq("id", booking.id);
  const receiptNo = `RC${Date.now().toString(36).toUpperCase()}`;
  const msg = flex("ใบเสร็จรับเงิน", flexReceipt({
    receiptNo, paidAt: bkkTime(), amount: booking.price_calculated,
    originAddress: booking.origin_address, destAddress: booking.destination_address,
    scheduledText: booking.scheduled_at ? bkkTime(booking.scheduled_at) : "ทันที",
  }));
  const uid = booking.customers?.line_user_id;
  if (ev) await lineReply(ev.replyToken, [msg]);
  else if (uid) await linePush(uid, [msg]);
}

async function verifySlip(img: Buffer, expectedAmount: number): Promise<{ ok: boolean; ref?: string; raw?: any }> {
  if (!SLIP_VERIFY_URL) return { ok: false, raw: { reason: "no_api_configured" } };
  try {
    const res = await fetch(SLIP_VERIFY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SLIP_VERIFY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: img.toString("base64") }),
    });
    const raw = await res.json();
    const amountOk = Math.abs(Number(raw?.amount ?? 0) - expectedAmount) < 1;
    return { ok: res.ok && amountOk, ref: raw?.transRef, raw };
  } catch (e) { return { ok: false, raw: { error: String(e) } }; }
}

// admin ตรวจสลิปเอง (POST /api/admin/verify-slip)
app.post("/api/admin/verify-slip", async (c) => {
  const { bookingId, adminUserId, approve } = await c.req.json();
  const { data: booking } = await sb.from("bookings").select("*, customers(line_user_id)").eq("id", bookingId).single();
  if (!booking) return c.json({ error: "not found" }, 404);

  await sb.from("payments").update({
    verification_status: approve ? "manual_verified" : "rejected",
    verified_by: adminUserId, verified_at: new Date().toISOString(),
  }).eq("booking_id", bookingId);

  if (approve) await markPaidAndReceipt(booking);
  else await linePush(booking.customers.line_user_id, [{ type: "text", text: "สลิปไม่ถูกต้อง กรุณาส่งใหม่อีกครั้งครับ" }]);
  return c.json({ ok: true });
});

// =============================================================
// 4) Driver GPS ping + geofence (POST /api/track)
// =============================================================
app.post("/api/track", async (c) => {
  const { bookingId, lat, lng, accuracy, speed } = await c.req.json();
  const { data: bk } = await sb.from("bookings").select("*, drivers(*), customers(line_user_id)").eq("id", bookingId).single();
  if (!bk) return c.json({ error: "not found" }, 404);

  const { data: t } = await sb.from("trip_tracking").select("*").eq("booking_id", bookingId).maybeSingle();
  const route = (t?.route ?? []) as number[][];
  route.push([Date.now(), lat, lng, accuracy, speed]);

  await sb.from("trip_tracking").upsert({
    booking_id: bookingId, tenant_id: bk.tenant_id,
    started_at: t?.started_at ?? new Date().toISOString(),
    point_count: route.length, last_lat: lat, last_lng: lng,
    last_accuracy: accuracy, last_speed: speed, route,
  });
  if (bk.driver_id)
    await sb.from("drivers").update({ current_lat: lat, current_lng: lng, last_seen_at: new Date().toISOString() }).eq("id", bk.driver_id);

  const distToPickup = haversineKm(lat, lng, bk.origin_lat, bk.origin_lng);
  if (distToPickup <= 5 && !t?.geofence_5km_notified) {
    await sb.from("trip_tracking").update({ geofence_5km_notified: true }).eq("booking_id", bookingId);
    await sb.from("bookings").update({ status: "en_route" }).eq("id", bookingId);
    await notifyTracking(bk, lat, lng, "approaching");
  } else if (distToPickup <= 1 && !t?.geofence_1km_notified) {
    await sb.from("trip_tracking").update({ geofence_1km_notified: true }).eq("booking_id", bookingId);
    await notifyTracking(bk, lat, lng, "near");
  }
  return c.json({ ok: true, distToPickup: distToPickup.toFixed(2) });
});

async function notifyTracking(bk: any, lat: number, lng: number, stage: "approaching" | "near" | "arrived") {
  const mapUrl = staticRouteMapUrl(lat, lng, bk.origin_lat, bk.origin_lng, GOOGLE_MAPS_STATIC_KEY);
  await linePush(bk.customers.line_user_id, [flex("รถกำลังมารับ", flexTracking({
    mapUrl, driverName: bk.drivers?.name ?? "คนขับ", vehiclePlate: bk.drivers?.vehicle_plate ?? "-",
    etaText: stage === "near" ? "ไม่เกิน 5 นาที" : "ประมาณ 10-15 นาที",
    liffLiveUrl: `${LIFF_LIVE_URL}?bookingId=${bk.id}`, stage,
  }))]);
}

// =============================================================
// 5) รับสลิปจาก LIFF (POST /api/upload-slip)
// =============================================================
app.post("/api/upload-slip", async (c) => {
  const { bookingId, imageBase64 } = await c.req.json();
  if (!bookingId || !imageBase64) return c.json({ error: "ข้อมูลไม่ครบ" }, 400);

  const { data: booking } = await sb.from("bookings").select("*, customers(line_user_id)").eq("id", bookingId).single();
  if (!booking) return c.json({ error: "ไม่พบการจอง" }, 404);
  if (booking.status === "paid") return c.json({ status: "verified", note: "ชำระแล้ว" });

  const b64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
  const img = Buffer.from(b64, "base64");
  const slipHash = createHash("sha256").update(img).digest("hex");

  const { data: dup } = await sb.from("payments")
    .select("id").eq("tenant_id", booking.tenant_id).eq("slip_hash", slipHash).maybeSingle();
  if (dup) return c.json({ error: "สลิปนี้ถูกใช้ไปแล้ว" }, 409);

  const path = `${booking.tenant_id}/${bookingId}.jpg`;
  await sb.storage.from("payment-slips").upload(path, img, { contentType: "image/jpeg", upsert: true });

  const verify = await verifySlip(img, booking.price_calculated);
  const status = verify.ok ? "verified" : "pending";
  await sb.from("payments").insert({
    tenant_id: booking.tenant_id, booking_id: booking.id, amount: booking.price_calculated,
    slip_image_url: path, slip_hash: slipHash, verification_status: status,
    raw_verify_response: verify.raw, transaction_ref: verify.ref,
  });

  if (verify.ok) await markPaidAndReceipt(booking);
  else await linePush(ADMIN_LINE_TARGET, [{ type: "text", text: `🧾 ต้องตรวจสลิปเอง #${bookingId.slice(0, 8)} ยอด ${booking.price_calculated} — Dashboard` }]);
  return c.json({ status });
});

// =============================================================
// 6) สถานะ tracking ให้แผนที่สด (GET /api/track-status)
// =============================================================
app.get("/api/track-status", async (c) => {
  const bookingId = c.req.query("bookingId");
  if (!bookingId) return c.json({ error: "ไม่พบรหัสการจอง" }, 400);

  const { data: bk } = await sb.from("bookings")
    .select("status, origin_lat, origin_lng, drivers(name, vehicle_plate, current_lat, current_lng)")
    .eq("id", bookingId).single();
  if (!bk) return c.json({ error: "ไม่พบการจอง" }, 404);

  const drv = (bk as any).drivers;
  let distToPickupKm: number | null = null, etaText = "—";
  if (drv?.current_lat != null) {
    distToPickupKm = haversineKm(drv.current_lat, drv.current_lng, bk.origin_lat, bk.origin_lng);
    const mins = Math.max(1, Math.round((distToPickupKm / 30) * 60));
    etaText = distToPickupKm <= 0.3 ? "ถึงแล้ว" : `~${mins} นาที`;
  }
  return c.json({
    status: bk.status,
    pickup: { lat: bk.origin_lat, lng: bk.origin_lng },
    driver: drv ? { name: drv.name, plate: drv.vehicle_plate, lat: drv.current_lat, lng: drv.current_lng } : null,
    distToPickupKm, etaText,
  });
});

// =============================================================
// 7) Driver endpoints
// =============================================================
app.get("/api/driver/active", async (c) => {
  const driverId = c.req.query("driverId");
  if (!driverId) return c.json([], 200);
  const { data, error } = await sb.from("bookings")
    .select("id, status, origin_address, destination_address, contact_phone, scheduled_at, customers(display_name)")
    .eq("driver_id", driverId).in("status", ["dispatched", "en_route", "arrived"])
    .order("scheduled_at", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json((data ?? []).map((b: any) => ({
    id: b.id, status: b.status, origin_address: b.origin_address, destination_address: b.destination_address,
    contact_phone: b.contact_phone, customer_name: b.customers?.display_name,
  })));
});

app.post("/api/driver/arrived", async (c) => {
  const { bookingId } = await c.req.json();
  const { data: bk } = await sb.from("bookings").select("customers(line_user_id)").eq("id", bookingId).single();
  await sb.from("bookings").update({ status: "arrived" }).eq("id", bookingId);
  const uid = (bk as any)?.customers?.line_user_id;
  if (uid) await linePush(uid, [{ type: "text", text: "🚑 รถถึงจุดรับแล้ว กรุณาเตรียมพร้อมครับ" }]);
  return c.json({ ok: true });
});

app.post("/api/driver/complete", async (c) => {
  const { bookingId, driverId } = await c.req.json();
  const { data: bk } = await sb.from("bookings").select("customers(line_user_id)").eq("id", bookingId).single();
  await sb.from("bookings").update({ status: "completed" }).eq("id", bookingId);
  await sb.from("trip_tracking").update({ ended_at: new Date().toISOString() }).eq("booking_id", bookingId);
  if (driverId) await sb.from("drivers").update({ status: "available" }).eq("id", driverId);
  const uid = (bk as any)?.customers?.line_user_id;
  if (uid) await linePush(uid, [{ type: "text", text: "✅ ถึงปลายทางเรียบร้อย ขอบคุณที่ใช้บริการ MedMove 🙏" }]);
  return c.json({ ok: true });
});

// =============================================================
// 8) Admin endpoints
// =============================================================
app.post("/api/admin/dispatch", async (c) => {
  const { bookingId, driverId } = await c.req.json();
  if (!bookingId || !driverId) return c.json({ error: "ข้อมูลไม่ครบ" }, 400);
  const { data: bk } = await sb.from("bookings").select("status, customers(line_user_id)").eq("id", bookingId).single();
  if (!bk) return c.json({ error: "ไม่พบการจอง" }, 404);
  if (bk.status !== "paid" && bk.status !== "confirmed") return c.json({ error: `จ่ายงานไม่ได้ (สถานะ: ${bk.status})` }, 409);

  const { data: drv } = await sb.from("drivers").select("name, vehicle_plate").eq("id", driverId).single();
  if (!drv) return c.json({ error: "ไม่พบคนขับ" }, 404);

  await sb.from("bookings").update({ driver_id: driverId, status: "dispatched" }).eq("id", bookingId);
  await sb.from("drivers").update({ status: "on_trip" }).eq("id", driverId);
  const uid = (bk as any).customers?.line_user_id;
  if (uid) await linePush(uid, [{ type: "text", text: `🚑 จัดรถให้เรียบร้อยแล้ว\nคนขับ: ${drv.name} (${drv.vehicle_plate})\nกำลังเตรียมออกเดินทางไปรับ` }]);
  return c.json({ ok: true });
});

app.post("/api/admin/cancel", async (c) => {
  const { bookingId, reason } = await c.req.json();
  if (!bookingId) return c.json({ error: "ไม่พบรหัสการจอง" }, 400);
  const { data: bk } = await sb.from("bookings").select("driver_id, customers(line_user_id)").eq("id", bookingId).single();
  if (!bk) return c.json({ error: "ไม่พบการจอง" }, 404);
  await sb.from("bookings").update({ status: "cancelled" }).eq("id", bookingId);
  if (bk.driver_id) await sb.from("drivers").update({ status: "available" }).eq("id", bk.driver_id);
  const uid = (bk as any).customers?.line_user_id;
  if (uid) await linePush(uid, [{ type: "text", text: `การจองถูกยกเลิก${reason ? `\nเหตุผล: ${reason}` : ""}\nหากมีข้อสงสัยติดต่อเจ้าหน้าที่ได้เลยครับ` }]);
  return c.json({ ok: true });
});

app.get("/health", (c) => c.text("ok"));

export default app;
