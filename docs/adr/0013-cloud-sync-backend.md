# ADR-013: Đồng bộ đám mây (hướng B) — backend, tài khoản, mã hoá đầu-cuối

- Trạng thái: Đề xuất (chưa làm)
- Ngày: 2026-09-30
- Liên quan: ADR-004 (secret), ADR-006 (vault)

Tài liệu này mô tả thiết kế đầy đủ cho đồng bộ dữ liệu Shellhouse giữa nhiều máy qua backend riêng,
có tài khoản, có chia sẻ theo nhóm (team). Mọi dữ liệu người dùng được **mã hoá đầu-cuối**: server
chỉ lưu và chuyển ciphertext, không bao giờ thấy mật khẩu tài khoản, mật khẩu/khoá SSH, tên host hay
nội dung snippet.

---

## 1. Mục tiêu và phạm vi

### Mục tiêu

1. Dùng cùng một bộ host / key / snippet / tài khoản S3 trên nhiều máy (Windows, macOS, Linux).
2. **Local-first**: app vẫn chạy đầy đủ khi không có mạng; đồng bộ khi có mạng, trong vài giây.
3. **Zero-knowledge**: lộ toàn bộ database server cũng không lộ dữ liệu người dùng.
4. Chia sẻ vault cho team, phân quyền, thu hồi quyền an toàn (xoay khoá).
5. Không làm yếu mô hình bảo mật hiện tại (vault cục bộ, renderer không thấy secret).

### Không nằm trong phạm vi (ít nhất bản đầu)

- Đồng bộ log phiên, lịch sử terminal, file SFTP/S3.
- Web app đọc vault trên trình duyệt.
- Đăng nhập bằng Google/GitHub (SSO) — xem mục 15.

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
tab/cửa sổ, `last_used_at`.

---

## 2. Mô hình đe doạ

| Kẻ tấn công                             | Phải chống được                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Đọc được toàn bộ DB / backup của server | Không giải mã được gì; không dò mật khẩu offline hiệu quả (OPAQUE + Argon2id)                    |
| Nghe lén mạng                           | TLS 1.3; payload đã mã hoá sẵn                                                                   |
| Server độc hại / bị chiếm (chủ động)    | Không đọc được dữ liệu cũ; tráo khoá công khai khi chia sẻ → phát hiện qua fingerprint (mục 5.7) |
| Đánh cắp access / refresh token         | Token gắn thiết bị (ký bằng khoá thiết bị) → token lấy trộm không dùng được                      |
| Máy người dùng bị mất                   | Thu hồi thiết bị từ máy khác; vault cục bộ vẫn khoá bằng mật khẩu                                |
| Thành viên team bị xoá                  | Xoay khoá vault; dữ liệu mới không đọc được                                                      |
| Dò mật khẩu online, liệt kê email       | Giới hạn tốc độ, khoá tạm, phản hồi giống nhau cho email không tồn tại                           |

Chấp nhận: server độc hại có thể **từ chối phục vụ**, xoá dữ liệu, hoặc biết metadata (số bản ghi,
kích thước đã độn, thời điểm sửa, IP). Máy người dùng đã bị cài mã độc thì không bảo vệ được.

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
│ Load balancer / CDN (chống DDoS)                                          │
│ API (stateless, N instance)                                               │
│  ├─ Auth: OPAQUE, phiên, 2FA, thiết bị, khôi phục                         │
│  ├─ Sync: vault, bản ghi, revision, lịch sử                               │
│  ├─ Org: team, thành viên, lời mời, audit                                 │
│  └─ Stream: WebSocket thông báo "vault X có revision mới"                 │
│ PostgreSQL (dữ liệu chính)   Redis (rate limit, pub/sub, phiên đăng nhập)  │
│ Email (Postmark/SES)         Object storage (backup DB mã hoá)             │
└───────────────────────────────────────────────────────────────────────────┘
```

- Đồng bộ chạy trong **main process** (đã có DB và khoá vault). Renderer chỉ nhận trạng thái qua IPC,
  không bao giờ thấy khoá tài khoản hay khoá vault.
- Server **không có trạng thái theo phiên WebSocket** ngoài danh sách kết nối; mọi dữ liệu đi qua REST.
  WebSocket chỉ báo "có thay đổi", client tự kéo về → mất kết nối WebSocket không mất dữ liệu.

---

## 4. Tài khoản và phân cấp khoá

### 4.1. Phân cấp khoá

```
Mật khẩu tài khoản
  └─ OPAQUE (RFC 9807, KSF = Argon2id ops=3 mem=64MiB)
       ├─ xác thực với server (server không nhận mật khẩu, không có hash dò offline)
       └─ export_key (32 B, chỉ client có)
            └─ EK  = KDF(export_key, "sh-enc", 1)          ← khoá bọc tài khoản
                 └─ AK  = 32 B ngẫu nhiên                  ← Account Key (không đổi khi đổi mật khẩu)
                      ├─ khoá riêng X25519 (mã hoá) + Ed25519 (ký) của tài khoản
                      └─ VK_personal = 32 B ngẫu nhiên     ← Vault Key của vault cá nhân
                           └─ mỗi bản ghi: XChaCha20-Poly1305(VK, payload, AD)

