# ADR-013: Đồng bộ đám mây (hướng B) — backend, tài khoản, mã hoá đầu-cuối

- Trạng thái: Đề xuất (chưa làm) — bản 2 (đã rà soát, xem mục 17)
- Ngày: 2026-09-30
- Liên quan: ADR-004 (secret), ADR-006 (vault)

Tài liệu này mô tả thiết kế đồng bộ dữ liệu Shellhouse giữa nhiều máy qua backend riêng, có tài
khoản, có chia sẻ theo nhóm (team). Mọi dữ liệu người dùng được **mã hoá đầu-cuối**: server chỉ lưu
và chuyển ciphertext, không bao giờ thấy mật khẩu tài khoản, mật khẩu/khoá SSH, tên host hay nội
dung snippet.

---

## 1. Mục tiêu và phạm vi

### Mục tiêu

1. Dùng cùng một bộ host / key / snippet / tài khoản S3 trên nhiều máy (Windows, macOS, Linux).
2. **Local-first**: app vẫn chạy đầy đủ khi không có mạng; đồng bộ khi có mạng, trong vài giây.
3. **Zero-knowledge**: lộ toàn bộ database server cũng không lộ dữ liệu người dùng.
4. Chia sẻ vault cho team, phân quyền, thu hồi quyền an toàn (xoay khoá).
5. Không làm yếu mô hình bảo mật hiện tại (vault cục bộ, renderer không thấy secret).

### Không nằm trong phạm vi (ít nhất trước giai đoạn 5)

- Đồng bộ log phiên, lịch sử terminal, file SFTP/S3.
- Web app đọc vault trên trình duyệt.
- **Đăng nhập SSO** (Google, GitHub, Microsoft, OIDC/SAML doanh nghiệp) — để **giai đoạn 5** (mục 12.6).
  Mọi phần trước đó phải giữ chỗ cho SSO: khoá thiết bị X25519, khoá khôi phục của tổ chức.

### Dữ liệu được đồng bộ

| Bảng cục bộ           | Loại bản ghi (record type) | Ghi chú                                                                  |
| --------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `groups`              | `group`                    | Cây nhóm                                                                 |
| `hosts`               | `host`                     | Trừ `last_used_at` (thuộc từng máy)                                      |
| `identities`          | `identity`                 | Có secret                                                                |
| `keys`                | `key`                      | Private key                                                              |
| `forwards`            | `forward`                  | Trừ `auto_start` (tuỳ máy)                                               |
| `snippets`            | `snippet`                  |                                                                          |
| `s3_accounts`         | `s3_account`               | Có secret; mục ghim đi kèm                                               |
| `known_hosts`         | `known_host`               | id = UUIDv5(`host:port:key_type`)                                        |
| workspace đã lưu      | `workspace`                |                                                                          |
| `settings` (một phần) | `setting`                  | Chỉ các cài đặt "theo người" (phím tắt, theme terminal), không đường dẫn |
| `command_history`     | `command_history`          | Tuỳ chọn, mặc định tắt                                                   |

**Không** đồng bộ: `vault_meta` (khoá cục bộ), đường dẫn trên máy (editor, thư mục log), trạng thái
tab/cửa sổ, `last_used_at`, `auto_start`.

---

## 2. Mô hình đe doạ

| Kẻ tấn công                                   | Phải chống được / cách chống                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Đọc được toàn bộ DB / backup của server       | Không giải mã được gì; không dò mật khẩu offline hiệu quả (OPAQUE + Argon2id)                               |
| Nghe lén mạng                                 | TLS 1.3; payload đã mã hoá sẵn                                                                              |
| Server độc hại: sửa / giả bản ghi             | Không làm được (không có VK, AEAD có AD); client **không tin** metadata server (cờ xoá, loại…)              |
| Server độc hại: tráo khoá công khai khi share | Phát hiện qua mã an toàn / chữ ký của tổ chức (5.8)                                                         |
| Đánh cắp access / refresh token               | Token gắn thiết bị: mọi request (kể cả refresh) phải ký bằng khoá thiết bị nằm trong keychain               |
| Đánh cắp recovery key                         | Khôi phục cần thêm mã gửi email (+ 2FA nếu bật) — RK một mình không chiếm được tài khoản                    |
| Máy người dùng bị mất                         | Thu hồi thiết bị từ máy khác; vault cục bộ vẫn khoá bằng mật khẩu                                           |
| Thành viên team bị xoá                        | Xoay khoá vault; dữ liệu mới không đọc được                                                                 |
| Thành viên team (editor) giả mạo người khác   | Chữ ký tác giả trên bản ghi của vault chia sẻ (5.2)                                                         |
| Dò mật khẩu online, liệt kê email             | Backoff theo (email, IP) + CAPTCHA, **không khoá cứng** (tránh bị khoá tài khoản ác ý); phản hồi giống nhau |

**Chấp nhận** (ghi rõ để không hiểu nhầm):

- Server độc hại có thể **từ chối phục vụ**, xoá toàn bộ dữ liệu, **giấu** một số bản ghi, hoặc trả
  **bản cũ hơn** (rollback). Tác động bị giới hạn: máy đã có bản mới giữ bản mới (gộp theo HLC, mục
  6.4); nhưng máy mới cài có thể nhận bản cũ. Chống hoàn toàn cần nhật ký ký số dạng Merkle —
  để sau (mục 16).
- Server biết metadata (mục 5.7).
- Máy người dùng đã bị cài mã độc thì không bảo vệ được.

---

## 3. Kiến trúc tổng thể

```
┌──────────────────────── Shellhouse app (mỗi máy) ────────────────────────┐
│ Renderer ──IPC──► Main process                                           │
│  (UI trạng thái     ├─ Store (SQLite, vault cục bộ như hiện nay)          │
│   đồng bộ, đăng     ├─ SyncEngine: outbox → push, pull → merge → apply   │
│   nhập, thiết bị)   ├─ AccountCrypto: khoá tài khoản / vault / thiết bị  │
│                     └─ ApiClient (HTTPS) + StreamClient (WebSocket)      │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ TLS 1.3 — REST /v1 + WSS /v1/stream
┌──────────────────────────────▼───────────── Backend ──────────────────────┐
│ CDN / WAF (chống DDoS, CAPTCHA cho /auth)                                 │
│ API (stateless, N instance)                                               │
│  ├─ Auth: OPAQUE, phiên, 2FA, thiết bị, khôi phục                         │
│  ├─ Sync: vault, bản ghi, revision, lịch sử                               │
│  ├─ Org: team, thành viên, lời mời, audit                                 │
│  └─ Stream: WebSocket thông báo "vault X có revision mới"                 │
│ Worker: dọn tombstone / lịch sử / token hết hạn, gửi email, xoá tài khoản │
│ PostgreSQL (dữ liệu chính)   Redis (rate limit, pub/sub, trạng thái login) │
│ Email (Postmark/SES)         Object storage (backup DB mã hoá)             │
│ KMS (khoá OPAQUE của server, khoá mã hoá TOTP)                            │
└───────────────────────────────────────────────────────────────────────────┘
```

- Đồng bộ chạy trong **main process** (đã có DB và khoá vault). Renderer chỉ nhận trạng thái qua IPC,
  không bao giờ thấy khoá tài khoản hay khoá vault.
- WebSocket chỉ báo "có thay đổi", client tự kéo về qua REST → mất kết nối WebSocket không mất dữ liệu.
- Redis chỉ giữ dữ liệu tạm (rate limit, trạng thái đăng nhập dở dang, access token). Mất Redis = mọi
  máy phải refresh token, không mất dữ liệu.

---

## 4. Tài khoản và phân cấp khoá

### 4.1. Phân cấp khoá

```
Mật khẩu tài khoản
  └─ OPAQUE (RFC 9807, KSF = Argon2id; tham số mục tiêu m=64 MiB, t=3)
       ├─ xác thực với server (server không nhận mật khẩu, không có hash để dò offline)
       └─ export_key (64 B, chỉ client có)
            └─ EK = KDF(export_key, id=1, ctx="sh_enc__")        ← khoá bọc tài khoản
                 └─ AK = 32 B ngẫu nhiên                          ← Account Key (không đổi khi đổi mật khẩu)
                      ├─ khoá riêng X25519 (mã hoá) + Ed25519 (ký) của tài khoản
                      └─ VK_personal = 32 B ngẫu nhiên            ← Vault Key của vault cá nhân
                           └─ mỗi bản ghi: XChaCha20-Poly1305(VK, payload, AD)

Recovery key RK (32 B ngẫu nhiên, hiển thị 1 lần)  ─ bọc AK lần thứ hai (4.6)
Khoá thiết bị: Ed25519 (ký request) + X25519 (nhận khoá từ máy khác — dùng ở giai đoạn 5 / SSO,
               và khi thêm máy bằng mã QR), sinh trên từng máy, cất trong keychain hệ điều hành
Vault chia sẻ: VK_shared bọc bằng crypto_box_seal(X25519 public key của từng thành viên) + chữ ký
```

