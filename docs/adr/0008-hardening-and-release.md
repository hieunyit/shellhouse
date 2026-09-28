# ADR-008: Ổn định hoá, accessibility, đóng gói và phát hành (Phase 4)

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Quyết định

### Kiểm thử độ bền

- **Chaos proxy** (`test/integration/chaos-proxy.ts`): TCP proxy giả lập các sự cố mạng.
  - Trễ và jitter, giới hạn băng thông.
  - Cắt kết nối sau N byte theo từng chiều.
  - `freeze` (nhận nhưng không chuyển tiếp, giống mạng treo), `cutAll`.
  - Chaos test phủ SSH shell (trễ, băng thông hẹp, mạng treo, RST lúc bắt tay), SFTP resume sau khi
    đứt kết nối và forward -L qua đường chậm.
- **Fuzz** (fast-check, `test/fuzz`) cho các parser nhận dữ liệu không tin cậy: ssh config, quick
  connect, known_hosts, theme nhập từ ngoài, settings, tin nhắn IPC stream, snippet, phím tắt, tìm
  kiếm mờ, đường dẫn SFTP. `pnpm test` chạy ít vòng; `pnpm fuzz` chạy 50.000
  vòng mỗi thuộc tính (CI hằng đêm). Mỗi lỗi fuzz tìm ra có test hồi quy trong
  `test/unit/fuzz-regressions.test.ts`.
- **Soak** (`test/soak`): tải hỗn hợp liên tục qua proxy có trễ.
  - Tải gồm: local loop, 3 tab SSH flood, SFTP 5 MB lên/xuống, forward -L 64 KB mỗi vòng, mở/đóng tab.
  - Đo PSS của mọi process, heap JS của renderer, số fd của Session Host.
  - So trung vị đoạn 20–40% với đoạn 80–100%. Ngưỡng: PSS < +10%, heap < +25%, fd < +25.
  - CI chạy 60 phút mỗi đêm.

### Accessibility

- `useFocusTrap` cho mọi hộp thoại (Modal, bảng lệnh, prompt kết nối): Tab/Shift+Tab xoay vòng bên
  trong, focus vào phần tử đầu, trả focus về chỗ cũ khi đóng. Bấm ra nền không làm mất focus.
- Bảng lệnh theo mẫu combobox/listbox (`aria-activedescendant`), các mục không nằm trong vòng Tab.
- Tuỳ chọn **Screen reader mode** (`terminal.screenReaderMode`) bật cây accessibility của xterm.js.
  Mặc định tắt vì tốn CPU khi output nhiều.
- E2E `a11y.spec.ts` chỉ dùng bàn phím: cài đặt, bảng lệnh, kết nối SSH (host key, mật khẩu, gõ lệnh).

### Link ngoài

- Link trong terminal là dữ liệu từ server, nên không tin cậy. Main luôn hỏi "Open this link in your
  browser?" và hiện URL đầy đủ; mặc định là Cancel. Chỉ nhận http/https; scheme khác bị chặn và
  không hỏi.

### Đóng gói

- Icon sinh bằng script (`scripts/make-icon.mjs`, SDF, không cần thư viện ảnh). Nhờ vậy có thể tạo
  lại và xem lại trong code review.
- Chỉ đóng gói prebuild native của nền tảng đang build (phần unpacked giảm từ 47 MB xuống 16 MB).
- macOS build riêng từng arch (arm64 trên `macos-latest`, x64 trên runner Intel), target dmg + zip
  (auto-update cần zip). Không làm universal vì node-pty được build theo arch của máy build.
  `scripts/merge-mac-channel.mjs` gộp hai `latest-mac.yml`.
- **Smoke test bản đóng gói** (`test/package`): chạy binary thật, điều khiển qua CDP vì fuse đã
  tắt `--inspect`. Kiểm tra:
  - CSP có trong bản build.
  - Test hook bị bỏ qua.
  - Vault tạo được.
  - Cả 3 native module nạp được; Session Host đang chạy.
  - Bắt được lỗi asar, unpack hoặc fuses mà E2E bản dev không thấy.

### Chữ ký cập nhật Linux

- electron-updater trên Linux chỉ kiểm tra sha512 so với file kênh, còn file kênh chỉ được bảo vệ
  bằng HTTPS. Vì vậy CI ký `shellhouse-update-v1\n<version>\n<url> <sha512>\n…` (sắp theo url)
  bằng ed25519 và ghi chữ ký vào trường `shellhouseSignature` của `latest-linux.yml`.
- Updater xác minh chữ ký khi nhận `update-available`, bằng public key nhúng trong
  `src/main/update-keys.ts`. Sai hoặc thiếu chữ ký thì báo lỗi và không cho tải. Sau đó
  electron-updater kiểm tra sha512 của file tải về so với chính file kênh đã ký, nên chuỗi tin cậy
  được khép kín.
- Chưa cấu hình public key thì bản Linux **tắt** tự cập nhật (fail closed).
- Xoay vòng khoá: danh sách nhiều key; phát hành một bản chứa cả key cũ và mới rồi mới đổi khoá ký.

### Phát hành

- Tag `vX.Y.Z` kích hoạt `release.yml` với các bước:
  1. Kiểm tra tag khớp `package.json`, chạy lint, typecheck, test.
  2. Build và ký từng OS. Thiếu secret ký thì dừng, không phát hành bản chưa ký.
  3. Ký file kênh Linux, smoke test bản đóng gói, tạo SHA256SUMS.
  4. Tạo **GitHub Release nháp**. Người phát hành cài thử rồi mới bấm Publish (`docs/RELEASING.md`).
- Owner/repo cho kênh cập nhật lấy từ repo đang chạy workflow (`-c.publish.*`), không ghi cứng.

## Kết quả đo (WSL2, không GPU)

- Soak 20 phút: PSS 612 → 617 MB (+0,8%), heap renderer 26 → 26 MB, fd Session Host 40 → 40,
  0 lỗi SFTP/forward.
- `pnpm audit`: không có lỗ hổng. Electronegativity: không còn cảnh báo thật (xem
  `docs/security-review.md`).

## Lỗi tìm thấy trong phase này

- SFTP treo vĩnh viễn khi kết nối chết giữa lúc truyền, vì ssh2 không gọi callback của yêu cầu đang
  chờ. Chaos test tìm ra; đã sửa bằng `LossGuard`.
- Fuzz tìm ra 4 lỗi: dòng `Host` trống làm crash thư viện ssh-config; `parseSettings([])` crash;
  `CODE_NAMES['valueOf']` và biến snippet `{{constructor}}` lấy nhầm từ prototype.
- Link trong terminal không mở được: handler mặc định của WebLinksAddon mở cửa sổ trống trước, và
  bị chặn.
- IPC nhận cả từ frame con (nếu có) thuộc cửa sổ chính. Đã giới hạn chỉ nhận từ frame gốc.
