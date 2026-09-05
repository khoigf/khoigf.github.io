import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Telegraf } from "telegraf";
import cron from "node-cron";
import {
  loadFund,
  findMember,
  parseAmount,
  formatVnd,
  addMember,
  removeMember,
  addTransaction,
  updateSettings,
  summaryText,
  monthStatus,
  monthKey,
  memberBalances,
  fundTotal
} from "./quy-store.js";
import { writeGithubJson, readGithubJson } from "./seats-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TZ = process.env.TZ || "Asia/Ho_Chi_Minh";
const REMIND_FILE = join(__dirname, "quy-remind.json");
const REMIND_GH = "vecom/bot/quy-remind.json";

const QUY_TOKEN = process.env.QUY_BOT_TOKEN || "";
const SHARED = !QUY_TOKEN && !!process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT = process.env.QUY_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

/** Bot riêng khi có QUY_BOT_TOKEN; null nếu gắn chung bot vé cơm */
export const quyBot = QUY_TOKEN ? new Telegraf(QUY_TOKEN) : null;
let remindTask = null;
let telegramApi = quyBot?.telegram || null;

const HELP = [
  "Bot quỹ nhóm — lệnh:",
  "/quy — tổng quỹ + tháng này",
  "/sodu — số dư từng người",
  "/no — ai chưa đóng tháng này",
  "/dong Tên 100k — ghi đóng quỹ",
  "/chi 50k ghi chú — chi từ quỹ",
  "/rut Tên 50k — rút/hoàn cho cá nhân",
  "/them Tên — thêm thành viên",
  "/xoa Tên — ẩn thành viên",
  "/muc 100000 — mức đóng/tháng",
  "/han 5 — hạn đóng (ngày trong tháng)",
  "/lichquy — xem lịch nhắc",
  "/lichquy 5 09:00 — nhắc ngày 5 lúc 09:00",
  "/lichquy off — tắt nhắc",
  "/id — chat id"
].join("\n");

