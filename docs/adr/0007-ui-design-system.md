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