- `KDF` = `crypto_kdf_derive_from_key` (BLAKE2b) của libsodium; `ctx` đúng 8 byte. Mã hoá đối xứng
  dùng đúng hàm `seal/open` của vault hiện tại (XChaCha20-Poly1305, `nonce(24) ‖ ciphertext ‖ tag(16)`,
  có AD).
- **Vì sao có AK riêng**: đổi mật khẩu chỉ cần bọc lại AK (vài chục byte), không phải mã hoá lại dữ
  liệu; khôi phục bằng recovery key cũng chỉ mở AK.
- **Vì sao VK tách khỏi AK**: vault chia sẻ cần khoá riêng để trao cho người khác mà không lộ AK.

### 4.2. Khoá lưu trên máy (để đồng bộ nền, không bắt đăng nhập lại mỗi lần mở app)

Sau khi đăng nhập, main lưu vào DB cục bộ (bảng `account_keys`, mục 6.2) **AK, khoá riêng tài khoản
và các VK**, tất cả bọc bằng **DEK của vault cục bộ** (cơ chế `vault.encryptString` hiện có). Hệ quả:

- Mở khoá vault cục bộ (mật khẩu, hoặc "nhớ trên máy" bằng keychain) là đồng bộ chạy được, không cần
  gõ mật khẩu tài khoản lại.
- Khoá vault cục bộ (Lock) = khoá luôn đồng bộ (không còn khoá trong bộ nhớ).
- Access/refresh token lưu cùng chỗ (cũng bọc bằng DEK). Khoá riêng thiết bị lưu bằng `safeStorage`.

### 4.3. Đăng ký

1. Người dùng nhập email + mật khẩu (≥ 12 ký tự; đo độ mạnh bằng zxcvbn; tuỳ chọn so với danh sách
   mật khẩu đã lộ qua k-anonymity của HIBP).
2. `register/start`: OPAQUE registration. **Email đã tồn tại vẫn trả kết quả bình thường** (chống liệt
   kê); ở bước finish, server không tạo tài khoản mà gửi email "có người thử đăng ký bằng địa chỉ của
   bạn" cho chủ email.
3. Client sinh AK, cặp khoá tài khoản, VK cá nhân, RK, khoá thiết bị.
4. `register/finish`: gửi các khoá **đã bọc** + khoá công khai + `recovery_verifier` + thiết bị đầu tiên.
5. App hiển thị **Recovery kit**: RK dạng 13 nhóm × 4 ký tự base32 (có checksum) + QR; bắt người dùng
   xác nhận đã lưu (gõ lại 2 nhóm ngẫu nhiên). Có nút lưu PDF / in.
6. Server gửi email xác minh. Chưa xác minh: dùng được 7 ngày, sau đó chỉ đọc (không push).

### 4.4. Đăng nhập

1. `login/start` (OPAQUE KE1) → server trả KE2. Email không tồn tại vẫn trả KE2 giả (thư viện OPAQUE
   hỗ trợ "fake record") → không phân biệt được. Trạng thái đăng nhập dở dang lưu Redis 2 phút.
2. Client hoàn tất KE3 → có `export_key` → suy ra EK → mở AK → mở khoá riêng và các VK.
3. `login/finish`: server kiểm KE3; nếu bật 2FA → trả `next: "2fa"` (chưa cấp phiên).
4. Máy **mới**: thiết bị ở trạng thái `pending`, gửi email "thiết bị mới đăng nhập" + thông báo tới
   các máy đang hoạt động (kèm tên máy, hệ điều hành, vị trí gần đúng theo IP, và **mã 6 ký tự** hiển
   thị trên máy mới). Duyệt từ máy cũ (so mã) → `active`.
   - Tài khoản cá nhân: mặc định **duyệt tự động nếu đã qua 2FA**, còn không thì duyệt qua máy cũ hoặc
     link email. Org có thể bắt buộc duyệt từ máy cũ / admin.
   - Duyệt chỉ là **cấp quyền tải ciphertext**; giải mã vẫn cần mật khẩu (hoặc khoá chuyển qua X25519
     của thiết bị ở giai đoạn 5).
5. Server cấp access token (15 phút) + refresh token (30 ngày, trượt, xoay vòng), **gắn với thiết bị**.

### 4.5. Phiên và ràng buộc thiết bị

- Access token: chuỗi ngẫu nhiên 256-bit (không dùng JWT, để thu hồi được ngay); server lưu SHA-256
  của token trong Redis kèm `user_id, device_id, expires`.
- **Mọi request có token (kể cả `/auth/refresh` và WebSocket)** phải kèm chữ ký thiết bị:
  ```
  X-Device-Id: <uuid>
  X-Timestamp: <unix ms theo giờ server>   (lệch ≤ 5 phút)
  X-Nonce: <16 B base64url>                (server nhớ 10 phút → chống phát lại)
  X-Signature: base64url(Ed25519(device_sk,
      "sh-req-v1" \n METHOD \n HOST \n PATH?QUERY \n X-Timestamp \n X-Nonce \n
      SHA-256(access_or_refresh_token) \n SHA-256(body)))
  ```
  Token hoặc refresh token bị lộ mà không có khoá thiết bị thì vô dụng.
- **Đồng hồ máy sai**: client tính độ lệch từ header `Date` của mọi response (và `/v1/meta`) rồi ký theo
  giờ server → máy lệch giờ vẫn dùng được.
- Refresh token dùng một lần; dùng lại token cũ → thu hồi cả chuỗi (dấu hiệu bị đánh cắp) + email.
- Máy offline quá 30 ngày → refresh hết hạn → đăng nhập lại (dữ liệu cục bộ vẫn nguyên, outbox đẩy sau).

### 4.6. Đổi mật khẩu

1. Xác thực lại (OPAQUE) + 2FA → `reauth_token` (5 phút).
2. Client chạy OPAQUE registration mới, bọc lại AK bằng EK mới; gửi `opaque_record` + `wrapped_ak`
   trong một giao dịch. Server thu hồi mọi phiên **trừ** phiên hiện tại, gửi email.
3. Máy khác: bị đăng xuất khỏi server → lần tới phải đăng nhập bằng mật khẩu mới. Vault cục bộ trên
   máy đó **vẫn mở được bằng mật khẩu cũ khi offline** cho tới khi máy đăng nhập lại (lúc đó app đổi
   luôn mật khẩu vault cục bộ, mục 5.6). Đây là giới hạn đã biết — ghi trong thông báo đổi mật khẩu.

### 4.7. Quên mật khẩu → khôi phục bằng Recovery key

- Lúc đăng ký: `RK_enc = KDF(RK, 1, "sh_rkenc")`, `RK_auth = KDF(RK, 2, "sh_rkaut")`. Server lưu
  `wrapped_ak_recovery = seal(RK_enc, AK)` và `recovery_verifier` = khoá công khai Ed25519 sinh từ
  seed `RK_auth`.
- Khôi phục (3 yếu tố):
  1. `recover/start {email}` → server gửi **mã 8 số qua email** (luôn trả 202, chống liệt kê).
  2. `recover/verify {email, email_code}` → `{recovery_id, challenge}`.
  3. Client ký `challenge` bằng khoá từ `RK_auth`; nếu tài khoản bật 2FA thì kèm TOTP.
  4. `recover/finish` → server kiểm chữ ký → client mở AK, đặt mật khẩu mới (như 4.6), **sinh RK mới**.
     Thu hồi mọi phiên và thiết bị khác; email cảnh báo tới địa chỉ tài khoản.
- **Mất cả mật khẩu và recovery key = mất dữ liệu.** Đây là cái giá của zero-knowledge; nói rõ khi đăng
  ký và nhắc lưu recovery kit định kỳ (mỗi 6 tháng, tắt được).
- Tuỳ chọn cho org (giai đoạn 4): "khoá khôi phục của tổ chức" — AK của thành viên được bọc thêm bằng
  khoá công khai của org; chỉ bật khi thành viên đồng ý, có audit. Đây cũng là nền cho SSO (giai đoạn 5).

### 4.8. 2FA

- TOTP (RFC 6238), secret lưu phía server đã mã hoá bằng khoá KMS của server (đây là yếu tố xác thực,
  không phải dữ liệu người dùng). 10 mã dự phòng dùng một lần (lưu hash Argon2id).
- WebAuthn / passkey (giai đoạn 3 hoặc sau).
- 2FA bảo vệ việc **lấy ciphertext và thao tác tài khoản**; giải mã vẫn cần mật khẩu.

### 4.9. Đổi email

Email là định danh đăng nhập và nằm trong OPAQUE (client identity) → đổi email = đăng ký lại OPAQUE:
xác thực lại + 2FA → gửi mã tới **email mới** → `email/change/finish` với `opaque_record` mới (AK không
đổi) → email thông báo tới **email cũ** (có link hoàn tác 72 giờ).

### 4.10. Xoá tài khoản, xuất dữ liệu