Recovery key RK (32 B ngẫu nhiên, hiển thị 1 lần) ─ bọc AK lần thứ hai
Khoá thiết bị (Ed25519 + X25519, sinh trên từng máy, cất trong keychain hệ điều hành)
Vault chia sẻ: VK_shared bọc bằng crypto_box_seal(X25519 public key của từng thành viên)
```

- `KDF` = `crypto_kdf_derive_from_key` (BLAKE2b) của libsodium. Mã hoá đối xứng dùng đúng hàm `seal/open`
  của vault hiện tại (XChaCha20-Poly1305, `nonce(24) || ciphertext || tag(16)`, có AD).
- **Vì sao có AK riêng**: đổi mật khẩu chỉ cần bọc lại AK (vài chục byte), không phải mã hoá lại dữ
  liệu; khôi phục bằng recovery key cũng chỉ mở AK.
- **Vì sao VK tách khỏi AK**: vault chia sẻ cần khoá riêng để trao cho người khác mà không lộ AK.

### 4.2. Đăng ký

1. Người dùng nhập email + mật khẩu (≥ 12 ký tự; kiểm tra mức độ bằng zxcvbn; tuỳ chọn so với danh
   sách mật khẩu lộ qua k-anonymity HIBP).
2. Client chạy OPAQUE registration với server → server lưu `opaque_record` (không phải hash mật khẩu).
3. Client sinh AK, cặp khoá tài khoản, VK cá nhân, RK, khoá thiết bị.
4. Client gửi lên: các khoá **đã bọc** + khoá công khai + `recovery_verifier` (mục 4.6).
5. App hiển thị **Recovery kit**: RK dạng 12 nhóm × 4 ký tự base32 + QR, bắt người dùng xác nhận đã lưu
   (gõ lại 2 nhóm ngẫu nhiên). Có nút lưu PDF.
6. Server gửi email xác minh. Chưa xác minh vẫn dùng được 7 ngày, sau đó chỉ đọc.

### 4.3. Đăng nhập

1. `login/start` (OPAQUE KE1) → server trả KE2 (email không tồn tại vẫn trả KE2 giả, không phân biệt được).
2. Client hoàn tất KE3 → có `export_key` → suy ra EK → mở AK → mở khoá riêng và các VK.
3. Server kiểm tra KE3; nếu bật 2FA → yêu cầu TOTP/WebAuthn.
4. Máy **mới**: server đặt thiết bị ở trạng thái `pending`, gửi email "thiết bị mới đăng nhập" + thông báo
   tới các máy đang hoạt động. Duyệt từ máy cũ (hoặc link trong email) → `active`. Có thể tắt yêu cầu
   duyệt cho tài khoản cá nhân, bắt buộc với org.
5. Server cấp access token (15 phút) + refresh token (30 ngày, xoay vòng), **gắn với khoá thiết bị**.

### 4.4. Phiên và ràng buộc thiết bị

- Access token: chuỗi ngẫu nhiên 256-bit (không dùng JWT để thu hồi được ngay), server lưu SHA-256 của
  token trong Redis kèm `user_id, device_id, expires`.
- Mỗi request có thêm chữ ký của thiết bị:
  ```
  X-Device-Id: <uuid>
  X-Timestamp: <unix ms>          (lệch ≤ 5 phút)
  X-Nonce: <16 B base64url>       (server nhớ 10 phút → chống phát lại)
  X-Signature: base64url(Ed25519(device_sk,
      METHOD \n PATH?QUERY \n X-Timestamp \n X-Nonce \n SHA-256(body)))
  ```
  Token bị lộ mà không có khoá thiết bị (nằm trong keychain) thì vô dụng.
- Refresh token dùng một lần; dùng lại token cũ → thu hồi cả chuỗi (dấu hiệu bị đánh cắp).
- Khoá riêng của thiết bị cất bằng `safeStorage` của Electron (Keychain / DPAPI / libsecret).

### 4.5. Đổi mật khẩu

Yêu cầu nhập lại mật khẩu cũ (+2FA). Client chạy OPAQUE registration mới, bọc lại AK bằng EK mới, gửi
`opaque_record` + `wrapped_ak` mới trong một giao dịch. Thu hồi mọi phiên trừ phiên hiện tại.

### 4.6. Quên mật khẩu → khôi phục bằng Recovery key

- Lúc đăng ký: `RK_enc = KDF(RK, "sh-rk-enc", 1)`, `RK_auth = KDF(RK, "sh-rk-auth", 2)`.
  Server lưu `wrapped_ak_recovery = seal(RK_enc, AK)` và `recovery_verifier = Ed25519 public key sinh từ
