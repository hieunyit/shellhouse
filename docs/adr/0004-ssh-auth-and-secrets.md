# ADR-004: Kết nối SSH, xác thực, host key và luồng secret

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Quyết định

### Ai giữ gì

| Dữ liệu                                             | Nằm ở                                             | Ghi chú                              |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| DEK (khoá vault), secret đã giải mã lâu dài         | Main                                              | Không bao giờ sang renderer          |
| known_hosts (DB của app + đọc `~/.ssh/known_hosts`) | Main                                              | Session Host hỏi qua `hostkey:check` |
| Thông tin xác thực của host đã lưu                  | Main giải mã → Session Host lúc mở session        | Renderer chỉ biết `hasPassword`      |
| Mật khẩu / passphrase / OTP người dùng gõ           | Renderer → **MessagePort của tab** → Session Host | Không đi qua main                    |

### Chuỗi xác thực (`src/session-host/ssh/auth.ts`)

`none` → agent → key đã lưu → IdentityFile / key mặc định (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`)
→ mật khẩu đã lưu → keyboard-interactive (≤ 3 lần) → hỏi mật khẩu (≤ 3 lần). Mỗi bước chỉ chạy khi
server còn cho phép loại đó, nên xác thực nhiều bước (key rồi OTP, `partialSuccess`) chạy tự nhiên.
Huỷ ô mật khẩu = dừng ngay.

### Host key

- Không có đường nào bỏ qua kiểm tra. Kết quả: `match` / `unknown` (hỏi) / `changed` (cảnh báo đỏ,
  xác nhận 2 bước) / `revoked` (từ chối, không hỏi).
- Ưu tiên loại key đã biết khi thương lượng (như OpenSSH) để tránh báo "đổi key" giả.
- Mặc định không có `ssh-rsa` (SHA-1).
- Fingerprint + randomart khớp từng ký tự với `ssh-keygen -lv` (có test đối chiếu).

### Thời gian chờ

TCP 15 s; từ TCP tới lúc nhận host key 20 s; thời gian người dùng trả lời prompt không bị tính.
Keepalive 15 s × 3.

### Kết thúc session & tự nối lại

Session Host gửi lý do: `normal` / `network` / `auth` / `hostkey` / `failed`. Renderer chỉ tự nối lại
(backoff 1→30 s) khi `network` **và** trước đó đã kết nối được.

### Chống chèn tham số

Hostname/username không được chứa khoảng trắng, ký tự điều khiển, hay bắt đầu bằng `-` — chuẩn bị
cho chế độ chạy `ssh` hệ thống (Phase 2).

## Phát hiện trong lúc làm (ghi lại để không lặp lại)

1. **`ssh2.utils.generateKeyPairSync` sinh ~0,4% key hỏng** (11/3000 không passphrase; ~0,75% có
   passphrase) mà cả ssh2 lẫn `ssh-keygen` đều không đọc được. Bộ đọc của ssh2 thì đúng (0/150 lỗi với
   key của ssh-keygen). → Tính năng tạo key (Phase 3) phải kiểm chứng key sau khi tạo (đọc lại + ký thử)
   hoặc dùng bộ tạo khác. Test dùng `generateTestKey()` đã kiểm chứng.
2. **`ssh-config` mặc định chạy lệnh trong `Match exec`** khi tính cấu hình → luôn gọi với
   `matchExec: false` (có test chứng minh lệnh không chạy).
3. **`ssh-config` là gói dual ESM/CJS với default export khác nhau** → chỉ dùng named export
   (`parse`, `LineType`). Lỗi này qua được unit test (ESM) nhưng hỏng trong bản build (CJS); E2E bắt được.
4. **Structured clone sao chép cả ArrayBuffer phía sau một view** → mọi frame gửi qua MessagePort
   phải là buffer riêng đúng kích thước (`standalone()`), nếu không sẽ gửi thừa dữ liệu của slab dùng chung.
5. **`@types/ssh2` khai báo sai**: callback `accept` của `window-change` không phải lúc nào cũng có.
