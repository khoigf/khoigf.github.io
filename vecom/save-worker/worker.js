const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Save-Key"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return json({ error: "Chỉ nhận POST" }, 405);
    }
    if (!env.GITHUB_TOKEN) {
      return json({ error: "Worker chưa có GITHUB_TOKEN" }, 500);
    }
    if (env.SAVE_KEY) {
      const key = request.headers.get("X-Save-Key") || "";
      if (key !== env.SAVE_KEY) return json({ error: "Sai mã lưu sơ đồ" }, 401);
    }

    let layout;
    try {
      layout = await request.json();
    } catch {
      return json({ error: "JSON không hợp lệ" }, 400);
    }
    if (!layout || !Array.isArray(layout.groups)) {
      return json({ error: "Thiếu groups trong sơ đồ" }, 400);
    }

    const repo = env.GITHUB_REPO || "khoigf/khoigf.github.io";
    const path = env.GITHUB_PATH || "vecom/seats.json";
    const branch = env.GITHUB_BRANCH || "main";
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "vecom-save-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const getRes = await fetch(`${api}?ref=${branch}`, { headers });
    let sha;
    if (getRes.ok) {
      const info = await getRes.json();
      sha = info.sha;
    } else if (getRes.status !== 404) {
      const err = await getRes.json().catch(() => ({}));
      return json({ error: err.message || "Không đọc được seats.json trên GitHub" }, 502);
    }

    const body = JSON.stringify(layout, null, 2);
    const putRes = await fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "chore: cập nhật sơ đồ vé cơm",
        content: toBase64(body),
        branch,
        ...(sha ? { sha } : {})
      })
    });
    if (!putRes.ok) {
      const err = await putRes.json().catch(() => ({}));
      return json({ error: err.message || "GitHub ghi file thất bại" }, 502);
    }
    return json({ ok: true });
  }
};
