import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const LOCAL_FILE = join(DATA_DIR, "seats.json");
const SEED_FILE = join(__dirname, "..", "seats.json");

function token() {
  return process.env.GITHUB_TOKEN || "";
}

function repo() {
  return process.env.GITHUB_REPO || "khoigf/khoigf.github.io";
}

function branch() {
  return process.env.GITHUB_BRANCH || "main";
}

function seatsPath() {
  return process.env.GITHUB_PATH || "vecom/seats.json";
}

function ghHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token()}`,
    "User-Agent": "vecom-server",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

const CONFIG_PATH = "vecom/config.json";

let cache = null;

function contentsUrl(path) {
  return `https://api.github.com/repos/${repo()}/contents/${path}`;
}

function toBase64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function fromBase64(str) {
  return Buffer.from(str, "base64").toString("utf8");
}

export function isValidLayout(layout) {
  if (!layout || !Array.isArray(layout.groups) || layout.groups.length > 80) return false;
  let cells = 0;
  for (const group of layout.groups) {
    if (!group || !Array.isArray(group.cells)) return false;
    for (const row of group.cells) {
      if (!Array.isArray(row)) return false;
      cells += row.length;
      if (cells > 800) return false;
    }
  }
  return true;
}

function readLocalFile(path) {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return isValidLayout(data) ? data : null;
  } catch {
    return null;
  }
}

function writeLocal(layout) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCAL_FILE, JSON.stringify(layout, null, 2));
}

async function githubGet(path) {
  if (!token()) return null;
  const res = await fetch(`${contentsUrl(path)}?ref=${branch()}`, { headers: ghHeaders() });
  if (res.status === 404) return { missing: true };
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub đọc ${path} thất bại (${res.status})`);
  }
  const info = await res.json();
  return { sha: info.sha, text: fromBase64(info.content.replace(/\n/g, "")) };
}

async function githubPut(path, text, sha, message) {
  if (!token()) return false;
  const res = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: toBase64(text),
        branch: branch(),
      ...(sha ? { sha } : {})
    })
  });
  if (res.status === 409) return "conflict";
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub ghi ${path} thất bại (${res.status})`);
  }
  return true;
}

async function pushWithRetry(path, text, message) {
  for (let i = 0; i < 3; i++) {
    const current = await githubGet(path);
    const sha = current && !current.missing ? current.sha : undefined;
    if (current && !current.missing && current.text === text) return true;
    const result = await githubPut(path, text, sha, message);
    if (result !== "conflict") return result;
  }
  throw new Error("GitHub đang bận, thử lưu lại.");
}

export function getSeats() {
  return cache;
}

export async function loadSeats() {
  if (cache) return cache;
  try {
    const remote = await githubGet(seatsPath());
    if (remote && !remote.missing) {
      const parsed = JSON.parse(remote.text);
      if (isValidLayout(parsed)) {
        cache = parsed;
        writeLocal(parsed);
        return cache;
      }
    }
  } catch (err) {
    console.error("Không tải seats từ GitHub:", err.message);
  }
  cache = readLocalFile(LOCAL_FILE) || readLocalFile(SEED_FILE) || { version: 1, groups: [] };
  return cache;
}

export async function saveSeats(layout) {
  if (!isValidLayout(layout)) throw new Error("Sơ đồ không hợp lệ");
  cache = layout;
  writeLocal(layout);
  if (token()) {
    await pushWithRetry(
      seatsPath(),
      `${JSON.stringify(layout, null, 2)}\n`,
      "chore: cập nhật sơ đồ vé cơm"
    );
  }
  return cache;
}

export async function readGithubJson(path) {
  const remote = await githubGet(path);
  if (!remote || remote.missing) return null;
  try {
    return JSON.parse(remote.text);
  } catch {
    return null;
  }
}

export async function writeGithubJson(path, data, message) {
  await pushWithRetry(path, `${JSON.stringify(data, null, 2)}\n`, message);
}

export async function syncPublicConfig(publicUrl) {
  if (!token() || !publicUrl) return;
  const saveUrl = `${publicUrl.replace(/\/$/, "")}/api/seats`;
  const desired = `${JSON.stringify({ saveUrl, needSaveKey: false }, null, 2)}\n`;
  try {
    await pushWithRetry(CONFIG_PATH, desired, "chore: gắn server lưu sơ đồ vé cơm");
    console.log("Đã gắn saveUrl vào vecom/config.json:", saveUrl);
  } catch (err) {
    console.error("Không cập nhật config.json:", err.message);
  }
}