seed RK_auth`.
- Khôi phục: server gửi challenge ngẫu nhiên → client ký bằng khoá sinh từ RK_auth → server kiểm chữ ký
  → client mở AK, đặt mật khẩu mới (như 4.5), sinh RK mới.
- **Mất cả mật khẩu và recovery key = mất dữ liệu.** Đây là cái giá của zero-knowledge; nói rõ khi đăng ký.
- Tuỳ chọn cho org: admin có "khoá khôi phục của tổ chức" (AK của thành viên được bọc thêm bằng khoá công
  khai của org) — chỉ bật khi thành viên đồng ý, có ghi audit.

### 4.7. 2FA

- TOTP (RFC 6238), secret lưu phía server đã mã hoá bằng khoá KMS của server (đây là yếu tố xác thực,
  không phải dữ liệu người dùng). 10 mã dự phòng dùng một lần (lưu hash Argon2id).
- WebAuthn / passkey (giai đoạn 3).
- 2FA chỉ bảo vệ việc **lấy ciphertext**; giải mã vẫn cần mật khẩu.

### 4.8. Xoá tài khoản, xuất dữ liệu

- Xoá: nhập lại mật khẩu + 2FA → đánh dấu xoá, 7 ngày có thể huỷ, sau đó xoá cứng mọi bản ghi, khoá,
  thiết bị; backup cũ hết hạn theo vòng đời backup (30 ngày). Email xác nhận.
- Xuất: client tải mọi bản ghi, giải mã, ghi file backup mã hoá của Shellhouse (định dạng đã có).

---

## 5. Mã hoá dữ liệu

### 5.1. Nguyên thuỷ mật mã (đều có trong libsodium, đang dùng sẵn)

| Việc                        | Thuật toán                                                                      |
| --------------------------- | ------------------------------------------------------------------------------- |
| Mã hoá đối xứng có xác thực | XChaCha20-Poly1305 (IETF), nonce ngẫu nhiên 24 B                                |
| Dẫn xuất khoá con           | BLAKE2b (`crypto_kdf_derive_from_key`)                                          |
| Mã hoá cho người nhận       | X25519 sealed box (`crypto_box_seal`)                                           |
| Chữ ký                      | Ed25519                                                                         |
| Băm mật khẩu (trong OPAQUE) | Argon2id ops=3 mem=64 MiB (giống vault cục bộ)                                  |
| Đăng nhập không lộ mật khẩu | OPAQUE-3DH, ristretto255 (thư viện `@serenity-kit/opaque`, có cả Node lẫn WASM) |

### 5.2. Định dạng bản ghi

Payload (trước khi mã hoá) là JSON:

```json
{
  "v": 1,
  "type": "host",
  "fields": {
    "label": { "v": "prod-web-1", "t": "0192f3c1a2b0:0003:7f3a" },
    "hostname": { "v": "10.0.1.15", "t": "0192f3c1a2b0:0003:7f3a" },
    "port": { "v": 22, "t": "0192f3c1a2b0:0000:7f3a" },
    "groupId": { "v": "0192f2…", "t": "0192f3c19e11:0000:1c2d" },
    "secret": { "v": "base64(password)", "t": "0192f3c1a2b0:0003:7f3a" }
  }
}
```

- Mỗi trường có dấu thời gian lai **HLC** `t = <ms hex>:<bộ đếm>:<4 byte đầu của device id>` để gộp
  xung đột theo từng trường (mục 6.4).
- Secret nằm **trong** payload (payload đã được mã hoá cả khối) — không có mã hoá hai lớp.
- Nén bằng deflate nếu > 1 KiB, rồi **độn** tới bội số của 256 B (ẩn độ dài thật: server không đoán được
  "đây là private key RSA 4096").

Mã hoá:

```
ciphertext = seal(VK[key_version], padded_payload,
                  AD = "sh|rec|v1|" + vault_id + "|" + record_id + "|" + key_version)
```

AD gắn ciphertext với đúng vault và đúng id → server không tráo được bản ghi giữa các id / vault.
Loại bản ghi (`type`) nằm **trong** payload → server không biết bạn có bao nhiêu host hay bao nhiêu key.

### 5.3. Bọc khoá

| Đối tượng                         | Cách bọc                                                                                         | AD  |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | --- |
| AK                                | `seal(EK, AK)`                                                                                   | `sh | ak    | v1  | <user_id>` |
| AK (khôi phục)                    | `seal(RK_enc, AK)`                                                                               | `sh | ak-rk | v1  | <user_id>` |
| Khoá riêng X25519/Ed25519         | `seal(AK, sk)`                                                                                   | `sh | sk    | v1  | <user_id>  | x25519`/`ed25519` |
| VK vault cá nhân                  | `seal(AK, VK)`                                                                                   | `sh | vk    | v1  | <vault_id> | <key_version>`    |
| VK vault chia sẻ (mỗi thành viên) | `crypto_box_seal(VK ‖ vault_id ‖ key_version, member_x25519_pk)` + chữ ký Ed25519 của người trao | —   |

### 5.4. Xoay khoá vault (khi xoá thành viên hoặc nghi lộ)

1. Người có quyền admin sinh `VK[n+1]`, bọc cho các thành viên còn lại.
2. Client tải mọi bản ghi, giải mã bằng `VK[n]`, mã hoá lại bằng `VK[n+1]`, đẩy lên theo lô trong một
   "rotation job" (server từ chối ghi với `key_version = n` từ lúc job bắt đầu).
3. Xong: server xoá `VK[n]` đã bọc của mọi người. Thành viên bị xoá vẫn giữ được bản sao cũ họ đã tải về
   — không thu hồi được quá khứ, chỉ chặn dữ liệu mới (giống mọi hệ E2EE).

### 5.5. Vault cục bộ và tài khoản

- Vault cục bộ giữ nguyên thiết kế ADR-006 (DEK cục bộ bọc bằng KEK từ mật khẩu).
- Khi đăng nhập tài khoản trên máy: **dùng một mật khẩu** — KEK cục bộ được bọc lại bằng khoá dẫn xuất
  từ mật khẩu tài khoản (`KDF(export_key, "sh-local", 3)`), để người dùng không phải nhớ hai mật khẩu.
  Mở app offline vẫn được (không cần server): vault_meta cục bộ lưu bản bọc KEK bằng Argon2id của mật
  khẩu như cũ.
- Đổi mật khẩu tài khoản trên máy A → máy B nhận sự kiện, lần mở khoá tiếp theo yêu cầu mật khẩu mới rồi
  bọc lại KEK cục bộ.

### 5.6. Metadata server biết được

`user_id`, email, số vault, số bản ghi, kích thước đã độn, revision, thời điểm sửa, thiết bị nào sửa,
IP (lưu dạng băm, 30 ngày), tên và nền tảng thiết bị (người dùng đặt — có thể mã hoá bằng AK nếu muốn).

### 5.7. Chống tráo khoá công khai khi chia sẻ

Server trả khoá công khai của người nhận khi chia sẻ → server độc hại có thể trả khoá của chính nó.
Biện pháp:

- Hiển thị **mã an toàn** (safety number: 60 chữ số từ SHA-256 của hai khoá công khai) để hai người so
  qua kênh khác, như Signal. Đã so thì app nhớ và cảnh báo nếu khoá đổi.
- Org: admin ký khoá công khai của thành viên bằng khoá Ed25519 của org khi duyệt vào nhóm; các thành
  viên khác chỉ tin khoá có chữ ký hợp lệ.

---

## 6. Giao thức đồng bộ

### 6.1. Mô hình

- Mỗi vault có một **dãy revision** tăng dần trên server (`vault_revisions.last_revision`). Mỗi lần ghi
  một bản ghi, server gán `revision = last_revision + 1` trong cùng giao dịch.
- Client nhớ `cursor = revision lớn nhất đã kéo về` cho từng vault.
- Server **không bao giờ gộp** dữ liệu (không đọc được); chỉ kiểm tra tương tranh lạc quan bằng
  `base_revision`. Gộp xung đột làm ở client.

### 6.2. Phía client — bảng mới (migration 0008)

```sql
CREATE TABLE sync_state (
  vault_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,          -- revision cuối đã kéo
  key_version INTEGER NOT NULL,
  last_pull_at INTEGER, last_push_at INTEGER,
  status TEXT NOT NULL DEFAULT 'idle'          -- idle | syncing | error | paused
);
CREATE TABLE sync_records (                    -- ánh xạ bản ghi cục bộ ↔ server
  record_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  server_revision INTEGER,                     -- null = chưa từng đẩy
  field_hlc TEXT NOT NULL DEFAULT '{}'          -- HLC của từng trường đã biết
);
CREATE TABLE sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  changed_fields TEXT NOT NULL,                -- JSON: ["label","port"] ; ["*"] = xoá
  hlc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Mọi service ghi dữ liệu (HostService, SnippetService, S3Accounts…) gọi `outbox.record(type, id, fields)`
