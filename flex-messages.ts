// =============================================================
// MedMove — LINE Flex Message builders (5 ขั้นตอน)
// ใช้กับ @line/bot-sdk หรือ Messaging API ตรง ๆ
// ทุก action ใช้ postback เพื่อส่ง bookingId กลับ webhook
// =============================================================

type FlexBubble = Record<string, any>;

const BRAND = "#C62828";      // แดงรถพยาบาล
const MUTED = "#8A8A8A";
const OK = "#2E7D32";

const baht = (n: number) =>
  new Intl.NumberFormat("th-TH", { minimumFractionDigits: 0 }).format(Math.round(n));

function row(label: string, value: string): FlexBubble {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: MUTED, size: "sm", flex: 2 },
      { type: "text", text: value, wrap: true, color: "#333333", size: "sm", flex: 5 },
    ],
  };
}

// Google Static Map แสดงเส้นทางต้นทาง-ปลายทาง (ต้องมี GOOGLE_MAPS_STATIC_KEY)
export function staticRouteMapUrl(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
  key: string,
): string {
  const base = "https://maps.googleapis.com/maps/api/staticmap";
  const o = `${originLat},${originLng}`;
  const d = `${destLat},${destLng}`;
  const params = new URLSearchParams();
  params.set("size", "600x360");
  params.append("markers", `color:green|label:A|${o}`);
  params.append("markers", `color:red|label:B|${d}`);
  params.append("path", `color:0xC62828ff|weight:4|${o}|${d}`);
  params.set("key", key);
  return `${base}?${params.toString()}`;
}

// -------------------------------------------------------------
// ขั้น 1: ยืนยันการจอง + ราคา (postback: confirm / cancel)
// -------------------------------------------------------------
export function flexConfirmBooking(p: {
  bookingId: string;
  mapUrl: string;
  originAddress: string;
  destAddress: string;
  scheduledText: string;
  distanceKm: number;
  price: number;
  isEmergency?: boolean;
}): FlexBubble {
  return {
    type: "bubble",
    hero: {
      type: "image",
      url: p.mapUrl,
      size: "full",
      aspectRatio: "20:12",
      aspectMode: "cover",
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "text",
          text: p.isEmergency ? "🚨 ยืนยันเรียกรถด่วน" : "🚑 ยืนยันการจองรถ",
          weight: "bold",
          size: "lg",
          color: BRAND,
        },
        { type: "separator" },
        row("📍 ต้นทาง", p.originAddress),
        row("🏁 ปลายทาง", p.destAddress),
        row("📅 วันเวลา", p.scheduledText),
        row("📏 ระยะทาง", `${p.distanceKm.toFixed(1)} กม.`),
        { type: "separator" },
        {
          type: "box",
          layout: "baseline",
          contents: [
            { type: "text", text: "💰 ค่าบริการ", color: MUTED, size: "md", flex: 3 },
            {
              type: "text", text: `${baht(p.price)} บาท`, weight: "bold",
              size: "xl", color: BRAND, align: "end", flex: 4,
            },
          ],
        },
        { type: "text", text: "*ราคาโดยประมาณ อาจปรับตามหน้างาน", size: "xxs", color: MUTED },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: BRAND,
          action: {
            type: "postback",
            label: "✅ ยืนยันจอง",
            data: `action=confirm&bookingId=${p.bookingId}`,
            displayText: "ยืนยันการจอง",
          },
        },
        {
          type: "button",
          style: "secondary",
          action: {
            type: "postback",
            label: "❌ ยกเลิก",
            data: `action=cancel&bookingId=${p.bookingId}`,
            displayText: "ยกเลิกการจอง",
          },
        },
      ],
    },
  };
}

// -------------------------------------------------------------
// ขั้น 2: แจ้งเลขบัญชี / PromptPay QR (dynamic — ผูกยอดในตัว QR)
// -------------------------------------------------------------
export function flexPaymentRequest(p: {
  bookingId: string;
  qrImageUrl: string;      // สร้างจาก promptpay-qr แล้ว host เป็นรูป
  amount: number;
  accountName: string;
  accountNo: string;
  bankName: string;
  liffUploadUrl: string;   // LIFF แนบสลิป
}): FlexBubble {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "ชำระค่าบริการ", weight: "bold", size: "lg", color: BRAND },
        {
          type: "text",
          text: `${baht(p.amount)} บาท`,
          weight: "bold", size: "3xl", align: "center", color: BRAND,
        },
        {
          type: "image",
          url: p.qrImageUrl,
          size: "full",
          aspectRatio: "1:1",
          aspectMode: "fit",
        },
        { type: "text", text: "สแกน PromptPay ด้วยแอปธนาคาร", size: "sm", color: MUTED, align: "center" },
        { type: "separator" },
        row("ธนาคาร", p.bankName),
        row("ชื่อบัญชี", p.accountName),
        row("เลขบัญชี", p.accountNo),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          color: BRAND,
          action: {
            type: "uri",
            label: "📎 แนบสลิปโอนเงิน",
            uri: `${p.liffUploadUrl}?bookingId=${p.bookingId}`,
          },
        },
        { type: "text", text: "หรือส่งรูปสลิปเข้าแชทนี้ได้เลย", size: "xs", color: MUTED, align: "center", margin: "sm" },
      ],
    },
  };
}

