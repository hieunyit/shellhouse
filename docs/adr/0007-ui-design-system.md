# ADR-007: Hệ thống giao diện, sáng/tối, ngôn ngữ

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Quyết định

- **Toàn bộ chữ trên giao diện là tiếng Anh** — gồm thông báo lỗi từ main/Session Host hiện lên UI,
  hộp thoại hệ điều hành, dòng trạng thái in trong terminal. Comment trong code và tài liệu dự án
  vẫn là tiếng Việt. E2E `english-ui.spec.ts` mở mọi màn hình chính và fail nếu thấy ký tự tiếng Việt
  (bỏ qua nội dung terminal — đó là output của shell).
- **Design token** (`src/renderer/src/styles.css`): component chỉ dùng tên ngữ nghĩa
  (`bg-surface`, `text-muted`, `border-line`, `bg-accent`, `text-danger`...). Giá trị đổi theo
  `data-theme` trên `<html>`; Tailwind v4 `@theme inline` trỏ utility vào biến CSS.
- **Appearance**: System / Light / Dark (cài đặt `appearance.theme`). Main đặt
  `nativeTheme.themeSource` theo cài đặt → hộp thoại hệ thống, thanh cuộn, nền cửa sổ khớp theme.
- Theme terminal "Match app" đi theo giao diện app; nền quanh terminal (`--sh-terminal`) lấy đúng màu
  nền của theme terminal để khung và terminal liền mạch.
- **Dockview** dùng theme riêng `dockview-theme-shellhouse` với mọi biến màu trỏ vào token → đổi
  sáng/tối không cần JS. Tab active có vạch accent (pane đang focus) hoặc xám (pane khác).
- Component dùng chung trong `components/ui.tsx` (Button, IconButton, Input, Select, Checkbox,
  Field, Segmented, Notice, Modal...) — không lặp class Tailwind ở từng màn hình.
- Icon: `lucide-react`.

## Tinh chỉnh giao diện (2026-09-29)

- **Font nhúng sẵn:** Inter Variable cho giao diện, JetBrains Mono Variable cho terminal (mặc
  định), qua `@fontsource-variable`. Trước đó `--font-sans` khai báo Inter nhưng chưa từng nhúng,
  nên Linux luôn rơi về DejaVu. Font được nạp xong trước khi render (`main.tsx`), vì xterm.js đo
  ô chữ một lần lúc mở terminal. Line height mặc định đổi thành 1.15.
- **Viền focus:** rule `:focus-visible` toàn cục chuyển vào `@layer base`. Trước đó nó nằm ngoài
  layer nên thắng mọi utility `outline-none`, làm các ô nhập tự vẽ viền (tìm snippet, kết nối
  nhanh...) có hai viền.
- **Thanh cuộn** dùng `::-webkit-scrollbar` bo tròn. Không dùng `scrollbar-width`/`scrollbar-color`
  vì khi có hai thuộc tính này, Chromium trên Linux vẽ thêm nút mũi tên.
- **Select** tự vẽ mũi tên theo theme (`.sh-select`). **Nút chính** dùng `--sh-accent-solid` với
  chữ trắng, tương phản ≥ 4.5:1 ở cả sáng và tối. `--sh-accent` vẫn dùng cho chữ, icon và focus.
- **Trạng thái kết nối** hiển thị ở ba chỗ, cùng một component `StatusDot`: tab, thanh phiên,
  sidebar (host có phiên đang mở). Nguồn là `useTabStatus`, do `TerminalController.setState` báo.
  Màu host hiển thị bằng ô icon tô màu, thay cho chấm tròn trước đây (trông như báo lỗi).
- **Chuyển động:**
  - Overlay mờ dần; hộp thoại trượt lên và phóng nhẹ (160 ms).
  - Panel SFTP/Forwarding trượt vào; màn khoá rung nhẹ khi sai mật khẩu.
  - Tất cả tắt khi hệ thống bật `prefers-reduced-motion`.
- **Bảng lệnh:** icon, nhóm Commands/Hosts, phím tắt dạng phím, dòng gợi ý phím ở chân. Mục đang
  chọn luôn cuộn vào vùng nhìn thấy (trước đây không). Esc bắt ở cấp window.
- **Tối ưu:**
  - Renderer được minify: 2,54 MB → 1,31 MB. electron-vite mặc định không minify, nên trước đó
    bundle còn mang cả nhánh development của React.
  - Dialog và panel ít dùng tách thành chunk, preload ngay sau lần vẽ đầu. `lazy.tsx` render
    đồng bộ khi chunk đã nạp, vì `React.lazy` luôn suspend một nhịp và làm mất phím Esc bấm
    ngay sau khi mở.
- **Rà soát bằng mắt:** `pnpm build && pnpm screens` chụp mọi màn chính ở cả sáng và tối vào
  `screens/`.
- **Benchmark sau thay đổi** (WSL, không GPU):

  | Chỉ số           | Kết quả | Trước đợt này |
  | ---------------- | ------- | ------------- |
  | Khởi động        | 832 ms  | —             |
  | `cat` 100 MB     | 4,8 s   | 5,3–5,5 s     |
  | Độ trễ phím p95  | 19,1 ms | 19–32 ms      |
  | RAM 10 tab (PSS) | 476 MB  | 476–518 MB    |