- Xoá: xác thực lại + 2FA → nếu đang là **owner duy nhất** của vault chia sẻ / org → phải chuyển quyền
  hoặc xoá chúng trước. Sau đó đánh dấu xoá, 7 ngày có thể huỷ; hết hạn worker xoá cứng mọi bản ghi,
  khoá, thiết bị; backup cũ hết hạn theo vòng đời backup (30 ngày). Email xác nhận.
- Xuất: client tải mọi bản ghi, giải mã, ghi file backup mã hoá của Shellhouse (định dạng đã có).

---

## 5. Mã hoá dữ liệu

### 5.1. Nguyên thuỷ mật mã (đều có trong libsodium, đang dùng sẵn)

| Việc                        | Thuật toán                                                               |
| --------------------------- | ------------------------------------------------------------------------ |
| Mã hoá đối xứng có xác thực | XChaCha20-Poly1305 (IETF), nonce ngẫu nhiên 24 B                         |
| Dẫn xuất khoá con           | BLAKE2b (`crypto_kdf_derive_from_key`)                                   |
| Mã hoá cho người nhận       | X25519 sealed box (`crypto_box_seal`)                                    |
| Chữ ký                      | Ed25519                                                                  |
| Băm mật khẩu (trong OPAQUE) | Argon2id (m=64 MiB, t=3 — giống vault cục bộ)                            |
| Đăng nhập không lộ mật khẩu | OPAQUE-3DH, ristretto255 — thư viện `@serenity-kit/opaque` (Node + WASM) |

Không tự chế thuật toán. Mọi định dạng có số phiên bản (`v1`) để nâng cấp.

### 5.2. Định dạng bản ghi

Payload (trước khi mã hoá) là JSON:

```json
{
  "v": 1,
  "type": "host",
  "deleted": false,
  "fields": {
    "label": { "v": "prod-web-1", "t": "0192f3c1a2b0.0003.8e1f2a7c3b9d0e11" },
    "hostname": { "v": "10.0.1.15", "t": "0192f3c1a2b0.0003.8e1f2a7c3b9d0e11" },
    "port": { "v": 22, "t": "0192f3c1a2b0.0000.8e1f2a7c3b9d0e11" },
    "groupId": { "v": "0192f2…", "t": "0192f3c19e11.0000.4d0c9b1a2f3e4d5c" },
    "secret": { "v": "base64(password)", "t": "0192f3c1a2b0.0003.8e1f2a7c3b9d0e11" }
  },
  "deletedAt": null,
  "author": null
}
```

- Mỗi trường có dấu thời gian lai **HLC** `t = <ms hex 12>.<bộ đếm hex 4>.<device id rút gọn hex 16>`
  (8 byte device id → gần như không trùng; so sánh theo chuỗi là đúng thứ tự). Dùng để gộp xung đột theo
  từng trường (mục 6.4).
- **Trạng thái xoá nằm trong payload** (`deleted` + HLC xoá). Cờ `deleted` ở server chỉ là gợi ý để dọn
  dẹp; **client chỉ xoá khi payload đã giải mã nói xoá** → server không xoá hộ được.
- Secret nằm **trong** payload (payload đã được mã hoá cả khối) — không mã hoá hai lớp.
- **Không nén** (bản ghi nhỏ; nén trước khi mã hoá có thể lộ nội dung qua độ dài). **Độn** tới bội số
  của 256 B (ẩn độ dài thật: server không đoán được "đây là private key RSA 4096").
- `author` (vault chia sẻ, giai đoạn 4): `{user_id, sig}` — chữ ký Ed25519 của tài khoản tác giả lên
  `(vault_id, record_id, HLC lớn nhất, SHA-256 của fields)`. Client hiện cảnh báo nếu chữ ký sai hoặc tác
  giả không phải thành viên có quyền ghi.

Mã hoá (AD viết bằng dấu `/` để không nhầm với bảng):

```
ciphertext = seal(VK[key_version], pad(payload),
                  AD = "sh/rec/v1/" + vault_id + "/" + record_id + "/" + key_version)
```

AD gắn ciphertext với đúng vault, đúng id, đúng phiên bản khoá → server không tráo được bản ghi giữa
các id / vault. Loại bản ghi (`type`) nằm **trong** payload → server không biết có bao nhiêu host, bao
nhiêu key.

### 5.3. Bọc khoá

| Đối tượng                         | Cách bọc                                                                                                                                             | AD                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| AK                                | `seal(EK, AK)`                                                                                                                                       | `sh/ak/v1/<user_id>`                   |
| AK (khôi phục)                    | `seal(RK_enc, AK)`                                                                                                                                   | `sh/ak-rk/v1/<user_id>`                |
| Khoá riêng X25519 / Ed25519       | `seal(AK, sk)`                                                                                                                                       | `sh/sk/v1/<user_id>/x25519` (…ed25519) |
| VK vault cá nhân                  | `seal(AK, VK)`                                                                                                                                       | `sh/vk/v1/<vault_id>/<key_version>`    |
| VK vault chia sẻ (mỗi thành viên) | `crypto_box_seal(VK ‖ vault_id ‖ key_version, member_x25519_pk)` + chữ ký Ed25519 người trao lên (vault_id, key_version, member_id, SHA-256(sealed)) | —                                      |

### 5.4. Xoay khoá vault (khi xoá thành viên hoặc nghi lộ)

1. Owner sinh `VK[n+1]`, bọc cho các thành viên còn lại; `POST /rotation` → server đặt
   `rotating_to = n+1`.
2. Client của owner tải mọi bản ghi, giải mã bằng `VK[n]`, mã hoá lại bằng `VK[n+1]`, đẩy lên theo lô.
   Job **tiếp tục được** nếu bị ngắt (đẩy lại các bản ghi còn `key_version = n`).
3. Trong lúc xoay, server từ chối ghi với `key_version = n` (`409 rotation_in_progress`). Client của
   thành viên khác gặp lỗi này (hoặc bản ghi outbox cũ mã hoá bằng khoá cũ) → tải `VK[n+1]` qua
   `bootstrap`, **mã hoá lại từ dữ liệu cục bộ** rồi đẩy lại.
4. `rotation/complete`: server kiểm mọi bản ghi đã ở `n+1`, **xoá lịch sử phiên bản** mã hoá bằng khoá
   cũ, xoá `VK[n]` đã bọc của mọi người.
5. Thành viên bị xoá vẫn giữ được bản sao cũ họ đã tải về — không thu hồi được quá khứ, chỉ chặn dữ
   liệu mới (giống mọi hệ E2EE). Nên nhắc owner đổi luôn mật khẩu/key SSH nhạy cảm.

### 5.5. Thêm máy bằng mã QR (tuỳ chọn, giai đoạn 3)

Máy mới hiện QR chứa `device_x25519_pk` + mã phiên → máy cũ (đã đăng nhập) quét, xác nhận → gửi AK
bằng `crypto_box_seal(AK, device_x25519_pk)` qua server → máy mới đăng nhập mà **không cần gõ mật khẩu**
(vẫn phải đặt mật khẩu vault cục bộ). Cùng cơ chế sẽ dùng cho SSO (giai đoạn 5).

### 5.6. Vault cục bộ và tài khoản

- Vault cục bộ giữ nguyên thiết kế ADR-006: DEK cục bộ bọc bằng KEK = Argon2id(mật khẩu, salt cục bộ).
- Khi bật đồng bộ trên máy, người dùng chọn:
  - **Dùng mật khẩu tài khoản cho vault trên máy này** (mặc định, một mật khẩu cho mọi thứ): app bọc lại
    DEK bằng KEK từ mật khẩu tài khoản. Mở app vẫn **không cần mạng**.
  - **Giữ mật khẩu vault riêng** (cho người muốn tách biệt).
- Mở app = một lần Argon2id cục bộ; đăng nhập server = thêm một lần Argon2id trong OPAQUE (~0,5 s mỗi
  lần, chỉ khi đăng nhập lại).

### 5.7. Metadata server biết được

`user_id`, email, số vault, số bản ghi, kích thước đã độn, revision, thời điểm sửa, thiết bị nào sửa,
IP (lưu dạng băm có muối xoay vòng, 30 ngày), tên và nền tảng thiết bị (có thể mã hoá bằng AK — mặc
định mã hoá, server chỉ thấy nền tảng).

### 5.8. Chống tráo khoá công khai khi chia sẻ

Server trả khoá công khai của người nhận khi chia sẻ → server độc hại có thể trả khoá của chính nó.

- Hiển thị **mã an toàn** (safety number: 60 chữ số từ SHA-512 của hai khoá công khai sắp xếp) để hai
  người so qua kênh khác, như Signal. Đã so thì app nhớ ("verified") và cảnh báo nếu khoá đổi.
- Org: admin ký khoá công khai của thành viên bằng khoá Ed25519 của org khi duyệt vào nhóm; thành viên
  khác chỉ tin khoá có chữ ký hợp lệ. Khoá công khai của org được so mã an toàn một lần khi gia nhập.

---

## 6. Giao thức đồng bộ