// -------------------------------------------------------------
// ขั้น 2b: ขอชำระเงินแบบไม่มี QR (กรณีปิด PromptPay ไว้ในหน้าตั้งค่า)
// -------------------------------------------------------------
export function flexPaymentRequestManual(p: {
  bookingId: string;
  amount: number;
  liffUploadUrl: string;
  note?: string; // ข้อความแจ้งช่องทางโอน ถ้าไม่ใส่จะบอกให้ติดต่อแอดมิน
}): FlexBubble {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "ชำระค่าบริการ", weight: "bold", size: "lg", color: BRAND },
        {
          type: "text",
          text: `${baht(p.amount)} บาท`,
          weight: "bold", size: "3xl", align: "center", color: BRAND,
        },
        { type: "separator" },
        {
          type: "text",
          text: p.note || "กรุณาติดต่อแอดมินเพื่อขอช่องทางการโอนเงิน",
          size: "sm", color: MUTED, wrap: true,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          color: BRAND,
          action: {
            type: "uri",
            label: "📎 แนบสลิปโอนเงิน",
            uri: `${p.liffUploadUrl}?bookingId=${p.bookingId}`,
          },
        },
        { type: "text", text: "หรือส่งรูปสลิปเข้าแชทนี้ได้เลย", size: "xs", color: MUTED, align: "center", margin: "sm" },
      ],
    },
  };
}

// -------------------------------------------------------------
// ขั้น 3: ใบเสร็จ / Invoice (หลังสลิปผ่าน)
// -------------------------------------------------------------
export function flexReceipt(p: {
  receiptNo: string;
  paidAt: string;
  amount: number;
  originAddress: string;
  destAddress: string;
  scheduledText: string;
}): FlexBubble {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "box", layout: "vertical", contents: [
            { type: "text", text: "✅ ชำระเงินสำเร็จ", weight: "bold", size: "lg", color: OK, align: "center" },
            { type: "text", text: `ใบเสร็จเลขที่ ${p.receiptNo}`, size: "xs", color: MUTED, align: "center" },
          ],
        },
        { type: "separator" },
        row("รายการ", "บริการรถพยาบาล"),
        row("ต้นทาง", p.originAddress),
        row("ปลายทาง", p.destAddress),
        row("วันเวลา", p.scheduledText),
        row("ชำระเมื่อ", p.paidAt),
        { type: "separator" },
        {
          type: "box", layout: "baseline", contents: [
            { type: "text", text: "ยอดชำระ", size: "md", flex: 3, color: MUTED },
            { type: "text", text: `${baht(p.amount)} บาท`, weight: "bold", size: "lg", align: "end", flex: 4, color: OK },
          ],
        },
      ],
    },
  };
}

// -------------------------------------------------------------
// ขั้น 4: เตือนก่อนวันนัด 1 วัน (ยืนยัน / เลื่อน / ยกเลิก)
// -------------------------------------------------------------
export function flexReminder(p: {
  bookingId: string;
  scheduledText: string;
  originAddress: string;
  destAddress: string;
}): FlexBubble {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "⏰ ยืนยันนัดหมายพรุ่งนี้", weight: "bold", size: "lg", color: BRAND },
        { type: "separator" },
        row("📅 วันเวลา", p.scheduledText),
        row("📍 ต้นทาง", p.originAddress),
        row("🏁 ปลายทาง", p.destAddress),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button", style: "primary", color: OK,
          action: { type: "postback", label: "✅ ยืนยันนัด", data: `action=reminder_confirm&bookingId=${p.bookingId}`, displayText: "ยืนยันนัดหมาย" },
        },
        {
          type: "button", style: "secondary",
          action: { type: "postback", label: "🕐 ขอเลื่อนนัด", data: `action=reschedule&bookingId=${p.bookingId}`, displayText: "ขอเลื่อนนัด" },
        },
        {
          type: "button", style: "secondary",
          action: { type: "postback", label: "❌ ยกเลิก", data: `action=cancel&bookingId=${p.bookingId}`, displayText: "ยกเลิกนัด" },
        },
      ],
    },
  };
}

// -------------------------------------------------------------
// ขั้น 5: รถกำลังเดินทางมารับ (geofence 5 กม. / 1 กม. / ถึงแล้ว)
// -------------------------------------------------------------
export function flexTracking(p: {
  mapUrl: string;          // static map ตำแหน่งรถปัจจุบัน + จุดรับ
  driverName: string;
  vehiclePlate: string;
  etaText: string;
  liffLiveUrl: string;     // LIFF แผนที่สด
  stage: "approaching" | "near" | "arrived";
}): FlexBubble {
  const title =
    p.stage === "arrived" ? "🚑 รถถึงจุดรับแล้ว"
    : p.stage === "near"  ? "🚑 รถใกล้ถึง (< 1 กม.)"
    : "🚑 รถกำลังเดินทางมารับ";
  return {
    type: "bubble",
    hero: { type: "image", url: p.mapUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: title, weight: "bold", size: "lg", color: BRAND },
        row("คนขับ", p.driverName),
        row("ทะเบียน", p.vehiclePlate),
        row("ถึงใน", p.etaText),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button", style: "primary", color: BRAND,
          action: { type: "uri", label: "📍 ดูตำแหน่งสด", uri: p.liffLiveUrl },
        },
      ],
    },
  };
}
