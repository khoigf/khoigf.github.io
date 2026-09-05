import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGithubJson, writeGithubJson } from "./seats-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const LOCAL_FILE = join(DATA_DIR, "fund.json");
const SEED_FILE = join(__dirname, "..", "..", "quy", "fund.json");
const GH_PATH = process.env.QUY_GITHUB_PATH || "quy/fund.json";
const CONFIG_PATH = "quy/config.json";
/** Gom N lệnh rồi mới ghi GitHub (mặc định 8) */
const FLUSH_OPS = Math.max(1, Number(process.env.QUY_FLUSH_OPS) || 8);
/** Hoặc sau N ms không có thay đổi mới (mặc định 3 phút) */
const FLUSH_MS = Math.max(15_000, Number(process.env.QUY_FLUSH_MS) || 3 * 60_000);

let cache = null;
let saveChain = Promise.resolve();
let flushChain = Promise.resolve();
let dirty = false;
let pendingOps = 0;
let flushTimer = null;
let lastCommitMessage = "chore: cập nhật quỹ nhóm";

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function monthKey(d = new Date(), tz = process.env.TZ || "Asia/Ho_Chi_Minh") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

export function emptyFund() {
  return {
    version: 1,
    name: "Quỹ nhóm",
    settings: {
      monthlyAmount: 100000,
      dueDay: 5,
      remindHour: 9,
      remindMinute: 0,
      remindEnabled: false,
      remindChatId: null
    },
    members: [],
    transactions: [],
    updatedAt: null
  };
}

function normalize(raw) {
  const base = emptyFund();
  if (!raw || typeof raw !== "object") return base;
  const settings = { ...base.settings, ...(raw.settings || {}) };
  settings.monthlyAmount = Math.max(0, Number(settings.monthlyAmount) || 0);
  settings.dueDay = Math.min(28, Math.max(1, Number(settings.dueDay) || 5));
  settings.remindHour = Math.min(23, Math.max(0, Number(settings.remindHour) || 0));
  settings.remindMinute = Math.min(59, Math.max(0, Number(settings.remindMinute) || 0));
  settings.remindEnabled = !!settings.remindEnabled;
  settings.remindChatId = settings.remindChatId || null;

  const members = Array.isArray(raw.members)
    ? raw.members
        .filter((m) => m && m.id && m.name)
        .slice(0, 20)
        .map((m) => ({
          id: String(m.id),
          name: String(m.name).trim().slice(0, 40),
          telegramId: m.telegramId ? String(m.telegramId) : null,
          active: m.active !== false
        }))
    : [];

  const transactions = Array.isArray(raw.transactions)
    ? raw.transactions
        .filter((t) => t && t.id && t.type && Number.isFinite(Number(t.amount)))
        .slice(-500)
        .map((t) => ({
          id: String(t.id),
          type: String(t.type),
          memberId: t.memberId ? String(t.memberId) : null,
          amount: Math.round(Number(t.amount)),
          note: String(t.note || "").slice(0, 200),
          month: t.month ? String(t.month) : null,
          at: t.at || new Date().toISOString(),
          by: t.by ? String(t.by).slice(0, 60) : null
        }))
    : [];

  return {
    version: 1,
    name: String(raw.name || base.name).slice(0, 60),
    settings,
    members,
    transactions,
    updatedAt: raw.updatedAt || null
  };
}

function readLocal() {
  for (const path of [LOCAL_FILE, SEED_FILE]) {
    if (!existsSync(path)) continue;
    try {
      return normalize(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      /* ignore */
    }
  }
  return null;
}

function writeLocal(fund) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCAL_FILE, JSON.stringify(fund, null, 2));
}

export function getFund() {
  return cache;
}

export async function loadFund(force = false) {
  if (cache && (!force || dirty)) {
    await ensureMonthCharges();
    return cache;
  }
  try {
    const remote = await readGithubJson(GH_PATH);
    if (remote) {
      cache = normalize(remote);
      writeLocal(cache);
      await ensureMonthCharges();
      return cache;
    }
  } catch (err) {
    console.error("Không tải quỹ từ GitHub:", err.message);
  }
  cache = readLocal() || emptyFund();
  writeLocal(cache);
  await ensureMonthCharges();
  return cache;
}

