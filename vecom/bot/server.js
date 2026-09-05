import "./env.js";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { bot, startTelegram, stopTelegram, invalidateVeCache } from "./bot.js";
import { fetchCaptureData } from "./capture-data.js";
import { getSeats, isValidLayout, loadSeats, saveSeats, syncPublicConfig } from "./seats-store.js";
import {
  loadFund,
  getFund,
  replaceFund,
  addMember,
  removeMember,
  addTransaction,
  updateSettings,
  fundTotal,
  memberBalances,
  monthStatus,
  monthKey,
  findMember,
  parseAmount
} from "./quy-store.js";
import { quyBot, startQuyBot, stopQuyBot } from "./quy-bot.js";
import { syncQuyConfig } from "./quy-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECOM_DIR = join(__dirname, "..");
const QUY_DIR = join(__dirname, "..", "..", "quy");
const PORT = Number(process.env.PORT) || 3000;
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
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

function fundPayload(fund) {
  const month = monthKey();
  return {
    ok: true,
    fund,
    total: fundTotal(fund),
    balances: memberBalances(fund),
    month,
    monthStatus: monthStatus(fund, month)
  };
}

app.get("/api/quy", async (_req, res) => {
  try {
    const fund = getFund() || (await loadFund());
    res.json(fundPayload(fund));
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message || "Chưa tải được quỹ" });
  }
});

app.put("/api/quy", async (req, res) => {
  try {
    const fund = await replaceFund(req.body?.fund || req.body);
    res.json(fundPayload(fund));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Lưu quỹ thất bại" });
  }
});

app.post("/api/quy/members", async (req, res) => {
  try {
    const fund = await addMember(req.body?.name, req.body?.by || "web");
    res.json(fundPayload(fund));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Thêm thành viên thất bại" });
  }
});

app.delete("/api/quy/members/:id", async (req, res) => {
  try {
    const fund = await removeMember(req.params.id);
    res.json(fundPayload(fund));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Xóa thành viên thất bại" });
  }
});

app.post("/api/quy/transactions", async (req, res) => {
  try {
    const body = req.body || {};
    let memberId = body.memberId || null;
    if (!memberId && body.memberName) {
      const fund = await loadFund();
      const m = findMember(fund, body.memberName);
      if (!m) {
        res.status(400).json({ ok: false, error: "Không tìm thấy thành viên" });
        return;
      }
      memberId = m.id;
    }
    const amount = body.amount != null ? Number(body.amount) : parseAmount(body.amountRaw);
    const { fund, tx } = await addTransaction({
      type: body.type,
      memberId,
      amount,
      note: body.note || "",
      by: body.by || "web",
      month: body.month || null
    });
    res.json({ ...fundPayload(fund), tx });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Ghi giao dịch thất bại" });
  }
});

app.patch("/api/quy/settings", async (req, res) => {
  try {
    const fund = await updateSettings(req.body || {}, "web");
    res.json(fundPayload(fund));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "Cập nhật cài đặt thất bại" });
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

if (quyBot) {
  app.post("/quy-telegram-webhook", (req, res) => {
    res.sendStatus(200);
    quyBot.handleUpdate(req.body).catch((err) => {
      console.error("Quy Telegram update:", err);
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

app.use("/quy", express.static(QUY_DIR, { index: "index.html", extensions: ["html"] }));
app.use(express.static(VECOM_DIR, { index: "index.html", extensions: ["html"] }));

const server = createServer(app);

server.listen(PORT, () => {
  console.log(`Vecom server http://127.0.0.1:${PORT}`);
  console.log(`Quỹ nhóm http://127.0.0.1:${PORT}/quy/`);
  loadSeats().catch((err) => console.error("Không tải seats.json:", err.message));
  loadFund().catch((err) => console.error("Không tải fund.json:", err.message));
  startTelegram(publicUrl)
    .then(() => startQuyBot(publicUrl, bot))
    .catch((err) => console.error("Không khởi động Telegram:", err.message));
  if (publicUrl) {
    syncPublicConfig(publicUrl).catch((err) => console.error("Không gắn config.json:", err.message));
    syncQuyConfig(publicUrl).catch((err) => console.error("Không gắn quy/config.json:", err.message));
    setInterval(() => {
      fetch(`${publicUrl}/health`).catch(() => {});
    }, 8 * 60 * 1000);
  }
});

async function shutdown(signal) {
  console.log(signal);
  try {
    await stopQuyBot();
  } catch {
    /* ignore */
  }
  try {
    await stopTelegram();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
}

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
