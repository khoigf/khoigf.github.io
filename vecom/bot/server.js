import "./env.js";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { bot, startTelegram, stopTelegram, invalidateVeCache } from "./bot.js";
import { fetchCaptureData } from "./capture-data.js";
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

app.get("/api/capture-data", async (req, res) => {
  const date = String(req.query.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ ok: false, error: "Thiếu date=YYYY-MM-DD" });
    return;
  }
  try {
    res.json(await fetchCaptureData(date));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || "Không lấy được đơn" });
  }
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
  app.post("/telegram-webhook", (req, res) => {
    res.sendStatus(200);
    bot.handleUpdate(req.body).catch((err) => {
      console.error("Telegram update:", err);
    });
  });
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

server.listen(PORT, () => {
  console.log(`Vecom server http://127.0.0.1:${PORT}`);
  loadSeats().catch((err) => console.error("Không tải seats.json:", err.message));
  startTelegram(publicUrl).catch((err) => console.error("Không khởi động Telegram:", err.message));
  if (publicUrl) {
    syncPublicConfig(publicUrl).catch((err) => console.error("Không gắn config.json:", err.message));
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, 8 * 60 * 1000);
  }
});

async function shutdown(signal) {
  console.log(signal);
  try { await stopTelegram(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
}

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
