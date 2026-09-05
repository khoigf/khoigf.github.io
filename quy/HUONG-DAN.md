# Quỹ nhóm — trang web + bot Telegram

Quản lý quỹ chung cho nhóm ~5–10 người:

- Trang: `https://khoigf.github.io/quy/` (hoặc `https://<server>/quy/`)
- Bot Telegram: lệnh `/quy`, `/dong`, `/chi`, `/lichquy`, …
- Dữ liệu: RAM + file local trên server ngay; GitHub `quy/fund.json` gom theo batch (mặc định **8 lệnh** hoặc **3 phút**, rồi ghi 1 commit). Tắt server sẽ flush còn lại.

Chạy chung server Docker với vé cơm (`vecom/bot`).

---

## Tính năng

| Việc | Web | Telegram |
|---|---|---|
| Xem tổng quỹ + tháng này | Có | `/quy` |
| Số dư từng người | Có | `/sodu` |
| Ai chưa đóng tháng này | Có | `/no` |
| Ghi đóng quỹ cá nhân | Có | `/dong An 100k` (thừa → cộng số dư; đủ dư tháng sau tự trừ, không nhắc) |
| Đóng thêm cả nhóm | Có | `/dongthem 50k` (trừ mỗi người + vào quỹ) |
| Chi từ quỹ | Có | `/chi 50k ăn tối` |
| Rút/hoàn cá nhân | Có | `/rut An 50k` |
| Thêm / xóa thành viên | Có | `/them An`, `/xoa An` |
| Mức đóng tháng | Có | `/muc 100000` |
| Hạn đóng (ngày) | Có | `/han 5` |
| Lịch nhắc tự động | — | `/lichquy 5 09:00` |

---

## Bot Telegram

### Cách A — bot quỹ riêng (khuyên dùng)

1. @BotFather → `/newbot` → lấy token.
2. Thêm bot vào nhóm quỹ.
3. Trên Render, Environment:

   | Key | Value |
   |---|---|
   | `QUY_BOT_TOKEN` | token bot quỹ |
   | `QUY_CHAT_ID` | id nhóm (tuỳ chọn; `/id` trong nhóm) |

4. Redeploy. Webhook: `/quy-telegram-webhook`.

### Cách B — dùng chung bot vé cơm

Để trống `QUY_BOT_TOKEN`. Server gắn thêm lệnh quỹ vào bot hiện có. Gõ `/trogiupquy` để xem lệnh.

---

## Trang quản lý

- Pages: `https://khoigf.github.io/quy/`
- Sau khi server chạy với `GITHUB_TOKEN`, file `quy/config.json` được gắn `apiUrl` trỏ tới Render.
- Cùng một nguồn dữ liệu với bot.

### Local

```bash
cd vecom/bot
cp .env.example .env   # điền GITHUB_TOKEN nếu muốn sync
npm install
npm start
```

Mở `http://127.0.0.1:3000/quy/`.

---

## Lệnh Telegram nhanh

```
/quy
/them An
/them Bình
/muc 100000
/han 5
/dong An 100k
/no
/lichquy 5 09:00
```

Số tiền chấp nhận: `100000`, `100.000`, `100k`, `1tr`.
