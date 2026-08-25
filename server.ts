// server.ts — entrypoint สำหรับ Render/Bun (เปิดพอร์ตจาก env PORT)
import app from "./index";

const port = Number(process.env.PORT ?? 3000);
console.log(`MedMove backend listening on :${port}`);

export default { port, fetch: app.fetch };
