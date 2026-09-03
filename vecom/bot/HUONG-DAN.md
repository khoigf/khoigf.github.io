# Hướng dẫn: chatbot Telegram + lưu sơ đồ dùng chung

Một server làm cả hai việc:

- Bot Telegram (`/ve`, `/lich`) chụp sơ đồ gửi vào nhóm
- API lưu sơ đồ: ai sửa tên/chỗ trên trang, máy khác mở lại là thấy — không cần token, không cần mã

Máy chủ miễn phí dùng [Render](https://render.com) (Docker). Trang GitHub Pages vẫn dùng được sau khi server tự ghi URL vào `vecom/config.json`.

---

## A. Tạo bot Telegram

1. Mở Telegram, tìm **@BotFather**.
2. Gửi `/newbot`.
3. Đặt tên hiển thị (ví dụ `Vé cơm GF`).
4. Đặt username, phải kết thúc bằng `bot` (ví dụ `vecomgf_bot`).
5. BotFather trả về **token** dạng `123456789:AAH...` — copy cất riêng, không đưa vào Git.
6. Gửi `/setprivacy` → chọn bot → **Disable** (để bot đọc lệnh trong nhóm dễ hơn). Không bắt buộc nếu chỉ dùng lệnh `/ve`.
7. Mở bot vừa tạo, bấm **Start**.

### Lấy Chat ID nhóm

1. Tạo nhóm (hoặc dùng nhóm có sẵn).
2. **Add members** → thêm bot vào nhóm.
3. Trong nhóm gõ `/id` (sau khi server đã chạy). Bot trả lời `Chat ID: -100...`.
4. Copy số đó vào biến `TELEGRAM_CHAT_ID`.

Nếu server chưa chạy, nhắn bot ngoài nhóm rồi mở `https://api.telegram.org/botTOKEN/getUpdates` (thay TOKEN), tìm `"chat":{"id": ...}`.

---

## B. Tạo GitHub token (chỉ gắn trên server)

Token này nằm trên Render, **không** nhập trên từng máy người dùng. Dùng để:

- Ghi `vecom/seats.json` khi có người sửa sơ đồ (không mất khi server ngủ/restart)
- Tự điền `vecom/config.json` để trang `khoigf.github.io/vecom/` gọi đúng server

1. Vào [GitHub → Settings → Developer settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens).
2. **Generate new token**.
3. Repository access: **Only select repositories** → `khoigf/khoigf.github.io`.
4. Permissions → **Contents**: Read and write.
5. Generate và copy token (`github_pat_...`).

---

## C. Đưa code lên GitHub

Trong thư mục repo:

```bash
git add vecom render.yaml .dockerignore
git commit -m "feat: server vé cơm (bot Telegram + lưu sơ đồ)"
git push origin main
```

Pages sẽ có `https://khoigf.github.io/vecom/`. Lưu sơ đồ dùng chung chỉ hoạt động sau bước D.

---

## D. Deploy server miễn phí trên Render

1. Đăng ký [https://render.com](https://render.com) bằng GitHub (không cần thẻ nếu chọn Free).
2. Dashboard → **New** → **Web Service**.
3. Connect repo `khoigf/khoigf.github.io`.
4. Render đọc `render.yaml`. Nếu hỏi tay:
   - Runtime: **Docker**
   - Dockerfile path: `vecom/bot/Dockerfile`
   - Docker context: `.` (thư mục gốc repo)
   - Instance: **Free**
   - Health check: `/health`
5. **Environment** thêm:

   | Key | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | token BotFather |
   | `TELEGRAM_CHAT_ID` | id nhóm (có dấu `-`) |
   | `GITHUB_TOKEN` | PAT bước B |
   | `GITHUB_REPO` | `khoigf/khoigf.github.io` |
   | `TZ` | `Asia/Ho_Chi_Minh` |

   Không cần `PUBLIC_URL` — Render tự có `RENDER_EXTERNAL_URL`.
6. **Create Web Service**, đợi build xong (ảnh Playwright hơi lâu).
7. Copy URL dạng `https://vecom-xxxx.onrender.com`.
8. Mở URL đó trên trình duyệt: phải thấy trang sơ đồ.
9. Mở `https://vecom-xxxx.onrender.com/health` — phải ra `{"ok":true}`.
10. Xem log: có dòng `Telegram webhook:` và `Đã gắn saveUrl vào vecom/config.json`.

Sau 1–2 phút, `vecom/config.json` trên GitHub có `saveUrl`. Trang Pages cũng lưu được, không cần ai nhập thêm gì.

### Giữ server không ngủ (bắt buộc với gói Free)

Free Render **tắt sau ~15 phút** không có HTTP. `/ve` lúc đó phải khởi động lại Docker (chậm, dễ timeout Telegram).

Tạo monitor tại [https://uptimerobot.com](https://uptimerobot.com) (hoặc dịch vụ ping tương tự):

- Type: HTTP(s)
- URL: `https://khoigf-github-io.onrender.com/health`
- Interval: **5 phút**

Không ping thì sau vài ngày không dùng, `/ve` có thể im 5–6 phút và phải deploy lại.

Sau khi server đã thức, process tự ping `/health` mỗi 8 phút để đỡ ngủ tiếp trong ngày làm việc.

---

## E. Dùng trang và bot

**Người dùng (không làm gì thêm):**

- Vào `https://khoigf.github.io/vecom/` hoặc URL Render
- Sửa tên, thêm ô — tự lưu
- Máy khác mở lại trang (hoặc F5) là thấy
- Có thể bấm **Lưu sơ đồ** để ghi ngay

**Trong Telegram:**

| Lệnh | Việc |
|---|---|
| `/ve` | Ảnh vé hôm nay |
| `/ve 28/08/2026` | Đúng ngày |
| `/lich 09:00` | Tự gửi T2–T6 lúc 09:00 |
| `/lich 09:00 *` | Mỗi ngày |
| `/lich off` | Tắt lịch |
| `/id` | Xem chat id |

---

## F. Chạy thử trên máy mình (không bắt buộc)

Cần Node 18+ và lần đầu sẽ tải Chromium.

```bash
cd vecom/bot
cp .env.example .env
# điền TELEGRAM_BOT_TOKEN (GITHUB_TOKEN nếu muốn ghi GitHub)
npm install
npm start
```

Mở [http://127.0.0.1:3000](http://127.0.0.1:3000). Sửa tên sẽ gọi `POST /api/seats`. Bot dùng polling (không webhook). Nếu trước đó đã set webhook trên Render, tạm xóa:

```bash
curl "https://api.telegram.org/botTOKEN/deleteWebhook"
```

---

## Gỡ lỗi nhanh

- Bot không trả lời: log Render có webhook chưa; thử `/start` ngoài nhóm rồi `/ve`.
- `/ve` lỗi thiếu RAM: gói Free 512MB đôi khi không đủ Chromium — nâng instance hoặc đợi cold start xong rồi gửi lại.
- Trang Pages không lưu: đợi `config.json` có `saveUrl`, hard refresh. Hoặc dùng thẳng URL Render.
- Sơ đồ mất sau restart: thiếu `GITHUB_TOKEN` quyền Contents write.
- Build Docker fail: Dockerfile phải build từ **gốc repo** (có thư mục `vecom/`).
