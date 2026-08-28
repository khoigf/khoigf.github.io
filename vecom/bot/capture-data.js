import { getSeats } from "./seats-store.js";

const ORDERS_API = "https://freelunch.quandaso.xyz/api/orders";
const DEPARTMENT_ID = 2;
const ORDERS_CACHE_MS = 20_000;
const ordersCache = new Map();

function parseTicket(amount, qty) {
  qty = Number(qty);
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;
  amount = Number(amount) || 0;
  let unit;
  if (amount === 25000 || amount === 35000) unit = amount;
  else if (qty > 0 && (amount / qty === 25000 || amount / qty === 35000)) unit = amount / qty;
  else unit = qty > 0 ? Math.round(amount / qty) : amount;
  const kind = unit >= 30000 ? 35 : 25;
  const total = (amount === 25000 || amount === 35000) ? unit * qty : (amount || unit * qty);
  return { qty, unit, kind, total };
}

function parseApiOrder(item) {
  const name = String(item.name || "").trim();
  const list = Array.isArray(item.tickets)
    ? item.tickets.map(Number).filter((n) => n > 0)
    : [];
  if (list.length) {
    const qty = list.length;
    const kind = list.every((v) => v < 30000) ? 25 : 35;
    const total = list.reduce((s, v) => s + v, 0);
    return { name, qty, kind, total };
  }
  return { name, ...parseTicket(item.amount, 1) };
}

function formatDateLabel(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export async function fetchCaptureData(isoDate) {
  const seats = getSeats();
  if (!seats) {
    return { ok: false, date: isoDate, seats: { version: 1, groups: [] }, tickets: [], error: "Chưa tải được sơ đồ" };
  }
  const cached = ordersCache.get(isoDate);
  let json;
  if (cached && Date.now() - cached.at < ORDERS_CACHE_MS) {
    json = cached.json;
  } else {
    const url = `${ORDERS_API}?date=${encodeURIComponent(isoDate)}&department_id=${DEPARTMENT_ID}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      return { ok: false, date: isoDate, seats, tickets: [], error: `API lỗi ${res.status}` };
    }
    json = await res.json();
    ordersCache.set(isoDate, { json, at: Date.now() });
  }
  if (json.code !== 0 && json.code !== undefined) {
    return { ok: false, date: isoDate, seats, tickets: [], error: json.message || "API trả về lỗi." };
  }
  const tickets = (json.data || []).map(parseApiOrder).filter((t) => t.name);
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