trong **cùng transaction** với thay đổi → không bao giờ mất thay đổi chưa đẩy.

### 6.3. Chu trình

```
Khi: mở app, đăng nhập, có thay đổi cục bộ (debounce 1 s), nhận thông báo WebSocket, mỗi 5 phút.

1. PULL  với mỗi vault: GET /changes?since=cursor (lặp tới khi more=false)
         giải mã → gộp vào DB cục bộ (6.4) → cursor = next
2. PUSH  gom outbox theo record (≤ 200 bản ghi / lô):
         dựng payload đầy đủ từ DB cục bộ + HLC từng trường → mã hoá → POST records:batch
         kết quả ok      → cập nhật server_revision, xoá dòng outbox
                 conflict → nhận bản hiện tại trên server → gộp (6.4) → đẩy lại (tối đa 3 lần)
3. Lỗi mạng → thử lại với backoff lũy thừa + jitter (1 s → 5 phút). Lỗi 4xx khác → dừng vault đó,
   hiện lỗi trong UI.
```

### 6.4. Gộp xung đột (theo từng trường, "sửa sau thắng")

- Với mỗi trường: giữ giá trị có HLC lớn hơn. HLC bảo đảm thứ tự nhất quán kể cả khi đồng hồ các máy
  lệch nhau (cập nhật HLC theo `max(local, remote) + 1` mỗi khi nhận dữ liệu).
- Xoá thắng sửa nếu HLC của xoá lớn hơn mọi trường; sửa sau xoá → bản ghi "sống lại" (có thông báo).
- Tham chiếu gãy (host trỏ tới group đã bị xoá ở máy khác) → đưa host về "Ungrouped", không lỗi.
- Hai máy cùng sửa một trường offline → giữ bản mới hơn, bản thua lưu vào **lịch sử phiên bản** (server
  giữ 30 ngày) → người dùng khôi phục được từ menu "Version history".

### 6.5. Xoá và dọn dẹp

- Xoá = bản ghi `deleted=true` (tombstone), payload chỉ còn HLC xoá.
- Server xoá cứng tombstone sau 90 ngày. Client có `cursor` cũ hơn mốc dọn dẹp → server trả
  `410 cursor_expired` → client đồng bộ lại toàn bộ (tải tất cả, so theo id, không mất thay đổi cục bộ
  vì còn nằm trong outbox).

### 6.6. Lần đầu bật đồng bộ trên máy đã có dữ liệu

- Tài khoản mới: đẩy toàn bộ dữ liệu cục bộ lên vault cá nhân.
- Tài khoản đã có dữ liệu, máy cũng có dữ liệu: hỏi người dùng — **Gộp** (mặc định; trùng hostname +
  port + user thì coi là một, giữ bản sửa sau), **Chỉ dùng dữ liệu trên đám mây** (dữ liệu máy này được
  sao lưu vào file trước), hoặc **Huỷ**.

### 6.7. Giới hạn

| Mục                                | Giới hạn |
| ---------------------------------- | -------- |
| Kích thước một bản ghi (đã mã hoá) | 64 KiB   |
| Số bản ghi / lô push               | 200      |
| Số bản ghi / trang pull            | 500      |
| Số bản ghi / vault                 | 50 000   |
| Thiết bị / tài khoản               | 20       |
| Lịch sử phiên bản                  | 30 ngày  |

---

## 7. Mô hình kết nối

### 7.1. Giao vận

- `https://api.shellhouse.app/v1/...` — TLS 1.3 (tối thiểu 1.2), HTTP/2, HSTS. Có thể pin khoá công khai
  CA trung gian trong app (tuỳ chọn, có cơ chế cập nhật qua bản app mới).
- Client dùng `net` của Electron (tôn trọng proxy hệ thống, chứng chỉ doanh nghiệp).
- JSON UTF-8; bytes mã hoá bằng base64url không padding. Nén gzip cho body > 1 KiB.
- Mọi request có `X-Client: shellhouse/<version> (<os>)`. Server có thể trả `426 Upgrade Required` kèm
  phiên bản tối thiểu (khi đổi định dạng không tương thích).
- Request ghi có `Idempotency-Key` (UUID) → gửi lại do mất mạng không tạo bản ghi trùng.

### 7.2. WebSocket thông báo

