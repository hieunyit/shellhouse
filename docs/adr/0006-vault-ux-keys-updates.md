# ADR-006: Vault UX, key SSH, phím tắt, cập nhật

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Vault UX

- **Tự khoá:** theo thời gian rảnh của TOÀN hệ thống (`powerMonitor.getSystemIdleTime`, kiểm tra
  mỗi 30 s), khi máy ngủ và khi khoá màn hình. Khoá chỉ xoá DEK khỏi bộ nhớ — terminal và kết nối
  vẫn chạy. Mặc định 15 phút.
- **Nhớ trên máy này:** DEK được bọc bằng `safeStorage` (Keychain / DPAPI / Secret Service) và lưu
  trong DB ở một dòng riêng, **không** nằm trong `AppSettings` (thứ được gửi sang renderer).
  Trên Linux, nếu backend là `basic_text` (không có keyring) thì từ chối bật: khoá chỉ bị che, không
  được mã hoá thật. Khi khởi động, DEK được kiểm tra bằng `dek_check` (migration 0003); sai (keychain
  đổi, DB chép sang máy khác) → xoá khoá lưu và hỏi master password.
- **Đổi master password:** chỉ bọc lại DEK → khoá lưu trên máy vẫn dùng được.
- **Sao lưu / khôi phục:** xuất bằng SQLite backup API (secret vẫn mã hoá bằng master password).
  Khôi phục chỉ sau khi kiểm tra: đúng file của app, không hỏng, schema không mới hơn, và **master
  password của bản sao lưu** đúng; dữ liệu hiện tại được lưu một bản `pre-restore` trước; app khởi
  động lại.

## Key SSH

- **Tạo key:** `ssh2.utils.generateKeyPairSync` + kiểm chứng (đọc lại kèm passphrase, public khớp,
  ký/xác minh), tạo lại nếu hỏng. Test: 300 key (một nửa có passphrase) — `ssh-keygen -y` đọc được
  tất cả và ra đúng public key.
- **Triển khai key (ssh-copy-id):** script POSIX cố định qua `exec`, public key gửi qua **stdin**
  (không nằm trong câu lệnh); không thêm trùng; xử lý file thiếu xuống dòng cuối; quyền 700/600.
  Test: key chứa `$(...)`/backtick không bị thực thi.
- Xuất private key ra file với quyền 0600 (+ `.pub`).

## Phím tắt & bảng lệnh

- Danh sách lệnh tập trung (`src/shared/commands.ts`); phím theo vị trí vật lý (`event.code`), mặc
  định khác nhau cho macOS / Windows-Linux, ghi đè trong cài đặt, phát hiện trùng, cảnh báo phím
  terminal cần (Ctrl+C...). Terminal nhường mọi phím đã gán lệnh.
- Hộp thoại: Esc luôn đóng hộp thoại trên cùng (ngăn xếp), trừ khi phần tử đang tự bắt phím.

## Cập nhật

- electron-updater, không tự tải; kênh stable/beta (`allowPrerelease`, cho phép "hạ" khi về stable).
- Tự tắt ở bản dev hoặc khi bản build chưa có cấu hình phát hành (`app-update.yml`).
- **Toàn vẹn:** sha512 trong file kênh qua HTTPS; Windows kiểm tra chữ ký nhà phát hành; macOS yêu cầu
  app đã ký. **Linux AppImage chỉ có sha512** — nếu cần mạnh hơn: ký file kênh bằng ed25519 và kiểm
  tra trong app trước khi cài (chưa làm).
- **Cần làm trước khi phát hành:** cấu hình `publish` trong `electron-builder.yml` (ví dụ GitHub
  Releases của repo thật).

## Lỗi tìm thấy trong phase này

1. Esc không đóng được hộp thoại khi focus rơi ra ngoài (ví dụ sau khi nút bị disable lúc đang xử lý).
2. Nhắc lại từ ADR-004: bộ tạo key của ssh2 sinh key hỏng hiếm khi — trong 300 key lần chạy này không
   gặp ca nào, nhưng bộ kiểm chứng vẫn bắt buộc.
