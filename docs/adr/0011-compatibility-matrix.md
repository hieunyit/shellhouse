# ADR-011: Ma trận tương thích với server SSH thật

- Trạng thái: Chấp nhận
- Ngày: 2026-09-29

## Bối cảnh

Trước đây mọi test SSH đều chạy với server giả (ssh2 `Server`). Như vậy chưa chứng minh được app
làm việc với OpenSSH đời cũ, Dropbear, thiết bị mạng, hay 2FA thật (mục 8.2 của kế hoạch).

## Quyết định

- `test/compat/`: dựng server thật bằng Docker (`docker-compose.yml`), chạy bằng
  `pnpm test:compat`. CI chạy hằng đêm và khi đổi code SSH (`.github/workflows/compat.yml`).
- Test đi qua **đúng đường code của Session Host**:
  - `openSshShell` cho xác thực, host key và jump host.
  - `SftpService` cùng bộ truyền song song cho SFTP.
  - `forwardOut` cho port forward.
- Key thử nghiệm được tạo mới mỗi lần bằng `ssh-keygen` (ed25519 + RSA 3072), không lưu vào repo.
- `KEEP_COMPAT=1` giữ container lại để gỡ lỗi.
- **Thuật toán legacy theo từng host** (`Allow legacy algorithms`, mặc định tắt):
  - Nối thêm vào _sau_ danh sách hiện đại: `ssh-rsa`/`ssh-dss`, DH group14/gex/group1-sha1, các
    cipher CBC mà OpenSSL đang chạy có, và `hmac-md5`.
  - Áp dụng cả khi host đó là jump host.
  - Thanh phiên hiện badge **Legacy**.
  - Chỉ áp dụng cho SSH tích hợp; chế độ system ssh dùng cấu hình OpenSSH của người dùng.

## Kết quả (29/29)

| Server                          | Mật khẩu | Key ed25519 | Key RSA | SFTP 1 MB (sha256) | Port forward |
| ------------------------------- | -------- | ----------- | ------- | ------------------ | ------------ |
| OpenSSH 7.4 (CentOS 7)          | ✅       | ✅          | ✅      | ✅                 | ✅           |
| OpenSSH 8.2 (Ubuntu 20.04)      | ✅       | ✅          | ✅      | ✅                 | ✅           |
| OpenSSH 9.6 (Ubuntu 24.04)      | ✅       | ✅          | ✅      | ✅                 | ✅           |
| OpenSSH 10.3 (Alpine, mới nhất) | ✅       | ✅          | ✅      | ✅                 | ✅           |
| Dropbear 2026.91                | ✅       | ✅          | ✅      | ✅                 | ✅           |

Ba ca riêng:

- **Thiết bị đời cũ** (chỉ `ssh-rsa`, DH-SHA1, CBC): mặc định bị từ chối, bật legacy thì kết nối
  được, chạy lệnh và SFTP được.
- **2FA** (mật khẩu + TOTP qua PAM google-authenticator): trả lời đúng từng câu hỏi của server; mã
  sai bị từ chối.
- **Bastion 2 tầng**: vào được target chỉ nhìn thấy từ mạng nội bộ; cả 3 chặng đều được kiểm host
  key.

## Lỗi tìm thấy

- **Không kết nối được thiết bị đời cũ.** Tính năng "legacy theo host" mới chỉ là một dòng chú
  thích trong code; server chỉ có thuật toán cũ báo "no matching key exchange algorithm". Đã làm
  đầy đủ từ DB tới ssh2, kèm test.
- Hạ tầng test: globalSetup của vitest không bắt sự kiện `close` của socket. docker-proxy đóng kết
  nối khi sshd chưa sẵn sàng, Promise treo, và Node thoát **lặng lẽ với mã 0**, trông như đã chạy
  xong mà không chạy test nào.
- Môi trường: sshd của CentOS 7 bật GSSAPI và tra DNS ngược, nên mỗi lần đăng nhập mất khoảng 60
  giây, kể cả với client OpenSSH chuẩn. App vẫn chờ và đăng nhập được. Container tắt hai tuỳ chọn
  này cho test nhanh.

## Chưa làm

- Windows OpenSSH Server: cần runner Windows. Chưa chạy được ở đây, nên chưa thêm vào CI.
- Chế độ system ssh với thiết bị đời cũ: phụ thuộc bản OpenSSH trên máy người dùng.
