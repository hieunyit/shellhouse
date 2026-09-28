# ADR-005: ProxyJump, port forwarding, SFTP, bố cục

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## ProxyJump

- Mỗi chặng là một `ssh2.Client` riêng; chặng sau dùng kênh `direct-tcpip` của chặng trước làm socket.
  Mỗi chặng tự kiểm tra host key và xác thực (credentials riêng từ vault).
- Main phân giải chuỗi: `jumpHostIds` (host đã lưu, đệ quy, chặn vòng lặp, tối đa 8) hoặc chuỗi
  `ProxyJump` từ `~/.ssh/config` (alias host đã lưu hoặc `user@host:port`).
- Chặng nào rớt thì shell ở đích kết thúc với lỗi `network` → tự kết nối lại cả chuỗi.

## Chế độ tương thích (`ssh` hệ thống)

- Tham số là mảng, luôn có `--` trước hostname; hostname/username/IdentityFile được kiểm tra lại
  ngay trước khi thành tham số. Host key, xác thực do OpenSSH lo; không có SFTP/forwarding.

## Port forwarding

- Chạy trên kết nối SSH của tab, điều khiển qua MessagePort của tab. Forward lưu theo host (bảng
  `forwards`), tuỳ chọn tự bật khi kết nối.
- SOCKS5 (`-D`): chỉ CONNECT, không xác thực (mặc định chỉ nghe loopback), parser thuần có giới hạn
  kích thước handshake, timeout 10 s, fuzz test. Cảnh báo trên UI khi bind không phải loopback.

## SFTP

- Kênh SFTP mở lười trên kết nối của tab. Đường dẫn cục bộ lấy từ hộp thoại của main hoặc kéo thả
  (`webUtils.getPathForFile`). Renderer vốn đã điều khiển được terminal local (tức là thực thi lệnh),
  nên cơ chế "cấp quyền theo đường dẫn" không tăng thêm bảo mật thực chất; ưu tiên là không để
  renderer bị chiếm quyền (CSP, sandbox, không render HTML).
- **Truyền file song song có resume** (`src/session-host/sftp/pipelined.ts`): 32 yêu cầu × 64 KB.
  Đo trên cùng máy với sftp-server của OpenSSH, file 16–64 MB:

  | Cách                                         | Tốc độ         |
  | -------------------------------------------- | -------------- |
  | `createReadStream` của ssh2 (tuần tự)        | 0,9 MB/s       |
  | `fastGet` của ssh2 (song song, không resume) | ~27 MB/s       |
  | Bộ truyền của app — tải xuống / tải lên      | ~30 / ~41 MB/s |

- Tải xuống: đọc song song nhưng **ghi theo thứ tự** → file `.shellhouse-part` luôn là đoạn đầu liền
  mạch, resume an toàn kể cả khi app bị tắt đột ngột. Trước khi nối tiếp, so khớp 4 KB cuối với nguồn;
  lệch (nguồn đã đổi) thì làm lại từ đầu. Kiểm tra kích thước trước khi đổi tên sang file đích.
- Tải lên: sftp-server của OpenSSH xử lý yêu cầu ghi theo thứ tự nhận nên file part phía server cũng
  liền mạch; vẫn có kiểm tra 4 KB cuối.
- Xoá đệ quy không đi theo symlink; giới hạn 10.000 mục.

## Bố cục

- dockview (tab + chia dọc/ngang, kéo thả). Store `useTabs` là nguồn sự thật; dockview chỉ giữ vị trí.
  Panel dùng `renderer: 'always'` để terminal ẩn vẫn sống.

## Snippets

- Biến `{{tên}}` (bắt buộc, không được rỗng) và `{{tên:mặc định}}`. Chèn bằng `term.paste()` →
  bracketed paste khi shell hỗ trợ, snippet nhiều dòng không chạy từng dòng.

## Lỗi tìm thấy trong phase này

1. Thêm forward mới không được lưu (UI gửi id ngẫu nhiên → main hiểu là cập nhật → UPDATE không khớp
   dòng nào, không báo lỗi). Main giờ báo lỗi khi cập nhật bản ghi không tồn tại.
2. **Bấm Enter trong ô tìm snippet làm snippet tự chạy** trước khi điền biến: form điền biến hiện ra và
   nhận luôn phần "submit" của cùng lần bấm Enter; thêm vào đó biến bắt buộc để trống không bị chặn.
   Đã sửa cả hai (preventDefault; biến không có mặc định là bắt buộc).
3. Tìm kiếm mờ không bỏ dấu tiếng Việt ("chao" không khớp "chào").
4. Test: `isVisible({ timeout })` của Playwright không chờ — không dùng để "chờ nếu có".
