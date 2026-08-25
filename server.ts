// server.ts — entrypoint สำหรับ Render (Node runtime)
// ใช้ @hono/node-server แทน Bun.serve — เสถียรกว่าบน Render free tier
import { serve } from "@hono/node-server";
import app from "./index";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`MedMove backend listening on :${info.port}`);
});