```
wss://api.shellhouse.app/v1/stream
→ client gửi: { "type": "hello", "token": "<access>", "device": "<id>", "ts": …, "nonce": …, "sig": … }
← server:     { "type": "ready" }
← server:     { "type": "vault.changed", "vault_id": "…", "revision": 1043 }
← server:     { "type": "device.pending", "device_id": "…", "name": "MacBook Pro" }
← server:     { "type": "account.changed", "what": "password" | "keys" | "membership" }
↔ ping/pong 30 s; mất kết nối → nối lại với backoff 1 s → 60 s + jitter
```

Server nhiều instance: thông báo phát qua Redis pub/sub kênh `vault:<id>` và `user:<id>`.

### 7.3. Mã lỗi

```json
{ "error": { "code": "conflict", "message": "Record changed on the server", "details": { … } } }
```

| HTTP | code                                                                |
| ---- | ------------------------------------------------------------------- |
| 400  | `invalid_request`                                                   |
| 401  | `unauthenticated`, `token_expired`, `bad_signature`                 |
| 403  | `forbidden`, `device_pending`, `device_revoked`, `email_unverified` |
| 404  | `not_found`                                                         |
| 409  | `conflict` (ghi), `rotation_in_progress`                            |
| 410  | `cursor_expired`                                                    |
| 413  | `record_too_large`                                                  |
| 422  | `limit_exceeded`                                                    |
| 426  | `client_outdated`                                                   |
| 429  | `rate_limited` (+ `Retry-After`)                                    |

### 7.4. Giới hạn tốc độ (Redis, cửa sổ trượt)

| Nhóm                            | Giới hạn                                        |
| ------------------------------- | ----------------------------------------------- |
| `login/*` theo IP               | 20 / 10 phút                                    |
| `login/*` theo email            | 10 / 10 phút; 20 lần sai → khoá 15 phút + email |
| `register`, `recover` theo IP   | 5 / giờ                                         |
| API đã đăng nhập theo tài khoản | 600 / phút                                      |
| WebSocket / thiết bị            | 1 kết nối                                       |

---

## 8. API (v1)

Quy ước: `🔒` = cần access token + chữ ký thiết bị. Bytes = base64url.

### 8.1. Xác thực

| Method  | Path                       | Mô tả                                                                                                 |
| ------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST    | `/v1/auth/register/start`  | `{email, opaque_request}` → `{opaque_response}`                                                       |
| POST    | `/v1/auth/register/finish` | Tạo tài khoản (body bên dưới) → `{user_id}`; gửi email xác minh                                       |
| POST    | `/v1/auth/email/verify`    | `{token}`                                                                                             |
| POST    | `/v1/auth/email/resend`    | `{email}` (luôn trả 204)                                                                              |
| POST    | `/v1/auth/login/start`     | `{email, opaque_ke1}` → `{login_id, opaque_ke2}`                                                      |
| POST    | `/v1/auth/login/finish`    | `{login_id, opaque_ke3, device}` → phiên hoặc `{next: "2fa" \| "device_approval"}`                    |
| POST    | `/v1/auth/2fa/verify`      | `{login_id, method: "totp"\|"webauthn"\|"backup_code", code \| assertion}`                            |
| POST    | `/v1/auth/refresh`         | `{refresh_token}` → token mới (xoay vòng)                                                             |
| POST 🔒 | `/v1/auth/logout`          | Thu hồi phiên hiện tại                                                                                |
| POST 🔒 | `/v1/auth/password/start`  | Xác thực lại (OPAQUE) → `{reauth_token}`                                                              |
| POST 🔒 | `/v1/auth/password/finish` | `{reauth_token, opaque_record, wrapped_ak}`                                                           |
| POST    | `/v1/auth/recover/start`   | `{email}` → `{recovery_id, challenge}`                                                                |
| POST    | `/v1/auth/recover/finish`  | `{recovery_id, signature, opaque_record, wrapped_ak, wrapped_ak_recovery, recovery_verifier, device}` |

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
    "name": "Hieu's laptop",
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

| Method    | Path                                           | Mô tả                                                   |
| --------- | ---------------------------------------------- | ------------------------------------------------------- |
| GET 🔒    | `/v1/account`                                  | Email, gói, trạng thái 2FA, ngày tạo                    |
| GET 🔒    | `/v1/account/keys`                             | Các khoá đã bọc + khoá công khai                        |
| DELETE 🔒 | `/v1/account`                                  | `{reauth_token}` → đánh dấu xoá (7 ngày)                |
| POST 🔒   | `/v1/account/2fa/totp/setup`                   | → `{otpauth_uri, secret}`                               |
| POST 🔒   | `/v1/account/2fa/totp/enable`                  | `{code}` → `{backup_codes[]}`                           |
| DELETE 🔒 | `/v1/account/2fa/totp`                         | `{reauth_token}`                                        |
| POST 🔒   | `/v1/account/2fa/webauthn/options` · `/verify` | Đăng ký passkey                                         |
| GET 🔒    | `/v1/devices`                                  | Danh sách thiết bị (tên, nền tảng, lần cuối, hiện tại?) |
| PATCH 🔒  | `/v1/devices/{id}`                             | Đổi tên                                                 |
| POST 🔒   | `/v1/devices/{id}/approve`                     | Duyệt thiết bị đang chờ                                 |
| DELETE 🔒 | `/v1/devices/{id}`                             | Thu hồi (xoá phiên, token, khoá công khai)              |

### 8.3. Đồng bộ

| Method  | Path                                    | Mô tả                                                                                                     |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET 🔒  | `/v1/sync/bootstrap`                    | Mọi vault người dùng truy cập được: `{vaults:[{id, kind, role, key_version, wrapped_vk, last_revision}]}` |
| GET 🔒  | `/v1/vaults/{id}/changes?since=&limit=` | Bản ghi đổi sau `since`                                                                                   |
| POST 🔒 | `/v1/vaults/{id}/records:batch`         | Ghi nhiều bản ghi                                                                                         |
| GET 🔒  | `/v1/vaults/{id}/records/{rid}/history` | Các phiên bản cũ (30 ngày)                                                                                |
| POST 🔒 | `/v1/vaults/{id}/records/{rid}/restore` | `{revision}` → khôi phục phiên bản cũ                                                                     |