function clearFlushTimer() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function armFlushTimer() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushFundToGithub().catch((err) => console.error("Flush quỹ lỗi:", err.message));
  }, FLUSH_MS);
}

/**
 * Ghi GitHub ngay (hoặc khi đủ N lệnh / hết thời gian chờ).
 * RAM + đĩa local luôn cập nhật tức thì qua saveFund.
 */
export function flushFundToGithub() {
  const run = flushChain.then(async () => {
    if (!dirty || !cache) return cache;
    clearFlushTimer();
    const ops = Math.max(1, pendingOps);
    const snapshot = cache;
    const message =
      ops > 1 ? `chore(quy): đồng bộ ${ops} thay đổi` : lastCommitMessage;
    pendingOps = 0;
    dirty = false;
    try {
      await writeGithubJson(GH_PATH, snapshot, message);
      console.log(`Đã ghi quỹ lên GitHub (${ops} thay đổi).`);
    } catch (err) {
      dirty = true;
      pendingOps = Math.max(pendingOps, ops);
      armFlushTimer();
      console.error("Không lưu quỹ lên GitHub:", err.message);
    }
    return snapshot;
  });
  flushChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

export function fundFlushStatus() {
  return {
    dirty,
    pendingOps,
    flushOps: FLUSH_OPS,
    flushMs: FLUSH_MS
  };
}

function enqueueSave(task) {
  const run = saveChain.then(task, task);
  saveChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** Cập nhật RAM + file local ngay; GitHub gom theo FLUSH_OPS / FLUSH_MS */
export function saveFund(next, message) {
  return enqueueSave(async () => {
    const fund = normalize(next);
    fund.updatedAt = new Date().toISOString();
    cache = fund;
    writeLocal(fund);
    dirty = true;
    pendingOps += 1;
    if (message) lastCommitMessage = message;
    if (pendingOps >= FLUSH_OPS) {
      await flushFundToGithub();
    } else {
      armFlushTimer();
    }
    return fund;
  });
}

export function memberBalances(fund) {
  const map = Object.fromEntries(fund.members.map((m) => [m.id, 0]));
  for (const t of fund.transactions) {
    if (!t.memberId || !(t.memberId in map)) continue;
    if (t.type === "contribute" || t.type === "adjust_in") map[t.memberId] += t.amount;
    if (t.type === "withdraw" || t.type === "adjust_out" || t.type === "charge" || t.type === "levy") {
      map[t.memberId] -= t.amount;
    }
  }
  return map;
}

export function fundTotal(fund) {
  let total = 0;
  for (const t of fund.transactions) {
    if (t.type === "contribute" || t.type === "adjust_in" || t.type === "levy") total += t.amount;
    if (t.type === "expense" || t.type === "withdraw" || t.type === "adjust_out") total -= t.amount;
  }
  return total;
}

export function monthPaid(fund, memberId, month = monthKey()) {
  return fund.transactions
    .filter((t) => t.memberId === memberId && t.type === "contribute" && (t.month || monthKey(new Date(t.at))) === month)
    .reduce((s, t) => s + t.amount, 0);
}

export function monthCharged(fund, memberId, month = monthKey()) {
  return fund.transactions
    .filter((t) => t.memberId === memberId && t.type === "charge" && t.month === month)
    .reduce((s, t) => s + t.amount, 0);
}

/**
 * Mỗi tháng gắn công nợ = mức đóng (vd -100k). Chưa /dong thì số dư âm đúng mức đó.
 * Đóng đủ thì hòa; đóng thừa thì phần dư còn trên số dư.
 */
export async function ensureMonthCharges(month = monthKey()) {
  if (!cache) {
    // tải thô, chưa apply charge (tránh đệ quy)
    try {
      const remote = await readGithubJson(GH_PATH);
      if (remote) cache = normalize(remote);
    } catch {
      /* ignore */
    }
    if (!cache) cache = readLocal() || emptyFund();
    writeLocal(cache);
  }

  const due = cache.settings.monthlyAmount;
  if (due <= 0) return cache;

  let added = 0;
  for (const m of cache.members.filter((x) => x.active !== false)) {
    const has = cache.transactions.some((t) => t.type === "charge" && t.memberId === m.id && t.month === month);
    if (has) continue;
    cache.transactions.push({
      id: uid("tx"),
      type: "charge",
      memberId: m.id,
      amount: due,
      note: `Công nợ tháng ${month}`,
      month,
      at: new Date().toISOString(),
      by: "system"
    });
    added += 1;
  }
  if (added) {
    if (cache.transactions.length > 500) cache.transactions = cache.transactions.slice(-500);
    await saveFund(cache, `chore(quy): công nợ tháng ${month} (${added} người)`);
  }
  return cache;
}

export function monthStatus(fund, month = monthKey()) {
  const due = fund.settings.monthlyAmount;
  const balances = memberBalances(fund);
  return fund.members
    .filter((m) => m.active !== false)
    .map((m) => {
      const paid = monthPaid(fund, m.id, month);
      const charged = monthCharged(fund, m.id, month) || due;
      return {
        id: m.id,
        name: m.name,
        paid,
        due: charged,
        remaining: Math.max(0, charged - paid),
        done: paid >= charged,
        balance: balances[m.id] || 0
      };
    });
}

export function findMember(fund, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (!q) return null;
  const active = fund.members.filter((m) => m.active !== false);
  return (
    active.find((m) => m.id === query) ||
    active.find((m) => m.name.toLowerCase() === q) ||
    active.find((m) => m.name.toLowerCase().includes(q)) ||
    null
  );
}

export function parseAmount(raw) {
  let s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[₫đ\s]/g, "")
    .replace(/,/g, ".");
  if (!s) return null;
  let mult = 1;
  if (/k$|nghìn$|nghin$/.test(s)) {
    mult = 1000;
    s = s.replace(/k$|nghìn$|nghin$/, "");
  } else if (/tr$|triệu$|trieu$|m$/.test(s)) {
    mult = 1_000_000;
    s = s.replace(/tr$|triệu$|trieu$|m$/, "");
  }
  s = s.replace(/\.(?=\d{3}(\D|$))/g, "");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * mult);
}