### 6.1. Mô hình

- Mỗi vault có một **dãy revision** tăng dần trên server (`vaults.last_revision`). Mỗi lần ghi một
  bản ghi, server gán `revision = last_revision + 1` trong cùng giao dịch, **giữ khoá dòng vault tới khi
  commit** → các revision được commit đúng thứ tự, người đọc `since` không bao giờ bỏ sót (không có
  "khoảng trống" revision chưa commit).
- Client nhớ `cursor = revision lớn nhất đã kéo về` cho từng vault.
- Server **không bao giờ gộp** dữ liệu (không đọc được); chỉ kiểm tra tương tranh lạc quan bằng
  `base_revision`. Gộp xung đột làm ở client.
- `changes` trả **trạng thái mới nhất** của mỗi bản ghi (không trả từng phiên bản trung gian).

### 6.2. Phía client — migration 0008

```sql
-- Bản ghi thuộc vault nào (NULL = vault cá nhân). Thêm cho mọi bảng được đồng bộ.
ALTER TABLE groups      ADD COLUMN vault_id TEXT;
ALTER TABLE hosts       ADD COLUMN vault_id TEXT;
ALTER TABLE identities  ADD COLUMN vault_id TEXT;
ALTER TABLE keys        ADD COLUMN vault_id TEXT;
ALTER TABLE forwards    ADD COLUMN vault_id TEXT;
ALTER TABLE snippets    ADD COLUMN vault_id TEXT;
ALTER TABLE s3_accounts ADD COLUMN vault_id TEXT;
-- known_hosts: thêm cột id (UUIDv5) + vault_id.

CREATE TABLE account_keys (          -- khoá tài khoản trên máy này, bọc bằng DEK cục bộ (4.2)
  kind TEXT NOT NULL,                -- ak | x25519_sk | ed25519_sk | vk | access | refresh
  ref TEXT NOT NULL DEFAULT '',      -- vault_id + key_version với kind = vk
  value_enc BLOB NOT NULL,
  PRIMARY KEY (kind, ref)
);
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- user_id, device_id, hlc cuối…
CREATE TABLE sync_state (
  vault_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  key_version INTEGER NOT NULL,
  role TEXT NOT NULL,                -- owner | editor | viewer
  last_pull_at INTEGER, last_push_at INTEGER,
  status TEXT NOT NULL DEFAULT 'idle', -- idle | syncing | error | paused
  error TEXT
);
CREATE TABLE sync_records (          -- trạng thái đồng bộ của từng bản ghi cục bộ
  record_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  server_revision INTEGER,           -- NULL = chưa từng đẩy
  field_hlc TEXT NOT NULL DEFAULT '{}',
  deleted_hlc TEXT
);
CREATE TABLE sync_outbox (
  record_id TEXT PRIMARY KEY,        -- mỗi bản ghi một dòng: gộp nhiều lần sửa trước khi đẩy
  vault_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  changed_fields TEXT NOT NULL,      -- JSON: ["label","port"] ; ["*"] = xoá
  first_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
```

**Quy tắc ghi**: mọi service ghi dữ liệu (HostService, SnippetService, S3Accounts…) gọi
`sync.touch(type, id, fields)` **trong cùng transaction** — hàm này cấp HLC mới cho các trường, cập nhật
`sync_records.field_hlc`, ghi/gộp dòng `sync_outbox` → không bao giờ mất thay đổi chưa đẩy.

**Không dựa vào cascade của SQLite**: `ON DELETE CASCADE / SET NULL` không đi qua service nên không vào
outbox. Mọi xoá là xoá mềm qua service; khi xoá group, service tự cập nhật host con (đưa về nhóm cha)
và ghi outbox cho từng host. Có test quét: mọi cột tham chiếu đều có đường xử lý trong service.

### 6.3. Chu trình

```
Khi: mở khoá vault, đăng nhập, có thay đổi cục bộ (debounce 1 s), thông báo WebSocket, mỗi 5 phút.

0. BOOTSTRAP  (lần đầu / khi có account.changed / khi gặp 409 key_version)
              lấy danh sách vault, VK đã bọc, vai trò → cập nhật account_keys, sync_state
1. PULL       mỗi vault: GET /changes?since=cursor (lặp tới khi more=false)
              với mỗi bản ghi: giải mã (lỗi giải mã → cách ly, báo lỗi, không dừng cả vault)
              → gộp vào DB cục bộ (6.4) → áp dụng theo thứ tự group → identity/key → host → forward
              → cursor = next (cùng transaction với việc áp dụng)
2. PUSH       lấy outbox (≤ 200 bản ghi / lô), dựng payload ĐẦY ĐỦ từ DB cục bộ + field_hlc
              → mã hoá → POST records:batch (Idempotency-Key = hash của lô)
              ok        → server_revision = revision, xoá dòng outbox
              conflict  → nhận bản trên server → gộp (6.4) → đẩy lại (tối đa 3 vòng, sau đó để lần sau)
              gone      → bản ghi đã bị dọn trên server (6.5)
3. Lỗi mạng / 5xx / 429 → backoff lũy thừa + jitter (1 s → 5 phút).
   Lỗi 4xx khác → dừng vault đó, hiện lỗi trong UI, các vault khác vẫn chạy.
```

Bản ghi do chính máy này đẩy sẽ quay lại trong `changes` → bỏ qua nếu `revision ≤ server_revision`
đã biết.

### 6.4. Gộp xung đột (theo từng trường, "sửa sau thắng")

- Với mỗi trường: giữ giá trị có HLC lớn hơn. HLC nhất quán kể cả khi đồng hồ các máy lệch (mỗi khi
  nhận dữ liệu: `hlc = max(local, remote) + 1`; từ chối HLC ở tương lai quá 1 ngày so với giờ server).
- Xoá: thắng nếu `deleted_hlc` lớn hơn HLC mọi trường. Sửa sau xoá → bản ghi "sống lại" (thông báo).
- **Tham chiếu gãy** (host trỏ tới group đã bị xoá) → đưa host về "Ungrouped", không lỗi.
- **Vòng lặp cây nhóm** (máy A đưa G1 vào G2, máy B đưa G2 vào G1 khi offline): sau khi áp dụng, phát
  hiện vòng → nhóm có HLC `parentId` nhỏ hơn bị đưa về gốc, ghi outbox để các máy khác theo.
- Hai máy cùng sửa một trường offline → giữ bản mới hơn; bản thua còn trong **lịch sử phiên bản** (server
  giữ 30 ngày) → khôi phục được từ menu "Version history".
- Viewer (chỉ đọc): client không cho sửa bản ghi của vault đó; server cũng từ chối.

### 6.5. Xoá và dọn dẹp

- Xoá = bản ghi có payload `deleted: true` + HLC xoá (tombstone).
- Server xoá cứng tombstone sau **90 ngày** (worker). Client có `cursor` cũ hơn mốc dọn dẹp → server trả
  `410 cursor_expired` → client **đồng bộ lại toàn bộ**: tải mọi bản ghi hiện có; bản ghi cục bộ không
  còn trên server mà **không có trong outbox** → coi là đã xoá (chuyển vào thùng rác cục bộ 30 ngày,
  không xoá hẳn); bản ghi trong outbox → đẩy lên như bản ghi mới.
- Push một bản ghi đã bị dọn (`base_revision` không null nhưng server không còn) → `gone` → client xử lý
  như trên.

### 6.6. Lần đầu bật đồng bộ trên máy đã có dữ liệu

- Tạo tài khoản mới: đẩy toàn bộ dữ liệu cục bộ lên vault cá nhân.
- Tài khoản đã có dữ liệu, máy cũng có dữ liệu: **luôn sao lưu dữ liệu máy vào file trước**, rồi hỏi:
  **Gộp** (mặc định; trùng hostname + port + username thì coi là một, giữ bản sửa sau), **Chỉ dùng dữ
  liệu trên đám mây**, hoặc **Huỷ**.

### 6.7. Giới hạn

| Mục                                | Giới hạn |
| ---------------------------------- | -------- |
| Kích thước một bản ghi (đã mã hoá) | 64 KiB   |
| Số bản ghi / lô push               | 200      |
| Số bản ghi / trang pull            | 500      |
| Số bản ghi / vault                 | 50 000   |
| Thiết bị / tài khoản               | 20       |
| Lịch sử phiên bản                  | 30 ngày  |
| Tombstone                          | 90 ngày  |

---

## 7. Mô hình kết nối

### 7.1. Giao vận

- `https://api.shellhouse.app/v1/...` — TLS 1.3 (tối thiểu 1.2), HTTP/2, HSTS.
- Client dùng `net` của Electron (tôn trọng proxy hệ thống và chứng chỉ doanh nghiệp). Không pin
  chứng chỉ mặc định (hay gãy sau proxy doanh nghiệp); an toàn dữ liệu đã do E2EE bảo đảm.
- JSON UTF-8; bytes mã hoá bằng base64url không padding. Body > 1 KiB nén gzip (chỉ ở tầng HTTP — nội
  dung đã mã hoá nên không có rủi ro như nén trước mã hoá).
