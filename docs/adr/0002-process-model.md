# ADR-002: Mô hình 3 process

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Bối cảnh

Một kết nối SSH lỗi, một native module crash, hoặc một luồng output lớn không được phép
làm treo hay sập giao diện.

## Quyết định

| Process                         | Chứa                                                   | Không được chứa        |
| ------------------------------- | ------------------------------------------------------ | ---------------------- |
| Renderer (sandbox)              | React UI, xterm.js                                     | Bất kỳ quyền Node nào  |
| Main                            | Cửa sổ, IPC router, vault, SQLite, updater, supervisor | I/O mạng nặng          |
| Session Host (`utilityProcess`) | SSH, PTY, SFTP, forwarding                             | Master key/DEK lâu dài |

- Điều khiển: `ipcRenderer.invoke` → main, mọi tham số validate bằng zod, kiểm tra sender.
- Dữ liệu terminal (phase 0 tuần 2): `MessageChannelMain`, port nối thẳng renderer ↔ Session Host.
- `SessionHostSupervisor` (main) phát hiện crash **và** treo (ping không trả lời), restart
  với backoff 250 ms → 30 s, reset backoff sau 60 s chạy ổn định.
- Ranh giới import giữa các process được ESLint (`import-x/no-restricted-paths`) cưỡng chế;
  chỉ `src/shared` được dùng chung.

## Hệ quả

- (+) Session Host crash: UI vẫn sống, tự phục hồi < 2 s (có E2E kiểm tra).
- (+) Renderer bị XSS cũng không có quyền Node và chỉ gọi được các hàm trong `ShellhouseApi`.
- (−) Thêm một lớp IPC; secret phải được truyền có chủ đích từ main sang Session Host khi xác thực.
