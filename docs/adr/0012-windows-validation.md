# ADR-012: Kiểm chứng trên Windows thật

- Trạng thái: Chấp nhận
- Ngày: 2026-09-29
- Máy: Windows 11 Pro (build 26200), có GPU (xterm dùng WebGL), Node 24, không có Visual Studio
  Build Tools.

## Cách chạy

- Mã nguồn được clone sang ổ Windows; cài bằng `corepack pnpm install`. Không cần build native:
  node-pty, better-sqlite3 và sodium-native đều có prebuild N-API cho win32-x64.
- Test chạy bằng Node **của Windows**: unit, E2E (Electron thật), benchmark, smoke test bản đóng
  gói.
- Ma trận tương thích chạy với `COMPAT_EXTERNAL=1`: code SSH/SFTP chạy trên Windows, kết nối tới
  server Docker trong WSL.

## Kết quả

| Bộ test                         | Kết quả trên Windows                                      |
| ------------------------------- | --------------------------------------------------------- |
| Unit + integration              | 279 đạt, 14 bỏ qua (chỉ chạy trên POSIX)                  |
| E2E (app Electron thật)         | 57 đạt, 3 bỏ qua (có lý do, xem dưới)                     |
| Tương thích SSH (8 server thật) | 29/29                                                     |
| Smoke bản đóng gói              | đạt: fuses, native module, đóng tab không bật app thứ hai |

E2E bỏ qua trên Windows:

- Deploy key: server SSH giả chạy lệnh bằng `/bin/sh`.
- SFTP qua giao diện: cần `sftp-server.exe`, chỉ có khi cài OpenSSH **Server**. Phần SFTP vẫn
  được kiểm trên Windows qua ma trận tương thích.
- Dán snippet nhiều dòng: bracketed paste của PSReadLine khác bash.

Các test trước đây bỏ qua vì dùng lệnh POSIX nay đã có bản PowerShell: kích thước ConPTY, biến
môi trường, 20 MB output, snippet có biến.

## Lỗi tìm ra và đã sửa

1. **Chỉ mở được PowerShell** (v1.0 cần cả cmd và WSL). Đã thêm phần chọn shell:
   - Main dò PowerShell 7, Windows PowerShell, cmd, từng bản WSL và Git Bash; trên macOS/Linux
     đọc `/etc/shells`.
   - Renderer chỉ gửi id shell, main tra ra chương trình cần chạy.
   - Có menu cạnh nút "+ Terminal", lệnh trong bảng lệnh, và tuỳ chọn shell mặc định.
2. **Mất nội dung màn hình khi Session Host khởi động lại.** ConPTY xoá màn hình khi phiên mới bắt
   đầu. Sửa bằng `scrollOnEraseInDisplay` (nội dung được đẩy lên scrollback) và `windowsPty`
   (conpty + số build).
3. **Tên tab thành đường dẫn exe** ("C:\WINDOWS\System32\cmd.exe") vì ConPTY đặt tiêu đề cửa sổ.
   Nay tab giữ tên shell; với "…cmd.exe - ping x" thì chỉ hiện "ping x".
4. **`~/.ssh/...` trong ssh_config bị ghép thành đường dẫn lẫn `\` và `/`.** Nay được chuẩn hoá.
5. **Ô "Remember on this device" phản hồi trễ.** Chỉ lộ ra trên Windows, nơi DPAPI giúp tuỳ chọn
   này khả dụng. Nay đổi ngay khi bấm, và trả lại như cũ nếu lỗi.
6. **Bộ nhớ GPU.** Mỗi tab giữ một WebGL context; 10 tab làm tiến trình GPU lên 915 MB. Nay chỉ
   terminal đang hiển thị (kể cả các ô MultiExec) dùng WebGL, và context được giải phóng ngay
   (xterm không tự làm).
7. Hạ tầng test:
   - Tự khoá theo thời gian máy rảnh là thật trên Windows, nên vault khoá giữa chừng khi chạy
     test lâu. Test nay tắt tự khoá.
   - Smoke test bản đóng gói từng mở **hồ sơ dữ liệu thật** vì Windows bỏ qua `APPDATA`. Việc tạo
     vault bị từ chối nên không có gì bị ghi. Nay dùng `--user-data-dir`.
   - Bổ sung `SHELLHOUSE_HOME` cho test (Electron trên Windows bỏ qua `HOME`).
   - Test hostkey bị lỗi vì `ssh-keygen` trên Windows in CRLF; file DB được đóng trước khi xoá.

Đã kiểm chứng **không xảy ra**: node-pty `fork()` khi đóng ConPTY không khởi động app thứ hai
(fuse RunAsNode đang tắt). Smoke test đếm tiến trình liên tục trong lúc đóng tab.

## Hiệu năng (benchmark, `bench/results.csv`)

| Chỉ số                             | Windows (GPU)    | Linux/WSL (không GPU) | Mức nền ConPTY (không có app)        |
| ---------------------------------- | ---------------- | --------------------- | ------------------------------------ |
| Khởi động                          | 1,2 s ✅         | 1,0 s ✅              | –                                    |
| UI bị chặn lâu nhất khi output lớn | 7–44 ms ✅       | 52 ms ✅              | –                                    |
| 100 MB ra terminal                 | 43–54 s          | 4,8–6,4 s             | PowerShell 25–32 s, cmd `type` 100 s |
| Độ trễ phím p95                    | 34,7 ms          | 18,7 ms ✅            | PowerShell 17 ms, cmd 15 ms          |
| RAM 10 tab                         | 899 MB (private) | 483 MB (PSS) ✅       | –                                    |
| RAM 1 tab → mỗi tab thêm           | 548 MB → +39 MB  | 483 MB → ~0           | –                                    |

## Đánh giá tiêu chí v1.0 trên Windows

Tiêu chí ở mục 10 của kế hoạch được đặt theo Linux:

- **100 MB < 5 s không thể đạt với ConPTY.** ConPTY thuần, không có app nào, đã mất 25–100 giây.
  Mọi terminal trên Windows dùng ConPTY đều chịu giới hạn này, kể cả Windows Terminal.
- **Độ trễ phím:** ConPTY đã chiếm 17 ms; app cộng thêm tối đa một khung hình vẽ.

Đề xuất tiêu chí riêng cho Windows, đo tương đối so với mức nền:

- Thông lượng ≥ 60% của ConPTY thuần. Hiện đạt khoảng 55–70%, cần cải thiện phần overhead.
- Độ trễ p95 ≤ mức nền + 20 ms. Hiện đạt: 34,7 so với 17 + 20.
- RAM: đo bằng private bytes. Mục tiêu 10 tab < 700 MB; hiện 899 MB.

## Còn lại

- Overhead thông lượng khoảng 1,5 lần so với ConPTY thuần: cần phân tích (luồng output, flow
  control, CPU tranh chấp với conhost).
- Tiến trình GPU vẫn tăng khoảng 25 MB mỗi tab dù đã bỏ WebGL cho tab ẩn (có thể do lớp
  compositor của panel ẩn). Session Host tăng khoảng 12 MB mỗi tab do node-pty dùng một worker
  thread cho mỗi ConPTY.
- Agent: chưa kiểm được Pageant / OpenSSH agent. Dịch vụ `ssh-agent` đang tắt, bật cần quyền
  admin.
- Windows OpenSSH **Server** (làm đích kết nối): cần quyền admin để cài.
- `electron-builder` chạy trên Windows với corepack pnpm lỗi "No JSON content found". Hiện dùng
  bản build chéo từ WSL; CI build trên runner Windows với pnpm cài sẵn.
