import "./env.js";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { bot, startTelegram, stopTelegram, invalidateVeCache } from "./bot.js";
import { getSeats, isValidLayout, loadSeats, saveSeats, syncPublicConfig } from "./seats-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECOM_DIR = join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Save-Key");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/seats", (_req, res) => {
  const seats = getSeats();
  if (!seats) {
    res.status(503).json({ error: "Chưa tải được sơ đồ" });
    return;
  }
  res.json(seats);
});

app.post("/api/seats", async (req, res) => {
  try {
    if (!isValidLayout(req.body)) {
      res.status(400).json({ error: "Thiếu groups trong sơ đồ" });
      return;
    }
    await saveSeats(req.body);
    invalidateVeCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message || "Lưu sơ đồ thất bại" });
  }
});

if (bot) {
  app.use(bot.webhookCallback("/telegram-webhook"));
}

app.use((req, res, next) => {
  if (req.path === "/bot" || req.path.startsWith("/bot/")) {
    res.status(404).end();
    return;
  }
  next();
});

app.use(express.static(VECOM_DIR, { index: "index.html", extensions: ["html"] }));

const server = createServer(app);

await loadSeats();

server.listen(PORT, async () => {
  console.log(`Vecom server http://127.0.0.1:${PORT}`);
  try {
    await startTelegram(publicUrl);
  } catch (err) {
    console.error("Không khởi động Telegram:", err.message);
  }
  if (publicUrl) {
    await syncPublicConfig(publicUrl);
  } else {
    console.log("Chưa có PUBLIC_URL — trang GitHub Pages chưa tự gắn API. Máy local: http://127.0.0.1:" + PORT);
  }
});

async function shutdown(signal) {
  console.log(signal);
  try { await stopTelegram(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