`GET /changes`:

```json
{
  "records": [
    {
      "id": "0192…",
      "revision": 1041,
      "deleted": false,
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
    { "id": "0192…", "base_revision": 1041, "deleted": false, "key_version": 1, "ciphertext": "…" },
    { "id": "0193…", "base_revision": null, "deleted": false, "key_version": 1, "ciphertext": "…" }
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
      "current": { "revision": 1042, "ciphertext": "…", "deleted": false, "key_version": 1 }
    }
  ]
}
```

`base_revision: null` = tạo mới (trùng id đã có → conflict). Mỗi op xử lý riêng; một op lỗi không làm
hỏng cả lô.

### 8.4. Tổ chức (team) và vault chia sẻ

| Method    | Path                                | Mô tả                                                                             |
| --------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| POST 🔒   | `/v1/orgs`                          | `{name, org_x25519_pk, org_ed25519_pk, wrapped_org_keys}`                         |
| GET 🔒    | `/v1/orgs/{id}`                     | Thông tin, thành viên, vai trò                                                    |
| POST 🔒   | `/v1/orgs/{id}/invites`             | `{email, role}` → gửi email mời                                                   |
| POST 🔒   | `/v1/invites/{token}/accept`        | Chấp nhận; admin duyệt và ký khoá công khai (5.7)                                 |
| PATCH 🔒  | `/v1/orgs/{id}/members/{user_id}`   | Đổi vai trò                                                                       |
| DELETE 🔒 | `/v1/orgs/{id}/members/{user_id}`   | Xoá thành viên (kéo theo xoay khoá các vault họ có quyền)                         |
| GET 🔒    | `/v1/users/lookup?email=`           | Khoá công khai + chữ ký của org (nếu có)                                          |
| POST 🔒   | `/v1/vaults`                        | Tạo vault chia sẻ `{id, org_id, name_enc, members:[{user_id, role, wrapped_vk}]}` |
| PUT 🔒    | `/v1/vaults/{id}/members/{user_id}` | `{role, wrapped_vk, key_version}`                                                 |
| DELETE 🔒 | `/v1/vaults/{id}/members/{user_id}` | Thu quyền                                                                         |
| POST 🔒   | `/v1/vaults/{id}/rotation`          | Bắt đầu xoay khoá `{new_key_version, members:[{user_id, wrapped_vk}]}`            |
| POST 🔒   | `/v1/vaults/{id}/rotation/complete` | Kết thúc (server kiểm tra mọi bản ghi đã ở key_version mới)                       |
| GET 🔒    | `/v1/orgs/{id}/audit?cursor=`       | Nhật ký (chỉ metadata)                                                            |

Vai trò vault: `owner` (quản lý thành viên, xoay khoá), `editor` (đọc/ghi), `viewer` (chỉ đọc — server
từ chối ghi; client ẩn nút sửa). Lưu ý: viewer vẫn giải mã được secret trong vault (dùng để kết nối).

### 8.5. Khác

| Method | Path         | Mô tả                                                        |
| ------ | ------------ | ------------------------------------------------------------ |
| GET    | `/v1/meta`   | Phiên bản client tối thiểu, tính năng bật, thông báo bảo trì |
| GET    | `/v1/health` | Kiểm tra sống (không lộ thông tin)                           |
| WS 🔒  | `/v1/stream` | Mục 7.2                                                      |

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
  delete_after TIMESTAMPTZ                    -- đang chờ xoá
);

