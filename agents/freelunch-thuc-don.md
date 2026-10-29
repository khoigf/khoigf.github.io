# Ảnh thực đơn FreeLunch

Dashboard `GET /xadmin/dashboard/index` (cần đăng nhập) nhúng:

`window.$json.currentFoodMenuFile.uri`

Đó là URL ảnh thực đơn tuần này, ví dụ `/files/attachments/...png`. File ảnh mở được không cần cookie.

Server vé cơm: `GET /menu` redirect tới URL đó. Telegram: `/menu`. Dùng chung `FREELUNCH_USERNAME` / `FREELUNCH_PASSWORD`.
