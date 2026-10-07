import { getSeats, loadSeats } from "./seats-store.js";

const FREELUNCH_BASE = (process.env.FREELUNCH_URL || "https://freelunch.quandaso.xyz").replace(/\/$/, "");
const LOGIN_URL = `${FREELUNCH_BASE}/xadmin/login`;
const REPORT_API = `${FREELUNCH_BASE}/xadmin/api/orders/report`;
const DEPARTMENT_ID = Number(process.env.FREELUNCH_DEPARTMENT_ID) || 2;
const ORDERS_CACHE_MS = 20_000;
const ordersCache = new Map();

/** Cookie phiên đăng nhập FreeLunch (name -> value) */
const cookieJar = new Map();
let loginPromise = null;

function storeSetCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const pair = line.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

function cookieHeader() {
  return [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function login() {
  const username = process.env.FREELUNCH_USERNAME;
  const password = process.env.FREELUNCH_PASSWORD;
  if (!username || !password) {
    throw new Error("API FreeLunch cần đăng nhập — thiếu FREELUNCH_USERNAME / FREELUNCH_PASSWORD trên server");
  }
  cookieJar.clear();
  const page = await fetch(LOGIN_URL, { redirect: "manual", signal: AbortSignal.timeout(12000) });
  storeSetCookies(page);
  const html = await page.text();
  const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1];
  if (!token) throw new Error("Không đọc được form đăng nhập FreeLunch");

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader()
    },
    body: new URLSearchParams({ _token: token, username, password, remember: "1" }),
    signal: AbortSignal.timeout(12000)
  });
  storeSetCookies(res);
  const location = res.headers.get("location") || "";
  if (res.status !== 302 || /\/login\b/.test(location)) {
    throw new Error("Đăng nhập FreeLunch thất bại — kiểm tra tài khoản/mật khẩu");
  }
}

function ensureLogin() {
  if (!loginPromise) {
    loginPromise = login().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

function requestReport(isoDate) {
  const url = `${REPORT_API}?date=${encodeURIComponent(isoDate)}&department_id=${DEPARTMENT_ID}`;
  return fetch(url, {
    redirect: "manual",
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Cookie: cookieHeader() },
    signal: AbortSignal.timeout(12000)
  });
}

function needsLogin(res) {
  return res.status === 302 || res.status === 401 || res.status === 419;
}

async function fetchReport(isoDate) {
  if (!cookieJar.size) await ensureLogin();
  let res = await requestReport(isoDate);
  if (needsLogin(res)) {
    await ensureLogin();
    res = await requestReport(isoDate);
  }
  if (needsLogin(res)) throw new Error("Phiên FreeLunch hết hạn, đăng nhập lại không được");
  if (!res.ok) throw new Error(`API lỗi ${res.status}`);
  storeSetCookies(res);
  return res.json();
}

/**
 * Report trả về mỗi vé một dòng, gồm mọi phòng ban (bỏ qua department_id).
 * Gom theo user, chỉ giữ người thuộc DEPARTMENT_ID.
 */
function groupOrders(orders) {
  const byUser = new Map();
  for (const order of orders || []) {
    const user = order.user || {};
    const name = String(user.name || "").trim();
    if (!name || Number(user.department_id) !== DEPARTMENT_ID) continue;
    const key = order.user_id ?? name;
    if (!byUser.has(key)) byUser.set(key, { name, tickets: [] });
    byUser.get(key).tickets.push(Number(order.amount) || 0);
  }
  return [...byUser.values()].map(({ name, tickets }) => {
    const list = tickets.filter((n) => n > 0);
    const kind = list.length && list.every((v) => v < 30000) ? 25 : 35;
    return { name, qty: list.length || 1, kind, total: list.reduce((s, v) => s + v, 0) };
  });
}

function formatDateLabel(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export async function fetchCaptureData(isoDate) {
  const seats = (await loadSeats(true)) || getSeats();
  if (!seats) {
    return { ok: false, date: isoDate, seats: { version: 1, groups: [] }, tickets: [], error: "Chưa tải được sơ đồ" };
  }
  const cached = ordersCache.get(isoDate);
  let json;
  if (cached && Date.now() - cached.at < ORDERS_CACHE_MS) {
    json = cached.json;
  } else {
    try {
      json = await fetchReport(isoDate);
    } catch (err) {
      return { ok: false, date: isoDate, seats, tickets: [], error: err.message || "Không gọi được API" };
    }
    ordersCache.set(isoDate, { json, at: Date.now() });
  }
  const tickets = groupOrders(json?.data?.orders);
  if (!tickets.length) {
    return {
      ok: false,
      date: isoDate,
      seats,
      tickets: [],
      error: `Không có đơn ngày ${formatDateLabel(isoDate)}`
    };
  }
  return {
    ok: true,
    date: isoDate,
    seats,
    tickets,
    label: `API ${formatDateLabel(isoDate)} · ${tickets.length} người`
  };
}