- Mọi request có `X-Client: shellhouse/<version> (<os>)`. Server trả `426 client_outdated` kèm phiên bản
  tối thiểu khi đổi định dạng không tương thích. **Chính sách**: `/v1` giữ tương thích ngược ≥ 12 tháng.
- Request ghi có `Idempotency-Key`; server lưu kết quả 24 giờ → gửi lại do mất mạng nhận đúng kết quả cũ.

### 7.2. WebSocket thông báo

```
wss://api.shellhouse.app/v1/stream
→ client: { "type": "hello", "token": "<access>", "device": "<id>", "ts": …, "nonce": …, "sig": … }
← server: { "type": "ready", "expires_at": … }
← server: { "type": "vault.changed", "vault_id": "…", "revision": 1043 }
← server: { "type": "vault.keys", "vault_id": "…" }            (xoay khoá / đổi thành viên)
← server: { "type": "device.pending", "device_id": "…", "code": "7K3-Q9P" }
← server: { "type": "account.changed", "what": "password" | "keys" | "membership" | "revoked" }
→ client: { "type": "reauth", "token": "<access mới>", … }       (trước khi token hết hạn)
↔ ping/pong 30 s; mất kết nối → nối lại với backoff 1 s → 60 s + jitter; nối lại xong PULL một lần
```

Server nhiều instance: thông báo phát qua Redis pub/sub kênh `vault:<id>` và `user:<id>`. Token hết hạn
mà không `reauth` → server đóng kết nối (client nối lại).

### 7.3. Mã lỗi

```json
{ "error": { "code": "conflict", "message": "Record changed on the server", "details": {} } }
```

| HTTP | code                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| 400  | `invalid_request`                                                                |
| 401  | `unauthenticated`, `token_expired`, `bad_signature`, `clock_skew`                |
| 403  | `forbidden`, `device_pending`, `device_revoked`, `email_unverified`, `read_only` |
| 404  | `not_found`                                                                      |
| 409  | `conflict`, `rotation_in_progress`, `stale_key_version`                          |
| 410  | `cursor_expired`, `gone`                                                         |
| 413  | `record_too_large`                                                               |
| 422  | `limit_exceeded`                                                                 |
| 426  | `client_outdated`                                                                |
| 429  | `rate_limited` (+ `Retry-After`)                                                 |

### 7.4. Giới hạn tốc độ (Redis, cửa sổ trượt)

| Nhóm                            | Giới hạn                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `login/*` theo IP               | 20 / 10 phút, vượt → CAPTCHA (Turnstile)                                 |
| `login/*` theo (email, IP)      | backoff tăng dần sau 5 lần sai (1 s → 15 phút); **không khoá tài khoản** |
| `login/*` theo email (mọi IP)   | > 50 lần sai / giờ → bắt CAPTCHA + email cảnh báo chủ tài khoản          |
| `register`, `recover/*` theo IP | 5 / giờ                                                                  |
| Gửi email theo địa chỉ          | 5 / giờ                                                                  |
| API đã đăng nhập theo tài khoản | 600 / phút                                                               |
| WebSocket / thiết bị            | 1 kết nối                                                                |

---

## 8. API (v1)

Quy ước: `🔒` = cần access token + chữ ký thiết bị (4.5). Bytes = base64url.

### 8.1. Xác thực

| Method  | Path                           | Mô tả                                                                                                        |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| POST    | `/v1/auth/register/start`      | `{email, opaque_request}` → `{opaque_response}`                                                              |
| POST    | `/v1/auth/register/finish`     | Tạo tài khoản (body bên dưới) → `202`; gửi email xác minh                                                    |
| POST    | `/v1/auth/email/verify`        | `{token}`                                                                                                    |
| POST    | `/v1/auth/email/resend`        | `{email}` (luôn `204`)                                                                                       |
| POST    | `/v1/auth/login/start`         | `{email, opaque_ke1}` → `{login_id, opaque_ke2}`                                                             |
| POST    | `/v1/auth/login/finish`        | `{login_id, opaque_ke3, device}` → phiên, hoặc `{next: "2fa" \| "device_approval", code}`                    |
| POST    | `/v1/auth/2fa/verify`          | `{login_id, method: "totp" \| "webauthn" \| "backup_code", code \| assertion}`                               |
| GET     | `/v1/auth/device/status`       | `{login_id}` → chờ duyệt thiết bị (long-poll 30 s)                                                           |
| POST 🔒 | `/v1/auth/refresh`             | `{refresh_token}` → token mới (xoay vòng). **Cần chữ ký thiết bị**                                           |
| POST 🔒 | `/v1/auth/logout`              | Thu hồi phiên hiện tại                                                                                       |
| POST 🔒 | `/v1/auth/reauth/start`        | OPAQUE KE1 → KE2                                                                                             |
| POST 🔒 | `/v1/auth/reauth/finish`       | KE3 (+ 2FA) → `{reauth_token}` (5 phút) — dùng cho đổi mật khẩu/email, 2FA, xoá tài khoản                    |
| POST 🔒 | `/v1/auth/password`            | `{reauth_token, opaque_record, wrapped_ak}`                                                                  |
| POST 🔒 | `/v1/auth/email/change/start`  | `{reauth_token, new_email}` → gửi mã tới email mới                                                           |
| POST 🔒 | `/v1/auth/email/change/finish` | `{code, opaque_record, wrapped_ak}`                                                                          |
| POST    | `/v1/auth/recover/start`       | `{email}` → luôn `202`; gửi mã qua email                                                                     |
| POST    | `/v1/auth/recover/verify`      | `{email, email_code}` → `{recovery_id, challenge, totp_required}`                                            |
| POST    | `/v1/auth/recover/finish`      | `{recovery_id, signature, totp?, opaque_record, wrapped_ak, wrapped_ak_recovery, recovery_verifier, device}` |

`register/finish`:

```json
{
  "email": "an@example.com",
  "opaque_record": "…",
  "keys": {
    "wrapped_ak": "…",
    "wrapped_ak_recovery": "…",
    "recovery_verifier": "…",
    "x25519_pk": "…",
    "ed25519_pk": "…",
    "wrapped_x25519_sk": "…",
    "wrapped_ed25519_sk": "…"
  },
  "device": {
    "id": "…",
    "name_enc": "…",
    "platform": "win32-x64",
    "ed25519_pk": "…",
    "x25519_pk": "…"
  },
  "personal_vault": { "id": "…", "wrapped_vk": "…", "key_version": 1 }
}
```

Phiên trả về (login/finish, 2fa/verify, refresh):

```json
{
  "access_token": "…",
  "expires_in": 900,
  "refresh_token": "…",
  "user_id": "…",
  "device_status": "active"
}
```

### 8.2. Tài khoản, 2FA, thiết bị

| Method    | Path                                           | Mô tả                                                         |
| --------- | ---------------------------------------------- | ------------------------------------------------------------- |
| GET 🔒    | `/v1/account`                                  | Email, gói, trạng thái 2FA, ngày tạo                          |
| GET 🔒    | `/v1/account/keys`                             | Các khoá đã bọc + khoá công khai                              |
| DELETE 🔒 | `/v1/account`                                  | `{reauth_token}` → đánh dấu xoá (7 ngày)                      |
| POST 🔒   | `/v1/account/delete/cancel`                    | Huỷ xoá                                                       |
| POST 🔒   | `/v1/account/2fa/totp/setup`                   | `{reauth_token}` → `{otpauth_uri}`                            |
| POST 🔒   | `/v1/account/2fa/totp/enable`                  | `{code}` → `{backup_codes[]}`                                 |
| DELETE 🔒 | `/v1/account/2fa/totp`                         | `{reauth_token}`                                              |
| POST 🔒   | `/v1/account/2fa/backup-codes`                 | `{reauth_token}` → tạo lại mã dự phòng                        |
| POST 🔒   | `/v1/account/2fa/webauthn/options` · `/verify` | Đăng ký passkey                                               |
| GET 🔒    | `/v1/devices`                                  | Danh sách thiết bị (tên đã mã hoá, nền tảng, lần cuối)        |
| PATCH 🔒  | `/v1/devices/{id}`                             | `{name_enc}`                                                  |
| POST 🔒   | `/v1/devices/{id}/approve`                     | `{code}` — phải khớp mã hiển thị trên máy mới                 |
| DELETE 🔒 | `/v1/devices/{id}`                             | Thu hồi (xoá phiên, token, khoá công khai)                    |
| POST 🔒   | `/v1/devices/transfer`                         | Chuyển AK sang máy mới qua QR (5.5): `{device_id, sealed_ak}` |

### 8.3. Đồng bộ