export function formatVnd(n) {
  return `${Math.round(Number(n) || 0).toLocaleString("vi-VN")}₫`;
}

export async function addMember(name, by = null) {
  const fund = await loadFund();
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) throw new Error("Thiếu tên thành viên");
  if (fund.members.filter((m) => m.active !== false).length >= 12) {
    throw new Error("Tối đa 12 thành viên");
  }
  if (findMember(fund, clean)) throw new Error(`Đã có thành viên “${clean}”`);
  fund.members.push({ id: uid("m"), name: clean, telegramId: null, active: true });
  const month = monthKey();
  const due = fund.settings.monthlyAmount;
  if (due > 0) {
    fund.transactions.push({
      id: uid("tx"),
      type: "charge",
      memberId: fund.members[fund.members.length - 1].id,
      amount: due,
      note: `Công nợ tháng ${month}`,
      month,
      at: new Date().toISOString(),
      by: by || "system"
    });
  }
  await saveFund(fund, `chore(quy): thêm ${clean}`);
  return getFund();
}

export async function removeMember(query) {
  const fund = await loadFund();
  const m = findMember(fund, query);
  if (!m) throw new Error("Không tìm thấy thành viên");
  m.active = false;
  await saveFund(fund, `chore(quy): ẩn ${m.name}`);
  return getFund();
}