function readRemindLocal() {
  try {
    if (!existsSync(REMIND_FILE)) return null;
    return JSON.parse(readFileSync(REMIND_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeRemindLocal(data) {
  writeFileSync(REMIND_FILE, JSON.stringify(data, null, 2));
}

async function restoreRemind() {
  try {
    const remote = await readGithubJson(REMIND_GH);
    if (remote) {
      writeRemindLocal(remote);
      return remote;
    }
  } catch (err) {
    console.error("Không đọc lịch nhắc quỹ:", err.message);
  }
  return readRemindLocal();
}

function saveRemind(data) {
  writeRemindLocal(data);
  writeGithubJson(REMIND_GH, data, "chore: cập nhật lịch nhắc quỹ").catch((err) => {
    console.error("Không lưu lịch nhắc quỹ:", err.message);
  });
}

function applyRemind(saved) {
  if (remindTask) {
    remindTask.stop();
    remindTask = null;
  }
  if (!saved?.expr || !cron.validate(saved.expr)) return;
  remindTask = cron.schedule(
    saved.expr,
    async () => {
      const chat = saved.chatId || DEFAULT_CHAT;
      if (!chat || !telegramApi) return;
      try {
        const fund = await loadFund(true);
        const unpaid = monthStatus(fund).filter((s) => !s.done);
        if (!unpaid.length) {
          await telegramApi.sendMessage(chat, `Tháng ${monthKey()}: mọi người đã đóng đủ quỹ.`);
          return;
        }
        const lines = [
          `Nhắc đóng quỹ tháng ${monthKey()}`,
          `Mức: ${formatVnd(fund.settings.monthlyAmount)}`,
          "",
          ...unpaid.map((s) => `• ${s.name}: còn ${formatVnd(s.remaining)}`)
        ];
        await telegramApi.sendMessage(chat, lines.join("\n"));
      } catch (err) {
        console.error("Nhắc quỹ lỗi:", err.message);
      }
    },
    { timezone: TZ }
  );
}

function parseLichQuy(text) {
  const body = String(text || "")
    .replace(/^\/lichquy(?:@\w+)?/i, "")
    .trim()
    .toLowerCase();
  if (!body) return { show: true };
  if (["off", "stop", "huy", "tắt", "tat"].includes(body)) return { off: true };
  const m = body.match(/^(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return { error: true };
  const day = Number(m[1]);
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (day < 1 || day > 28 || hour > 23 || minute > 59) return { error: true };
  return {
    expr: `${minute} ${hour} ${day} * *`,
    label: `ngày ${day} lúc ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    day,
    hour,
    minute
  };
}

function parseNameAmount(text, cmd) {
  const body = String(text || "")
    .replace(new RegExp(`^/${cmd}(?:@\\w+)?`, "i"), "")
    .trim();
  const m = body.match(/^(.+?)\s+(\S+)$/);
  if (!m) return null;
  return { name: m[1].trim(), amountRaw: m[2] };
}

function parseChi(text) {
  const body = String(text || "")
    .replace(/^\/chi(?:@\w+)?/i, "")
    .trim();
  const m = body.match(/^(\S+)\s*(.*)$/);
  if (!m) return null;
  return { amountRaw: m[1], note: m[2].trim() };
}

/**
 * Gắn lệnh quỹ vào một Telegraf bot (bot riêng hoặc bot vé cơm dùng chung).
 */
export function registerQuyCommands(bot, { mergeHelp = false } = {}) {
  if (!bot) return;
  telegramApi = bot.telegram;

  if (!mergeHelp) {
    bot.start((ctx) => ctx.reply(HELP));
    bot.help((ctx) => ctx.reply(HELP));
    bot.command("id", (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));
  }

  bot.command("quy", async (ctx) => {
    const fund = await loadFund(true);
    await ctx.reply(summaryText(fund));
  });

  bot.command("sodu", async (ctx) => {
    const fund = await loadFund(true);
    const bal = memberBalances(fund);
    await ctx.reply(
      [
        `Số dư cá nhân · tổng quỹ ${formatVnd(fundTotal(fund))}`,
        ...fund.members.filter((m) => m.active !== false).map((m) => `• ${m.name}: ${formatVnd(bal[m.id] || 0)}`)
      ].join("\n")
    );
  });

  bot.command("no", async (ctx) => {
    const fund = await loadFund(true);
    const unpaid = monthStatus(fund).filter((s) => !s.done);
    if (!unpaid.length) {
      await ctx.reply(`Tháng ${monthKey()}: mọi người đã đóng đủ.`);
      return;
    }
    await ctx.reply(
      [`Chưa đóng đủ tháng ${monthKey()}:`, ...unpaid.map((s) => `• ${s.name}: còn ${formatVnd(s.remaining)}`)].join("\n")
    );
  });

  bot.command("them", async (ctx) => {
    const name = String(ctx.message.text || "")
      .replace(/^\/them(?:@\w+)?/i, "")
      .trim();
    try {
      const fund = await addMember(name, ctx.from?.username || ctx.from?.first_name);
      await ctx.reply(`Đã thêm “${name}”. Hiện có ${fund.members.filter((m) => m.active !== false).length} người.`);
    } catch (err) {
      await ctx.reply(err.message || "Không thêm được.");
    }
  });

  bot.command("xoa", async (ctx) => {
    const name = String(ctx.message.text || "")
      .replace(/^\/xoa(?:@\w+)?/i, "")
      .trim();
    try {
      await removeMember(name);
      await ctx.reply(`Đã ẩn thành viên “${name}”.`);
    } catch (err) {
      await ctx.reply(err.message || "Không xóa được.");
    }
  });

  bot.command("dong", async (ctx) => {
    const parsed = parseNameAmount(ctx.message.text, "dong");
    if (!parsed) {
      await ctx.reply("Cú pháp: /dong Tên 100000  hoặc  /dong An 100k");
      return;
    }
    const fund = await loadFund();
    const member = findMember(fund, parsed.name);
    if (!member) {
      await ctx.reply(`Không thấy “${parsed.name}”. Dùng /them Tên trước.`);
      return;
    }
    const amount = parseAmount(parsed.amountRaw);
    if (!amount) {
      await ctx.reply("Số tiền không hợp lệ.");
      return;
    }
    try {
      const { fund: next } = await addTransaction({
        type: "contribute",
        memberId: member.id,
        amount,
        note: "Telegram",
        by: ctx.from?.username || ctx.from?.first_name
      });
      const st = monthStatus(next).find((s) => s.id === member.id);
      await ctx.reply(
        `Đã ghi ${member.name} đóng ${formatVnd(amount)}.\nTháng này: ${formatVnd(st.paid)}/${formatVnd(st.due)}\nTổng quỹ: ${formatVnd(fundTotal(next))}`
      );
    } catch (err) {
      await ctx.reply(err.message || "Ghi thất bại.");
    }
  });

  bot.command("chi", async (ctx) => {
    const parsed = parseChi(ctx.message.text);
    if (!parsed) {
      await ctx.reply("Cú pháp: /chi 50000 ăn tối");
      return;
    }
    const amount = parseAmount(parsed.amountRaw);
    if (!amount) {
      await ctx.reply("Số tiền không hợp lệ.");
      return;
    }
    try {
      const { fund } = await addTransaction({
        type: "expense",
        amount,
        note: parsed.note || "Chi quỹ",
        by: ctx.from?.username || ctx.from?.first_name
      });
      await ctx.reply(
        `Đã chi ${formatVnd(amount)}${parsed.note ? ` — ${parsed.note}` : ""}.\nTổng quỹ: ${formatVnd(fundTotal(fund))}`
      );
    } catch (err) {
      await ctx.reply(err.message || "Chi thất bại.");
    }
  });

  bot.command("rut", async (ctx) => {
    const parsed = parseNameAmount(ctx.message.text, "rut");
    if (!parsed) {
      await ctx.reply("Cú pháp: /rut Tên 50000");
      return;
    }
    const fund = await loadFund();
    const member = findMember(fund, parsed.name);
    if (!member) {
      await ctx.reply(`Không thấy “${parsed.name}”.`);
      return;
    }
    const amount = parseAmount(parsed.amountRaw);
    if (!amount) {
      await ctx.reply("Số tiền không hợp lệ.");
      return;
    }
    try {
      const { fund: next } = await addTransaction({
        type: "withdraw",
        memberId: member.id,
        amount,
        note: "Rút/hoàn",
        by: ctx.from?.username || ctx.from?.first_name
      });
      await ctx.reply(`Đã rút ${formatVnd(amount)} cho ${member.name}.\nTổng quỹ: ${formatVnd(fundTotal(next))}`);
    } catch (err) {
      await ctx.reply(err.message || "Rút thất bại.");
    }
  });

  bot.command("muc", async (ctx) => {
    const raw = String(ctx.message.text || "")
      .replace(/^\/muc(?:@\w+)?/i, "")
      .trim();
    const amount = parseAmount(raw);
    if (!amount) {
      await ctx.reply("Cú pháp: /muc 100000");
      return;
    }
    const fund = await updateSettings({ monthlyAmount: amount });
    await ctx.reply(`Mức đóng tháng: ${formatVnd(fund.settings.monthlyAmount)}`);
  });

  bot.command("han", async (ctx) => {
    const raw = String(ctx.message.text || "")
      .replace(/^\/han(?:@\w+)?/i, "")
      .trim();
    const day = Number(raw);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      await ctx.reply("Cú pháp: /han 5  (ngày 1–28)");
      return;
    }
    const fund = await updateSettings({ dueDay: day });
    await ctx.reply(`Hạn đóng mỗi tháng: ngày ${fund.settings.dueDay}`);
  });

  bot.command("lichquy", async (ctx) => {
    const parsed = parseLichQuy(ctx.message.text);
    if (parsed.show) {
      const saved = readRemindLocal();
      await ctx.reply(saved?.label ? `Lịch nhắc: ${saved.label}` : "Chưa đặt. Ví dụ: /lichquy 5 09:00");
      return;
    }
    if (parsed.off) {
      saveRemind({ expr: null });
      applyRemind(null);
      await updateSettings({ remindEnabled: false });
      await ctx.reply("Đã tắt lịch nhắc quỹ.");
      return;
    }
    if (parsed.error) {
      await ctx.reply("Cú pháp: /lichquy 5 09:00  hoặc  /lichquy off");
      return;
    }
    const saved = { expr: parsed.expr, label: parsed.label, chatId: ctx.chat.id, day: parsed.day };
    saveRemind(saved);
    applyRemind(saved);
    await updateSettings({
      remindEnabled: true,
      remindChatId: String(ctx.chat.id),
      dueDay: parsed.day,
      remindHour: parsed.hour,
      remindMinute: parsed.minute
    });
    await ctx.reply(`Đã hẹn nhắc đóng quỹ ${parsed.label} trong nhóm này.`);
  });

  bot.command("trogiupquy", (ctx) => ctx.reply(HELP));

  if (!bot._quyCatch) {
    bot._quyCatch = true;
    bot.catch((err) => console.error("Quy bot error:", err));
  }
}

export function quyHelpText() {
  return HELP;
}

export async function startQuyBot(publicUrl, vecomBot = null) {
  if (quyBot) telegramApi = quyBot.telegram;
  applyRemind(await restoreRemind());

  if (quyBot) {
    registerQuyCommands(quyBot);
    if (publicUrl) {
      const hook = `${publicUrl.replace(/\/$/, "")}/quy-telegram-webhook`;
      await quyBot.telegram.setWebhook(hook);
      console.log("Quy Telegram webhook:", hook);
      return { webhook: true, shared: false };
    }
    await quyBot.launch();
    console.log("Bot quỹ đang chạy (polling).");
    return { webhook: false, shared: false };
  }

  if (SHARED && vecomBot) {
    registerQuyCommands(vecomBot, { mergeHelp: true });
    console.log("Lệnh quỹ đã gắn vào bot Telegram hiện có (/quy, /dong, … /trogiupquy).");
    return { webhook: "shared", shared: true };
  }

  console.warn("Thiếu QUY_BOT_TOKEN — chỉ dùng trang/API quỹ.");
  return { webhook: false, shared: false };
}

export async function stopQuyBot() {
  if (remindTask) {
    remindTask.stop();
    remindTask = null;
  }
  if (quyBot) await quyBot.stop();
}

export function isSharedQuyToken() {
  return SHARED;
}