CREATE TABLE user_keys (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped_ak BYTEA NOT NULL,
  wrapped_ak_recovery BYTEA NOT NULL,
  recovery_verifier BYTEA NOT NULL,           -- Ed25519 public key
  x25519_pk BYTEA NOT NULL, ed25519_pk BYTEA NOT NULL,
  wrapped_x25519_sk BYTEA NOT NULL, wrapped_ed25519_sk BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT,
  ed25519_pk BYTEA NOT NULL, x25519_pk BYTEA NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_hash BYTEA NOT NULL UNIQUE,         -- SHA-256
  family UUID NOT NULL,                       -- chuỗi xoay vòng (dùng lại → thu hồi cả family)
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE totp (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc BYTEA NOT NULL,                  -- mã hoá bằng khoá KMS của server
  backup_code_hashes TEXT[] NOT NULL,
  enabled_at TIMESTAMPTZ
);

CREATE TABLE orgs (
  id UUID PRIMARY KEY, name TEXT NOT NULL,
  x25519_pk BYTEA NOT NULL, ed25519_pk BYTEA NOT NULL,
  plan TEXT NOT NULL DEFAULT 'team', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE org_members (
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  key_signature BYTEA,                        -- chữ ký của org lên khoá công khai thành viên
  wrapped_org_sk BYTEA,                       -- chỉ admin: khoá riêng của org bọc cho họ
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE invites (
  token_hash BYTEA PRIMARY KEY, org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email CITEXT NOT NULL, role TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, accepted_by UUID
);

CREATE TABLE vaults (
  id UUID PRIMARY KEY,
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- vault cá nhân
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,          -- vault chia sẻ
  name_enc BYTEA,                                             -- tên đã mã hoá bằng VK
  key_version INT NOT NULL DEFAULT 1,
  rotating_to INT,                                            -- đang xoay khoá
  last_revision BIGINT NOT NULL DEFAULT 0,
  CHECK ((owner_user_id IS NULL) <> (org_id IS NULL))
);
CREATE TABLE vault_members (
  vault_id UUID REFERENCES vaults(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  key_version INT NOT NULL,
  wrapped_vk BYTEA NOT NULL,
  PRIMARY KEY (vault_id, user_id, key_version)
);

CREATE TABLE records (
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  id UUID NOT NULL,
  revision BIGINT NOT NULL,
  key_version INT NOT NULL,
  deleted BOOLEAN NOT NULL DEFAULT false,
  ciphertext BYTEA NOT NULL,
  size INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES devices(id) ON DELETE SET NULL,
  PRIMARY KEY (vault_id, id)
);
CREATE INDEX records_changes ON records (vault_id, revision);

CREATE TABLE record_history (                 -- giữ 30 ngày
  vault_id UUID NOT NULL, id UUID NOT NULL, revision BIGINT NOT NULL,
  key_version INT NOT NULL, deleted BOOLEAN NOT NULL, ciphertext BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, updated_by UUID,
  PRIMARY KEY (vault_id, id, revision)
);

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID, user_id UUID, device_id UUID,
  action TEXT NOT NULL,                       -- login, device.approve, vault.member.add, …
  target TEXT, ip_hash BYTEA, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Ghi bản ghi (một op, trong transaction):

```sql
UPDATE vaults SET last_revision = last_revision + 1 WHERE id = $vault RETURNING last_revision; -- khoá dòng vault
-- base_revision khớp? (SELECT revision FROM records WHERE vault_id=$vault AND id=$id FOR UPDATE)
INSERT INTO record_history SELECT … FROM records WHERE vault_id=$vault AND id=$id;         -- bản cũ
INSERT INTO records (…) VALUES (…) ON CONFLICT (vault_id, id) DO UPDATE SET …;
```

Khoá dòng `vaults` tuần tự hoá ghi trong một vault (đơn giản, đủ nhanh ở quy mô vài nghìn bản ghi/vault).

---

## 10. Hạ tầng và vận hành

| Thành phần      | Lựa chọn đề xuất                                                             | Ghi chú                              |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Ngôn ngữ API    | TypeScript (Node 22, Fastify) — dùng chung zod schema và code mã hoá với app | Hoặc Go nếu cần hiệu năng            |
| DB              | PostgreSQL 16 (Neon / RDS / Cloud SQL), PITR 7 ngày                          |                                      |
| Cache / pub-sub | Redis (Upstash / ElastiCache)                                                | Rate limit, token, WebSocket fan-out |
| Chạy            | Fly.io hoặc Railway (≥ 2 instance, 2 region)                                 | Sau này Kubernetes nếu lớn           |
| Email           | Postmark (giao dịch)                                                         | SPF/DKIM/DMARC                       |
| Bí mật server   | KMS (AWS KMS / GCP KMS) cho khoá mã hoá TOTP, khoá OPAQUE server             | Xoay khoá định kỳ                    |
| Giám sát        | OpenTelemetry → Grafana Cloud; Sentry (lọc PII)                              | Không log body, không log token      |
| Backup          | pg_dump mã hoá hằng ngày → R2 khác region, giữ 30 ngày                       | Diễn tập khôi phục mỗi quý           |
| CDN / WAF       | Cloudflare                                                                   | Chống DDoS, chặn bot trên /auth      |

Chi phí ước lượng: dưới 1.000 người dùng ~ **20–60 USD/tháng**; 10.000 người dùng ~ 150–300 USD/tháng
(dữ liệu mỗi người rất nhỏ: vài trăm KB).

Pháp lý: chính sách quyền riêng tư, điều khoản dịch vụ, quy trình xoá/xuất dữ liệu (GDPR), nơi đặt
dữ liệu (EU/US) cho khách doanh nghiệp.

---

## 11. Thay đổi phía app

| Module (mới / sửa)                      | Việc                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `src/main/account/crypto.ts`            | Phân cấp khoá (4.1), bọc/mở AK, VK, sealed box, chữ ký; vector test         |
| `src/main/account/opaque.ts`            | OPAQUE client (`@serenity-kit/opaque`)                                      |
| `src/main/account/api-client.ts`        | REST + ký request + refresh token + retry/backoff + Idempotency-Key         |
| `src/main/account/stream.ts`            | WebSocket, nối lại, phát sự kiện                                            |
| `src/main/account/device-keys.ts`       | Sinh / cất khoá thiết bị bằng `safeStorage`                                 |
| `src/main/sync/outbox.ts`               | Ghi thay đổi trong transaction của các service                              |
| `src/main/sync/records.ts`              | Ánh xạ bảng cục bộ ↔ payload (từng loại bản ghi, có version)                |
| `src/main/sync/hlc.ts`                  | Hybrid logical clock                                                        |
| `src/main/sync/engine.ts`               | Pull / push / merge / lịch chạy / trạng thái                                |
| `migrations/0008_sync.sql`              | `sync_state`, `sync_records`, `sync_outbox`                                 |
| `src/shared/ipc.ts`                     | `account:*`, `sync:status`, `sync:now`, `devices:*`                         |
| Renderer: Settings → **Account & Sync** | Đăng ký / đăng nhập / 2FA / recovery kit / thiết bị / trạng thái / tạm dừng |
| Renderer: thanh công cụ                 | Biểu tượng trạng thái đồng bộ (đã đồng bộ / đang đồng bộ / lỗi / offline)   |
| Renderer: host, snippet…                | "Version history", vault nào (cá nhân / team), quyền viewer                 |
| Renderer: Share                         | Tạo vault team, mời, đổi vai trò, mã an toàn                                |

---

## 12. Kế hoạch thực hiện (từng bước)

### Giai đoạn 0 — Chuẩn bị (1 tuần)

1. Chốt ADR này; chọn nhà cung cấp hạ tầng; mua tên miền `api.` + email gửi đi.
2. Tạo repo `shellhouse-server` (monorepo hoặc tách), CI (lint, test, build image), môi trường
   `dev` / `staging` / `prod`.
3. Tách phần mã hoá dùng chung (`packages/crypto`: seal/open, KDF, định dạng bản ghi) để app và server
   dùng cùng một code + cùng bộ test vector.
4. Viết chính sách quyền riêng tư, điều khoản.

### Giai đoạn 1 — Backend lõi (3–4 tuần)

1. Khung Fastify + zod + migration Postgres (mục 9) + Redis.
2. OPAQUE register/login (start/finish), chống liệt kê email.
3. Phiên: access/refresh xoay vòng, thu hồi theo family, ký request theo thiết bị, chống phát lại.
4. Xác minh email, gửi lại, email "thiết bị mới".
5. Thiết bị: đăng ký, pending/active/revoked, duyệt.
6. Đồng bộ: `bootstrap`, `changes`, `records:batch` (revision, conflict, history, idempotency).
7. WebSocket + Redis pub/sub.
8. Rate limit, mã lỗi chuẩn, log không PII, OpenTelemetry.
9. Test: unit, tích hợp với Postgres thật (testcontainers), test bảo mật (IDOR, phát lại, token cũ, chữ
   ký sai, vượt giới hạn).
10. Triển khai staging.

### Giai đoạn 2 — Engine đồng bộ trong app (3–4 tuần)

1. `account/crypto` + vector test đối chiếu với server.
2. Migration 0008, outbox trong mọi service ghi dữ liệu (test: mọi thay đổi đều vào outbox).
3. Ánh xạ từng loại bản ghi (group, host, identity, key, forward, snippet, s3_account, known_host,
   workspace, setting) + test khứ hồi (DB → payload → DB giống hệt).
4. HLC + gộp theo trường + test thuộc tính (property test: hai máy thay đổi ngẫu nhiên, đồng bộ theo mọi
   thứ tự → hội tụ về cùng kết quả).
5. Engine pull/push, backoff, `410 cursor_expired`, lần đầu bật đồng bộ (gộp / dùng đám mây).
6. UI: đăng ký + recovery kit, đăng nhập + 2FA, danh sách thiết bị, trạng thái đồng bộ.
7. E2E: hai instance app + server staging cục bộ → sửa ở A thấy ở B < 3 giây; offline A/B cùng sửa →
   đúng quy tắc gộp; thu hồi thiết bị B → B bị đăng xuất.

### Giai đoạn 3 — Hoàn thiện và beta (2–3 tuần)

1. Đổi mật khẩu, khôi phục bằng recovery key, xoá / xuất tài khoản.
2. TOTP + mã dự phòng; WebAuthn (có thể để sau).
3. Version history + khôi phục phiên bản trong UI.
4. Giám sát, cảnh báo, backup + diễn tập khôi phục.
5. Kiểm thử tải (10.000 tài khoản giả, 1.000 kết nối WebSocket).
6. **Rà soát bảo mật độc lập** (pentest + review mật mã) trước khi mở rộng.
7. Beta kín → beta mở; chương trình báo lỗi bảo mật (security.txt, email riêng).

### Giai đoạn 4 — Team (4–6 tuần)

1. Org, lời mời, vai trò; ký khoá công khai thành viên; mã an toàn.
2. Vault chia sẻ, chọn vault khi tạo host, di chuyển host giữa vault (mã hoá lại bằng VK đích).
3. Xoá thành viên + xoay khoá (rotation job, xử lý lỗi giữa chừng, tiếp tục được).
4. Audit log + trang quản trị trong app.
5. Thanh toán (Stripe/Paddle), giới hạn theo gói.

**Tổng**: ~ 9–12 tuần cho bản cá nhân dùng được thật (giai đoạn 0–3), thêm 4–6 tuần cho team.

---

## 13. Kiểm thử

- **Vector mật mã** cố định (khoá, nonce, AD, kết quả) chạy ở cả app và server.
- **Property test** gộp xung đột (fast-check): N máy, thao tác ngẫu nhiên, mạng chập chờn → hội tụ.
- **Chaos**: cắt mạng giữa lúc push, server trả 500 ngẫu nhiên, trả trùng response (idempotency).
- **Bảo mật**: dùng token của người A đọc vault người B (phải 403/404), chữ ký sai, nonce lặp, refresh
  token dùng lại, viewer cố ghi, thiết bị đã thu hồi.
- **Nâng cấp**: định dạng payload v1 → v2 (client cũ gặp trường lạ phải giữ nguyên, không xoá).

---

## 14. Rủi ro

| Rủi ro                                     | Giảm thiểu                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Người dùng mất cả mật khẩu và recovery key | Bắt xác nhận đã lưu recovery kit; nhắc định kỳ; khôi phục theo org (tuỳ chọn)   |
| Lỗi gộp làm mất dữ liệu                    | Outbox bền, history 30 ngày, property test, tự sao lưu cục bộ trước lần gộp đầu |
| Sai sót mật mã                             | Chỉ dùng libsodium + OPAQUE có sẵn, không tự chế; review độc lập                |
| Chi phí và trách nhiệm vận hành            | Bắt đầu bằng hướng A (không server); chỉ làm B khi có nhu cầu thật              |
| Server bị chiếm                            | Zero-knowledge; không lưu gì giải mã được; khoá server trong KMS; log truy cập  |

---

## 15. Câu hỏi còn mở

1. Có cần SSO (Google/GitHub/SAML) cho doanh nghiệp không? SSO không cho ra khoá giải mã → vẫn cần mật
   khẩu vault riêng hoặc cơ chế "trusted device" như Bitwarden/1Password.
2. Tự host backend cho doanh nghiệp (Docker image)? Thiết kế trên cho phép, cần thêm cấu hình URL server
   trong app.
3. Có đồng bộ lịch sử lệnh không (mặc định tắt vì có thể chứa thông tin nhạy cảm)?
4. Mô hình giá: miễn phí 1 máy / trả phí nhiều máy, hay miễn phí cá nhân / trả phí team?