| Method  | Path                                    | Mô tả                                                                                                       |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GET 🔒  | `/v1/sync/bootstrap`                    | Mọi vault truy cập được: `{vaults:[{id, kind, role, key_version, rotating_to, wrapped_vk, last_revision}]}` |
| GET 🔒  | `/v1/vaults/{id}/changes?since=&limit=` | Trạng thái mới nhất của các bản ghi đổi sau `since`                                                         |
| POST 🔒 | `/v1/vaults/{id}/records:batch`         | Ghi nhiều bản ghi                                                                                           |
| GET 🔒  | `/v1/vaults/{id}/records/{rid}/history` | Các phiên bản cũ (30 ngày)                                                                                  |
| POST 🔒 | `/v1/vaults/{id}/records/{rid}/restore` | `{revision}` → ghi lại phiên bản cũ thành revision mới                                                      |

`GET /changes`:

```json
{
  "records": [
    {
      "id": "0192…",
      "revision": 1041,
      "key_version": 1,
      "ciphertext": "…",
      "updated_at": 1790000000000,
      "updated_by": "device-uuid"
    }
  ],
  "next": 1043,
  "more": false
}
```

`POST records:batch` (header `Idempotency-Key`):

```json
{
  "ops": [
    {
      "id": "0192…",
      "base_revision": 1041,
      "key_version": 1,
      "ciphertext": "…",
      "tombstone": false
    },
    {
      "id": "0193…",
      "base_revision": null,
      "key_version": 1,
      "ciphertext": "…",
      "tombstone": false
    }
  ]
}
```

```json
{
  "results": [
    { "id": "0192…", "status": "ok", "revision": 1044 },
    {
      "id": "0193…",
      "status": "conflict",
      "current": { "revision": 1042, "key_version": 1, "ciphertext": "…" }
    }
  ]
}
```

- `base_revision: null` = tạo mới (trùng id đã có → `conflict` kèm bản hiện tại).
- `tombstone` chỉ là gợi ý cho worker dọn dẹp (6.5); client không tin cờ này khi đọc.
- Cả lô chạy trong **một transaction với savepoint cho từng op**: op lỗi không hỏng lô, và mọi revision
  của lô liên tiếp nhau.
- Trạng thái `status`: `ok` · `conflict` · `gone` · `stale_key_version` · `forbidden` (viewer).

### 8.4. Tổ chức (team) và vault chia sẻ — giai đoạn 4

| Method    | Path                                  | Mô tả                                                                                      |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| POST 🔒   | `/v1/orgs`                            | `{name_enc, org_x25519_pk, org_ed25519_pk, wrapped_org_sk}`                                |
| GET 🔒    | `/v1/orgs/{id}`                       | Thông tin, thành viên, vai trò                                                             |
| POST 🔒   | `/v1/orgs/{id}/invites`               | `{email, role}` → gửi email mời                                                            |
| POST 🔒   | `/v1/invites/{token}/accept`          | Chấp nhận → chờ admin duyệt                                                                |
| POST 🔒   | `/v1/orgs/{id}/members/{uid}/confirm` | Admin duyệt: `{key_signature}` (ký khoá công khai thành viên, 5.8)                         |
| PATCH 🔒  | `/v1/orgs/{id}/members/{uid}`         | Đổi vai trò                                                                                |
| DELETE 🔒 | `/v1/orgs/{id}/members/{uid}`         | Xoá thành viên (kéo theo xoay khoá các vault họ có quyền)                                  |
| GET 🔒    | `/v1/orgs/{id}/members/{uid}/keys`    | Khoá công khai + chữ ký org — **chỉ thành viên cùng org** (không tra cứu theo email tự do) |
| POST 🔒   | `/v1/vaults`                          | Tạo vault chia sẻ `{id, org_id, name_enc, members:[{user_id, role, wrapped_vk}]}`          |
| PUT 🔒    | `/v1/vaults/{id}/members/{uid}`       | `{role, wrapped_vk, key_version}`                                                          |
| DELETE 🔒 | `/v1/vaults/{id}/members/{uid}`       | Thu quyền (client owner phải xoay khoá ngay sau đó)                                        |
| POST 🔒   | `/v1/vaults/{id}/rotation`            | Bắt đầu xoay khoá `{new_key_version, members:[{user_id, wrapped_vk}]}`                     |
| POST 🔒   | `/v1/vaults/{id}/rotation/complete`   | Kết thúc (server kiểm mọi bản ghi đã ở key_version mới, xoá lịch sử khoá cũ)               |
| POST 🔒   | `/v1/vaults/{id}/transfer`            | Chuyển quyền owner                                                                         |
| GET 🔒    | `/v1/orgs/{id}/audit?cursor=`         | Nhật ký (chỉ metadata)                                                                     |

Vai trò vault: `owner` (quản lý thành viên, xoay khoá), `editor` (đọc/ghi), `viewer` (chỉ đọc — server
từ chối ghi). Lưu ý: viewer vẫn giải mã được secret trong vault (cần để kết nối) — "chỉ đọc" không có
nghĩa là "không thấy mật khẩu".

### 8.5. Khác

| Method | Path         | Mô tả                                                          |
| ------ | ------------ | -------------------------------------------------------------- |
| GET    | `/v1/meta`   | Giờ server, phiên bản client tối thiểu, tính năng bật, bảo trì |
| GET    | `/v1/health` | Kiểm tra sống (không lộ thông tin)                             |
| WS 🔒  | `/v1/stream` | Mục 7.2                                                        |

---

## 9. Schema server (PostgreSQL)

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email CITEXT NOT NULL UNIQUE,
  email_verified_at TIMESTAMPTZ,
  opaque_record BYTEA NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delete_after TIMESTAMPTZ                       -- đang chờ xoá
);

CREATE TABLE user_keys (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped_ak BYTEA NOT NULL,
  wrapped_ak_recovery BYTEA NOT NULL,
  recovery_verifier BYTEA NOT NULL,              -- Ed25519 public key
  x25519_pk BYTEA NOT NULL, ed25519_pk BYTEA NOT NULL,
  wrapped_x25519_sk BYTEA NOT NULL, wrapped_ed25519_sk BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_enc BYTEA, platform TEXT NOT NULL, app_version TEXT,
  ed25519_pk BYTEA NOT NULL UNIQUE, x25519_pk BYTEA NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  approval_code_hash BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);
CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_hash BYTEA NOT NULL UNIQUE,            -- SHA-256
  family UUID NOT NULL,                          -- chuỗi xoay vòng (dùng lại → thu hồi cả family)
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_family ON sessions (family);

