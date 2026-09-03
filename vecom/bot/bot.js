import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { Telegraf } from "telegraf";
import { chromium } from "playwright";
import cron from "node-cron";
import { fetchCaptureData } from "./capture-data.js";
import { readGithubJson, writeGithubJson } from "./seats-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT = process.env.TELEGRAM_CHAT_ID;
const TZ = process.env.TZ || "Asia/Ho_Chi_Minh";
const SCHEDULE_FILE = join(__dirname, "schedule.json");

export const bot = TOKEN ? new Telegraf(TOKEN) : null;
let cronTask = null;
let sharedBrowser = null;
let browserIdleTimer = 0;
const vePngCache = new Map();
const veInflight = new Map();
const VE_CACHE_MS = Number(process.env.VE_CACHE_MS) || 90_000;
const BROWSER_IDLE_MS = 20 * 60_000;

const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--mute-audio",
  "--hide-scrollbars"
];

function vecomBase() {
  const explicit = process.env.VECOM_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const port = process.env.PORT || 3000;
  return `http://127.0.0.1:${port}`;
}

function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatLabel(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** /ve | /ve 28/06/2026 | /ve-28/06/2026 | /ve 2026-06-28 */
function parseVeDate(text) {
  const raw = String(text || "").trim();
  const body = raw.replace(/^\/ve(?:@\w+)?/i, "").replace(/^[\s-_]+/, "").trim();
  if (!body) return todayISO();
  let m = body.match(/^(\d{1,2})[/.\\-](\d{1,2})[/.\\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = body.match(/^(\d{4})[/.\\-](\d{1,2})[/.\\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

const SCHEDULE_GH_PATH = "vecom/bot/schedule.json";

function readSchedule() {
  try {
    if (!existsSync(SCHEDULE_FILE)) return null;
    return JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeSchedule(data) {
  writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
  writeGithubJson(SCHEDULE_GH_PATH, data, "chore: cập nhật lịch gửi vé cơm").catch((err) => {
    console.error("Không lưu lịch lên GitHub:", err.message);
  });
}

async function restoreSchedule() {
  try {
    const remote = await readGithubJson(SCHEDULE_GH_PATH);
    if (remote && remote.expr) {
      writeFileSync(SCHEDULE_FILE, JSON.stringify(remote, null, 2));
      return remote;
    }
  } catch (err) {
    console.error("Không đọc lịch từ GitHub:", err.message);
  }
  return readSchedule();
}

function parseLich(text) {
  const body = String(text || "").replace(/^\/lich(?:@\w+)?/i, "").trim().toLowerCase();
  if (!body) return { show: true };
  if (["off", "stop", "huy", "tắt"].includes(body)) return { off: true };
  const m = body.match(/^(\d{1,2}):(\d{2})(?:\s+(cn|7|\*))?$/i);
  if (!m) return { error: true };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return { error: true };
  const everyday = !!m[3];
  const expr = `${minute} ${hour} * * ${everyday ? "*" : "1-5"}`;
  const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (${everyday ? "cả tuần" : "T2–T6"})`;
  return { expr, label, hour, minute, everyday };
}

function applySchedule(saved) {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  if (!saved?.expr) return;
  if (!cron.validate(saved.expr)) return;
  cronTask = cron.schedule(
    saved.expr,
    () => {
      const chat = saved.chatId || DEFAULT_CHAT;
      if (!chat) {
        console.error("Lịch chạy nhưng chưa có TELEGRAM_CHAT_ID / chatId");
        return;
      }
      sendVe(chat, todayISO()).catch((err) => console.error("Lịch gửi vé lỗi:", err));
    },
    { timezone: TZ }
  );
}

function cachedPng(isoDate) {
  const hit = vePngCache.get(isoDate);
  if (!hit) return null;
  if (Date.now() - hit.at > VE_CACHE_MS) {
    vePngCache.delete(isoDate);
    return null;
  }
  return hit.buf;
}

export function invalidateVeCache() {
  vePngCache.clear();
}

async function closeBrowser() {
  clearTimeout(browserIdleTimer);
  const current = sharedBrowser;
  sharedBrowser = null;
  if (current) await current.close().catch(() => {});
}

function scheduleBrowserIdle() {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    closeBrowser().catch(() => {});
  }, BROWSER_IDLE_MS);
}

let launchPromise = null;

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (launchPromise) return launchPromise;
  launchPromise = chromium.launch({
    headless: true,
    args: CHROME_ARGS,
    handleSIGINT: false,
    handleSIGTERM: false,
    timeout: 60000
  }).then((browser) => {
    sharedBrowser = browser;
    browser.on("disconnected", () => {
      if (sharedBrowser === browser) sharedBrowser = null;
    });
    return browser;
  }).finally(() => {
    launchPromise = null;
  });
  return launchPromise;
}

async function captureMapOnce(isoDate, primed) {
  const dataPromise = primed || fetchCaptureData(isoDate);
  const [data, browser] = await Promise.all([dataPromise, getBrowser()]);
  if (!data?.ok) {
    throw new Error(data?.error || `Không có đơn ngày ${formatLabel(isoDate)}`);
  }
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 1
  });
  try {
    await page.addInitScript((payload) => {
      window.__CAPTURE__ = payload;
    }, data);
    const url = `${vecomBase()}/?date=${encodeURIComponent(isoDate)}&bot=1`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForFunction(
      () => document.documentElement.dataset.veReady === "ok" || document.documentElement.dataset.veReady === "error",
      { timeout: 12000 }
    );
    const ready = await page.evaluate(() => document.documentElement.dataset.veReady);
    if (ready !== "ok") {
      const err = await page.evaluate(() => document.getElementById("msg")?.textContent || "");
      throw new Error(err || `Không có đơn ngày ${formatLabel(isoDate)}`);
    }
    return await page.locator("#export-root").screenshot({ type: "jpeg", quality: 80 });
  } finally {
    await page.close().catch(() => {});
    scheduleBrowserIdle();
  }
}

let captureChain = Promise.resolve();

function enqueueCapture(task) {
  const run = captureChain.then(task, task);
  captureChain = run.then(() => {}, () => {});
  return run;
}

async function captureMap(isoDate, primed) {
  const hit = cachedPng(isoDate);
  if (hit) return hit;
  if (veInflight.has(isoDate)) return veInflight.get(isoDate);

  const job = enqueueCapture(async () => {
    const again = cachedPng(isoDate);
    if (again) return again;
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const buf = await captureMapOnce(isoDate, primed);
        vePngCache.set(isoDate, { buf, at: Date.now() });
        return buf;
      } catch (err) {
        lastErr = err;
        primed = null;
        const msg = String(err.message || err);
        const crashed = /has been closed|Target closed|Connection closed|browser has been closed/i.test(msg);
        await closeBrowser().catch(() => {});
        if (!crashed || attempt === 2) throw err;
        console.error("Chromium crash, thử lại lần 2:", msg);
      }
    }
    throw lastErr;
  }).finally(() => {
    veInflight.delete(isoDate);
  });

  veInflight.set(isoDate, job);
  return job;
}

async function sendVe(chatId, isoDate, extra, primed) {
  const buf = await captureMap(isoDate, primed);
  await bot.telegram.sendPhoto(
    chatId,
    { source: buf, filename: `ve-com-${isoDate}.jpg` },
    { caption: extra || `Vé cơm ${formatLabel(isoDate)}` }
  );
}

const HELP = [
  "Lệnh vé cơm:",
  "/ve — ảnh hôm nay",
  "/ve 28/06/2026 hoặc /ve-28/06/2026 — đúng ngày",
  "/lich — xem lịch gửi nhóm",
  "/lich 09:00 — gửi T2–T6 lúc 09:00",
  "/lich 09:00 * — gửi mỗi ngày lúc 09:00",
  "/lich off — tắt lịch",
  "/id — xem chat id (để điền TELEGRAM_CHAT_ID)"
].join("\n");

const VE_DEDUP_MS = 45_000;
const recentVe = new Map();

function skipDuplicateVe(chatId, iso) {
  const key = `${chatId}:${iso}`;
  const at = recentVe.get(key);
  if (at && Date.now() - at < VE_DEDUP_MS) return true;
  recentVe.set(key, Date.now());
  return false;
}

if (bot) {
  bot.start((ctx) => ctx.reply(HELP));
  bot.help((ctx) => ctx.reply(HELP));

  bot.command("id", (ctx) => {
    ctx.reply(`Chat ID: ${ctx.chat.id}`);
  });

  bot.hears(/^\/ve(?:@\w+)?(?:[\s-_].*)?$/i, async (ctx) => {
    const iso = parseVeDate(ctx.message.text);
    if (!iso) {
      await ctx.reply("Ngày không hợp lệ. Ví dụ: /ve hoặc /ve 28/06/2026");
      return;
    }
    if (skipDuplicateVe(ctx.chat.id, iso)) return;
    const primed = fetchCaptureData(iso);
    const wait = await ctx.reply(`Đang lấy vé ${formatLabel(iso)}...`);
    try {
      await sendVe(ctx.chat.id, iso, undefined, primed);
    } catch (err) {
      await ctx.reply(err.message || "Không gửi được ảnh.");
    } finally {
      try { await ctx.deleteMessage(wait.message_id); } catch { /* ignore */ }
    }
  });

  bot.command("lich", async (ctx) => {
    const parsed = parseLich(ctx.message.text);
    if (parsed.show) {
      const saved = readSchedule();
      await ctx.reply(saved?.label ? `Lịch hiện tại: ${saved.label}` : "Chưa đặt lịch. Ví dụ: /lich 09:00");
      return;
    }
    if (parsed.off) {
      writeSchedule({ expr: null });
      applySchedule(null);
      await ctx.reply("Đã tắt lịch gửi tự động.");
      return;
    }
    if (parsed.error) {
      await ctx.reply("Cú pháp: /lich 09:00  (T2–T6)  hoặc  /lich 09:00 *  (mỗi ngày)  hoặc  /lich off");
      return;
    }
    const saved = { expr: parsed.expr, label: parsed.label, chatId: ctx.chat.id };
    writeSchedule(saved);
    applySchedule(saved);
    await ctx.reply(`Đã hẹn gửi vé vào nhóm này lúc ${parsed.label}`);
  });

  bot.catch((err) => console.error("Bot error:", err));
}

export async function startTelegram(publicUrl) {
  if (!bot) {
    console.warn("Thiếu TELEGRAM_BOT_TOKEN — chỉ chạy trang web và API lưu sơ đồ.");
    return { webhook: false };
  }
  applySchedule(await restoreSchedule());
  if (publicUrl) {
    const hook = `${publicUrl.replace(/\/$/, "")}/telegram-webhook`;
    await bot.telegram.setWebhook(hook);
    console.log("Telegram webhook:", hook);
    return { webhook: true };
  }
  await bot.launch();
  console.log("Telegram bot đang chạy (polling).");
  console.log("URL sơ đồ:", vecomBase());
  return { webhook: false };
}

export async function stopTelegram() {
  await closeBrowser();
  if (bot) await bot.stop();
}