export async function addTransaction({ type, memberId = null, amount, note = "", by = null, month = null }) {
  const fund = await loadFund();
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new Error("Số tiền không hợp lệ");
  const allowed = ["contribute", "expense", "withdraw", "adjust_in", "adjust_out", "charge", "levy"];
  if (!allowed.includes(type)) throw new Error("Loại giao dịch không hợp lệ");
  if (
    (type === "contribute" ||
      type === "withdraw" ||
      type === "adjust_in" ||
      type === "adjust_out" ||
      type === "charge" ||
      type === "levy") &&
    memberId
  ) {
    if (!fund.members.some((m) => m.id === memberId && m.active !== false)) {
      throw new Error("Thành viên không hợp lệ");
    }
  }
  const txMonth =
    type === "contribute" || type === "charge" || type === "levy" ? month || monthKey() : month;
  const tx = {
    id: uid("tx"),
    type,
    memberId: memberId || null,
    amount: value,
    note: String(note || "").slice(0, 200),
    month: txMonth,
    at: new Date().toISOString(),
    by: by || null
  };
  fund.transactions.push(tx);
  if (fund.transactions.length > 500) fund.transactions = fund.transactions.slice(-500);
  await saveFund(fund, `chore(quy): ${type} ${value}`);
  return { fund: getFund(), tx };
}

export async function updateSettings(patch, by = null) {
  const fund = await loadFund();
  const next = { ...(patch || {}) };
  if (next.name != null) {
    fund.name = String(next.name).slice(0, 60);
    delete next.name;
  }
  delete next.lastEditedBy;
  Object.assign(fund.settings, next);
  if (by) fund.settings.lastEditedBy = by;
  const normalized = normalize(fund);
  fund.settings = normalized.settings;
  fund.name = normalized.name;
  await saveFund(fund, "chore(quy): cập nhật cài đặt");
  return getFund();
}

export async function replaceFund(body) {
  const fund = normalize(body);
  await saveFund(fund, "chore(quy): đồng bộ từ trang quản lý");
  await ensureMonthCharges();
  return getFund();
}

/**
 * Đóng thêm: trừ đúng số tiền trên mỗi người và cộng vào quỹ (type levy).
 */
export async function levyAll(amount, note = "Đóng thêm", by = null) {
  await loadFund();
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw new Error("Số tiền không hợp lệ");
  const fund = getFund();
  const members = fund.members.filter((m) => m.active !== false);
  if (!members.length) throw new Error("Chưa có thành viên");
  const month = monthKey();
  const at = new Date().toISOString();
  for (const m of members) {
    fund.transactions.push({
      id: uid("tx"),
      type: "levy",
      memberId: m.id,
      amount: value,
      note: String(note || "Đóng thêm").slice(0, 200),
      month,
      at,
      by: by || null
    });
  }
  if (fund.transactions.length > 500) fund.transactions = fund.transactions.slice(-500);
  await saveFund(fund, `chore(quy): đóng thêm ${value} × ${members.length}`);
  return getFund();
}

export function summaryText(fund) {
  const total = fundTotal(fund);
  const month = monthKey();
  const status = monthStatus(fund, month);
  const paidCount = status.filter((s) => s.done).length;
  const lines = [
    `💰 ${fund.name}`,
    `Tổng quỹ: ${formatVnd(total)}`,
    `Công nợ tháng ${month}: ${formatVnd(fund.settings.monthlyAmount)}/người (chưa đóng = số dư âm)`,
    `Đã đóng: ${paidCount}/${status.length}`,
    "",
    ...status.map((s) => {
      const mark = s.done ? "✅" : "⏳";
      return `${mark} ${s.name}: nộp ${formatVnd(s.paid)}/${formatVnd(s.due)} · số dư ${formatVnd(s.balance)}`;
    })
  ];
  return lines.join("\n");
}

export async function syncQuyConfig(publicUrl) {
  if (!publicUrl) return;
  const apiUrl = `${publicUrl.replace(/\/$/, "")}/api/quy`;
  try {
    await writeGithubJson(
      CONFIG_PATH,
      { apiUrl, needSaveKey: false },
      "chore: gắn API quỹ nhóm"
    );
    console.log("Đã gắn apiUrl vào quy/config.json:", apiUrl);
  } catch (err) {
    console.error("Không cập nhật quy/config.json:", err.message);
  }
}

export { monthKey, uid };