CREATE TABLE one_time_tokens (                   -- xác minh email, khôi phục, đổi email, lời mời
  hash BYTEA PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  data JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE totp (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc BYTEA NOT NULL,                     -- mã hoá bằng khoá KMS của server
  backup_code_hashes TEXT[] NOT NULL,
  last_used_step BIGINT,                         -- chống dùng lại cùng một mã TOTP
  enabled_at TIMESTAMPTZ
);

CREATE TABLE idempotency (
  user_id UUID NOT NULL, key TEXT NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE orgs (
  id UUID PRIMARY KEY, name_enc BYTEA NOT NULL,
  x25519_pk BYTEA NOT NULL, ed25519_pk BYTEA NOT NULL,
  plan TEXT NOT NULL DEFAULT 'team', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE org_members (
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL CHECK (status IN ('invited','accepted','confirmed')),
  key_signature BYTEA,                           -- chữ ký của org lên khoá công khai thành viên
  wrapped_org_sk BYTEA,                          -- chỉ owner/admin: khoá riêng của org bọc cho họ
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE vaults (
  id UUID PRIMARY KEY,
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- vault cá nhân
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,          -- vault chia sẻ
  name_enc BYTEA,
  key_version INT NOT NULL DEFAULT 1,
  rotating_to INT,
  last_revision BIGINT NOT NULL DEFAULT 0,
  CHECK ((owner_user_id IS NULL) <> (org_id IS NULL))
);
CREATE TABLE vault_members (                     -- quyền (vault cá nhân: một dòng owner)
  vault_id UUID REFERENCES vaults(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (vault_id, user_id)
);
CREATE TABLE vault_keys (                        -- VK đã bọc, theo từng phiên bản khoá
  vault_id UUID NOT NULL, user_id UUID NOT NULL, key_version INT NOT NULL,
  wrapped_vk BYTEA NOT NULL,
  granted_by UUID, grant_signature BYTEA,
  PRIMARY KEY (vault_id, user_id, key_version),
  FOREIGN KEY (vault_id, user_id) REFERENCES vault_members ON DELETE CASCADE
);

CREATE TABLE records (
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  id UUID NOT NULL,
  revision BIGINT NOT NULL,
  key_version INT NOT NULL,
  tombstone BOOLEAN NOT NULL DEFAULT false,      -- gợi ý dọn dẹp, client không tin
  ciphertext BYTEA NOT NULL,
  size INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES devices(id) ON DELETE SET NULL,
  PRIMARY KEY (vault_id, id),
  UNIQUE (vault_id, revision)
);

CREATE TABLE record_history (                    -- giữ 30 ngày
  vault_id UUID NOT NULL, id UUID NOT NULL, revision BIGINT NOT NULL,
  key_version INT NOT NULL, ciphertext BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, updated_by UUID,
  PRIMARY KEY (vault_id, id, revision)
);
CREATE INDEX record_history_age ON record_history (updated_at);

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID, user_id UUID, device_id UUID,
  action TEXT NOT NULL,                          -- login, device.approve, vault.member.add, …
  target TEXT, ip_hash BYTEA, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_org ON audit_events (org_id, id);
CREATE INDEX audit_user ON audit_events (user_id, id);
```

Ghi một lô (một transaction; mỗi op một savepoint):

```sql
SELECT last_revision, key_version, rotating_to FROM vaults WHERE id = $vault FOR UPDATE; -- khoá dòng vault tới commit
-- với mỗi op:
--   quyền ghi? key_version hợp lệ? (rotating_to IS NOT NULL → chỉ nhận key_version = rotating_to)
--   SELECT revision FROM records WHERE vault_id=$vault AND id=$id  → so base_revision
--   INSERT INTO record_history SELECT … FROM records WHERE vault_id=$vault AND id=$id;  -- bản cũ
--   rev := rev + 1; INSERT INTO records … ON CONFLICT (vault_id, id) DO UPDATE …;
UPDATE vaults SET last_revision = rev WHERE id = $vault;
COMMIT; → NOTIFY qua Redis "vault:<id>" revision = rev
```

Khoá dòng `vaults` tuần tự hoá ghi trong một vault — đơn giản và đủ nhanh (một vault vài chục máy).

**Worker định kỳ**: xoá tombstone > 90 ngày, `record_history` > 30 ngày, `idempotency` > 24 giờ,
`one_time_tokens` hết hạn, phiên hết hạn, tài khoản quá hạn xoá.

---

## 10. Hạ tầng và vận hành

| Thành phần      | Lựa chọn đề xuất                                                             | Ghi chú                             |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| Ngôn ngữ API    | TypeScript (Node 22, Fastify) — dùng chung zod schema và code mã hoá với app | Hoặc Go nếu cần hiệu năng           |
| DB              | PostgreSQL 16 (Neon / RDS / Cloud SQL), PITR 7 ngày                          | Một region chính                    |
| Cache / pub-sub | Redis (Upstash / ElastiCache)                                                | Không cần bền                       |
| Chạy            | Fly.io hoặc Railway (≥ 2 instance), cùng region với DB                       | Sau này Kubernetes nếu lớn          |
| Email           | Postmark (giao dịch)                                                         | SPF / DKIM / DMARC                  |
| Bí mật server   | KMS: khoá OPAQUE server, khoá mã hoá TOTP, muối băm IP                       | Xem ghi chú về khoá OPAQUE bên dưới |
| Giám sát        | OpenTelemetry → Grafana Cloud; Sentry (lọc PII)                              | Không log body, không log token     |
| Backup          | pg_dump mã hoá hằng ngày → R2 khác region, giữ 30 ngày                       | Diễn tập khôi phục mỗi quý          |
| CDN / WAF       | Cloudflare (+ Turnstile CAPTCHA)                                             | Chống DDoS, chặn bot trên /auth     |

**Khoá OPAQUE của server** (server setup): mất khoá này = **mọi người phải khôi phục bằng recovery key**
(không đăng nhập được bằng mật khẩu). Xoay khoá cũng vậy. Vì thế: lưu trong KMS, có bản sao lưu ngoại
tuyến tách biệt (chia khoá 2-trong-3), chỉ xoay khi nghi lộ.

Chi phí ước lượng: dưới 1.000 người dùng ~ **20–60 USD/tháng**; 10.000 người dùng ~ 150–300 USD/tháng
(dữ liệu mỗi người rất nhỏ: vài trăm KB).

Pháp lý: chính sách quyền riêng tư, điều khoản dịch vụ, quy trình xoá/xuất dữ liệu (GDPR), nơi đặt dữ
liệu (EU/US) cho khách doanh nghiệp.

---

## 11. Thay đổi phía app

| Module (mới / sửa)                        | Việc                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `packages/crypto` (dùng chung với server) | seal/open, KDF, định dạng bản ghi, HLC, vector test                         |
| `src/main/account/keys.ts`                | Phân cấp khoá (4.1), lưu/mở `account_keys` bằng DEK cục bộ (4.2)            |
| `src/main/account/opaque.ts`              | OPAQUE client (`@serenity-kit/opaque`)                                      |
| `src/main/account/api-client.ts`          | REST + ký request + bù lệch giờ + refresh + retry/backoff + Idempotency-Key |
| `src/main/account/stream.ts`              | WebSocket, reauth, nối lại, phát sự kiện                                    |
| `src/main/account/device-keys.ts`         | Sinh / cất khoá thiết bị bằng `safeStorage`                                 |
| `src/main/sync/touch.ts`                  | `sync.touch()` gọi trong transaction của mọi service ghi                    |
| `src/main/sync/records.ts`                | Ánh xạ bảng cục bộ ↔ payload (từng loại bản ghi, có version)                |
| `src/main/sync/merge.ts`                  | Gộp theo trường, tham chiếu gãy, vòng lặp cây nhóm                          |
| `src/main/sync/engine.ts`                 | Bootstrap / pull / push / lịch chạy / trạng thái / thùng rác cục bộ         |
| Service hiện có                           | Bỏ phụ thuộc cascade SQLite; xoá mềm + ghi outbox cho bản ghi phụ thuộc     |
| `migrations/0008_sync.sql`                | Mục 6.2                                                                     |
| `src/shared/ipc.ts`                       | `account:*`, `sync:status`, `sync:now`, `sync:pause`, `devices:*`           |
| Renderer: Settings → **Account & Sync**   | Đăng ký / đăng nhập / 2FA / recovery kit / thiết bị / trạng thái / tạm dừng |
| Renderer: thanh công cụ                   | Biểu tượng trạng thái đồng bộ (đã đồng bộ / đang đồng bộ / lỗi / offline)   |
| Renderer: host, snippet…                  | "Version history", thùng rác, vault nào (cá nhân / team), quyền viewer      |
| Renderer: Share (giai đoạn 4)             | Tạo vault team, mời, đổi vai trò, mã an toàn                                |

---

## 12. Kế hoạch thực hiện (từng bước)

Ước lượng cho **một lập trình viên toàn thời gian**, đã gồm test; cộng 20% đệm cho việc phát sinh.

### 12.1. Giai đoạn 0 — Chuẩn bị (1 tuần)

1. Chốt ADR này; chọn nhà cung cấp hạ tầng; tên miền `api.` + email gửi đi (SPF/DKIM/DMARC).
2. Repo backend + CI (lint, test, build image), môi trường `dev` / `staging` / `prod`.
3. Tách `packages/crypto` dùng chung cho app và server, cùng bộ test vector.
4. Dựng thử OPAQUE (`@serenity-kit/opaque`) trong Electron main + Node server; đo thời gian Argon2id.
5. Chính sách quyền riêng tư, điều khoản (bản nháp).

### 12.2. Giai đoạn 1 — Backend lõi (4–5 tuần)

1. Khung Fastify + zod + migration Postgres (mục 9) + Redis + worker.
2. OPAQUE register/login (start/finish), bản ghi giả chống liệt kê email.
3. Phiên: access/refresh xoay vòng, thu hồi theo family, ký request theo thiết bị (kể cả refresh), chống
   phát lại, bù lệch giờ.
4. Email: xác minh, gửi lại, "thiết bị mới", "có người thử đăng ký".
5. Thiết bị: pending/active/revoked, mã duyệt, long-poll trạng thái.
6. Đồng bộ: `bootstrap`, `changes`, `records:batch` (một transaction + savepoint, revision liên tiếp,
   conflict, gone, history, idempotency).
7. WebSocket + reauth + Redis pub/sub.
8. Rate limit + CAPTCHA, mã lỗi chuẩn, log không PII, OpenTelemetry.
9. Test: unit, tích hợp với Postgres thật (testcontainers), test bảo mật (IDOR, phát lại, refresh cũ,
   chữ ký sai, lệch giờ, vượt giới hạn).
10. Triển khai staging.

### 12.3. Giai đoạn 2 — Engine đồng bộ trong app (4–5 tuần)

1. `account/keys` + vector test đối chiếu server; lưu khoá bằng DEK cục bộ.
2. Migration 0008; `sync.touch()` trong mọi service ghi; **bỏ phụ thuộc cascade** (xoá mềm có ghi
   outbox cho bản ghi phụ thuộc); test quét "mọi thay đổi đều vào outbox".
3. Ánh xạ từng loại bản ghi + test khứ hồi (DB → payload → DB giống hệt).
4. HLC + gộp theo trường + tham chiếu gãy + vòng lặp cây nhóm; **property test** (fast-check): N máy
   thay đổi ngẫu nhiên, đồng bộ theo mọi thứ tự → hội tụ về cùng kết quả.
5. Engine: bootstrap / pull / push, backoff, `410`, thùng rác cục bộ, lần đầu bật đồng bộ (sao lưu → gộp
   / dùng đám mây).
6. **Người dùng hiện có**: luồng "Bật đồng bộ" từ vault cục bộ sẵn có (chọn dùng chung mật khẩu hay
   không, 5.6).
7. UI: đăng ký + recovery kit, đăng nhập + 2FA + chờ duyệt thiết bị, danh sách thiết bị, trạng thái.
8. E2E: hai instance app + server cục bộ → sửa ở A thấy ở B < 3 giây; A/B cùng sửa offline → đúng quy
   tắc gộp; thu hồi B → B bị đăng xuất; server trả dữ liệu hỏng → bản ghi bị cách ly, không mất dữ liệu.

### 12.4. Giai đoạn 3 — Hoàn thiện và beta (3 tuần)

1. Đổi mật khẩu, đổi email, khôi phục (email + RK + 2FA), xoá / huỷ xoá / xuất tài khoản.
2. TOTP + mã dự phòng; thêm máy bằng QR (5.5); WebAuthn nếu kịp.
3. Version history + khôi phục phiên bản; thùng rác.
4. Giám sát, cảnh báo, backup + diễn tập khôi phục; sao lưu khoá OPAQUE server.
5. Kiểm thử tải (10.000 tài khoản giả, 1.000 kết nối WebSocket, 50.000 bản ghi / vault).
6. **Rà soát bảo mật độc lập** (pentest + review mật mã) — bắt buộc trước khi mở cho người ngoài.
7. Beta kín → beta mở; `security.txt`, email báo lỗi bảo mật.

### 12.5. Giai đoạn 4 — Team (5–6 tuần)

1. Org, lời mời, duyệt thành viên + ký khoá công khai, mã an toàn.
2. Vault chia sẻ, chọn vault khi tạo host, di chuyển host giữa vault (mã hoá lại bằng VK đích).
3. Chữ ký tác giả trên bản ghi vault chia sẻ.
4. Xoá thành viên + xoay khoá (tiếp tục được khi bị ngắt; client khác xử lý `stale_key_version`).
5. Khoá khôi phục của tổ chức (tuỳ chọn, cần thành viên đồng ý).
6. Audit log + trang quản trị trong app; chuyển quyền owner.
7. Thanh toán (Stripe/Paddle), giới hạn theo gói.

### 12.6. Giai đoạn 5 — Đăng nhập SSO (4–6 tuần, sau khi team ổn định)

SSO (OIDC: Google, GitHub, Microsoft Entra; SAML cho doanh nghiệp) chỉ **xác thực danh tính**, không cho
ra khoá giải mã. Thiết kế đã chừa chỗ:

1. Đăng nhập: OIDC Authorization Code + PKCE qua trình duyệt hệ thống (loopback redirect), server đổi
   code lấy `sub` + email đã xác minh, liên kết với tài khoản (`user_identities` mới).
2. Mở khoá dữ liệu — **"thiết bị tin cậy"** (như Bitwarden / 1Password):
   - Máy đã có AK giữ AK bọc bằng khoá thiết bị (X25519 + keychain).
   - Máy mới sau khi SSO: xin duyệt; một máy tin cậy của người dùng hoặc **admin org** (dùng khoá khôi
     phục của tổ chức, 4.7) gửi AK qua `crypto_box_seal(AK, device_x25519_pk)` (cơ chế 5.5).
   - Không còn máy tin cậy nào và org không bật khoá khôi phục → phải dùng recovery key.
3. Tuỳ chọn "SSO + mật khẩu vault" cho tổ chức muốn giữ zero-knowledge tuyệt đối (SSO để vào, mật khẩu
   để giải mã).
4. SCIM (tự tạo / xoá thành viên theo hệ thống nhân sự) — sau nữa.

**Tổng**: bản cá nhân dùng được thật (giai đoạn 0–3) **~12–15 tuần**; team +5–6 tuần; SSO +4–6 tuần.

---

## 13. Kiểm thử

- **Vector mật mã** cố định (khoá, nonce, AD, kết quả) chạy ở cả app và server.
- **Property test** gộp xung đột (fast-check): N máy, thao tác ngẫu nhiên (sửa, xoá, di chuyển nhóm),
  mạng chập chờn → mọi máy hội tụ, không vòng lặp nhóm, không tham chiếu gãy.
- **Chaos**: cắt mạng giữa lúc push, server trả 500 ngẫu nhiên, trả trùng response (idempotency), trả
  ciphertext hỏng, trả cờ `tombstone` giả (client không được xoá).
- **Bảo mật**: dùng token của A đọc vault của B (403/404), chữ ký sai, nonce lặp, refresh cũ, refresh
  không chữ ký, viewer cố ghi, thiết bị đã thu hồi, liệt kê email qua register/login/recover.
- **Xoay khoá**: bị ngắt giữa chừng rồi tiếp tục; máy khác đang offline có outbox cũ.
- **Nâng cấp**: payload v1 → v2 (client cũ gặp trường lạ phải giữ nguyên, không xoá).

---

## 14. Rủi ro

| Rủi ro                                     | Giảm thiểu                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Người dùng mất cả mật khẩu và recovery key | Bắt xác nhận đã lưu recovery kit; nhắc định kỳ; thêm máy bằng QR; khôi phục theo org    |
| Lỗi gộp làm mất dữ liệu                    | Outbox bền, history 30 ngày, thùng rác cục bộ, property test, sao lưu trước lần gộp đầu |
| Sai sót mật mã                             | Chỉ dùng libsodium + OPAQUE có sẵn, không tự chế; review độc lập                        |
| Mất khoá OPAQUE của server                 | KMS + sao lưu ngoại tuyến chia khoá; mọi người vẫn khôi phục được bằng RK               |
| Server bị chiếm                            | Zero-knowledge; client không tin metadata; khoá server trong KMS; log truy cập          |
| Chi phí và trách nhiệm vận hành            | Bắt đầu nhỏ (1 region); chỉ mở rộng khi có người dùng thật                              |

---

## 15. Câu hỏi còn mở

1. Tự host backend cho doanh nghiệp (Docker image)? Thiết kế cho phép, cần cấu hình URL server trong app
   và tách phần thanh toán.
2. Có đồng bộ lịch sử lệnh không (mặc định tắt vì có thể chứa thông tin nhạy cảm)?
3. Mô hình giá: miễn phí 1 máy / trả phí nhiều máy, hay miễn phí cá nhân / trả phí team?
4. Có cần web vault (đọc trên trình duyệt) không? Nếu có, OPAQUE + libsodium chạy được trên WASM.

---

## 16. Để sau

- Nhật ký bản ghi có ký số dạng Merkle (chống server giấu / rollback bản ghi).
- Passkey làm yếu tố **giải mã** (WebAuthn PRF) thay cho mật khẩu.
- Chia sẻ một host lẻ cho người ngoài org (link có hạn).

---

## 17. Lịch sử sửa đổi

**Bản 2 (2026-09-30)** — rà soát lại bản 1, các thay đổi:

- _Bảo mật (nghiêm trọng)_: client không tin cờ xoá của server (trạng thái xoá nằm trong payload);
  `/auth/refresh` và WebSocket bắt buộc chữ ký thiết bị; khôi phục cần mã email (+2FA) ngoài recovery
  key; bỏ khoá tài khoản sau N lần sai (thay bằng backoff + CAPTCHA); bỏ tra cứu khoá công khai theo
  email tự do; chữ ký ký thêm HOST và hash token.
- _Thiết kế thiếu_: lưu AK/VK/token trên máy bọc bằng DEK cục bộ (đồng bộ nền); cột `vault_id` cho các
  bảng cục bộ; không dựa vào cascade SQLite; phát hiện vòng lặp cây nhóm; xử lý bản ghi đã bị dọn
  (`gone`) và thùng rác cục bộ; client khác xử lý đúng khi đang xoay khoá; xoá lịch sử khoá cũ khi xoay;
  đổi email; xoá tài khoản khi đang sở hữu vault chia sẻ; bù lệch giờ; WebSocket reauth; mã duyệt thiết
  bị; thêm máy bằng QR.
- _Mã hoá_: bỏ nén trước khi mã hoá; HLC dùng 8 byte device id; AD dùng dấu `/` (bảng bản 1 bị vỡ do ký
  tự `|`); đơn giản hoá liên kết vault cục bộ ↔ mật khẩu tài khoản (5.6); ghi rõ rủi ro mất khoá OPAQUE
  của server; mô hình đe doạ ghi rõ server có thể giấu / rollback bản ghi.
- _Schema_: tách `vault_members` (quyền) và `vault_keys` (khoá theo phiên bản); `UNIQUE(vault_id,
revision)`; bảng `idempotency`, `one_time_tokens`; index; `last_used_step` cho TOTP; lô ghi dùng một
  transaction + savepoint.
- _Kế hoạch_: ước lượng thực tế hơn (12–15 tuần cho bản cá nhân); thêm luồng cho người dùng hiện có;
  **SSO chuyển thành giai đoạn 5** với thiết kế "thiết bị tin cậy".
