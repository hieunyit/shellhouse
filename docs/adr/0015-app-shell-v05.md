# ADR-015: Khung app theo thiết kế v0.5 — khu vực, Explorer, môi trường

- Trạng thái: Đã triển khai (2026-10-04)
- Ngày: 2026-10-04
- Liên quan: ADR-007 (hệ thống giao diện), ADR-009 / 010 (nhóm lồng nhau, mặc định của nhóm),
  ADR-014 (khuôn module); thiết kế: `design/shellhouse-v0.5/README.md`

## 1. Bối cảnh

Giao diện cũ: một thanh bên (cây host + mục của từng module) và một dockview chứa MỌI tab — terminal,
RDP, editor, Home, tab Kubernetes / Docker / S3 lẫn lộn. Prototype v0.5 tách theo **khu vực**:
activity bar (Home, Hosts, Files, từng module, Transfers, Settings) → Explorer theo ngữ cảnh → vùng
chính. Design system (`src/renderer/src/ds`, token `--ds-*`) đã có từ giai đoạn 1 nhưng chưa màn hình
nào dùng làm khung.

## 2. Quyết định

1. **Khung mới là khung duy nhất** (`src/renderer/src/shell`): title bar 38px (vùng kéo cửa sổ, ← / →,
   command center, Quick connect, Workspaces), activity bar, Explorer (kéo giãn 200–420, ẩn bằng
   `appearance.sidebarHidden`), vùng chính bo góc, status bar. Bỏ TabBar, thanh bên gọn / mở tạm và
   cờ "New interface (beta)" — không giữ hai khung song song.
2. **Khu vực suy từ tab** (`shell/store.ts`): danh sách tab vẫn chỉ có một (`useTabs`). Mỗi tab thuộc
   một khu vực (`tabArea`): phiên → Hosts (Files khi là trình quản lý file), tab module → khu vực của
   module, Home → Home. Chọn tab thì khu vực đi theo; đóng tab cuối của khu vực thì ở lại (trạng thái
   rỗng); đóng tab vừa mở từ khu vực khác (editor mở từ S3…) thì quay về đó.
3. **Dockview chỉ chứa tab phiên** (terminal, RDP, editor, terminal của module). Home và tab module là
   "trang" của khu vực, luôn được giữ khi đã mở (ẩn bằng `visibility`, không `display: none` — xterm
   cần kích thước thật). Dockview tự đổi panel (sau khi đóng tab) không kéo người dùng về khu vực phiên.
4. **Cột điều hướng của module nằm ở Explorer**: module vẽ qua `ExplorerNav` (renderer-kit) — portal vào
   một chỗ trong Explorer khi tab đang hiện; Explorer ẩn thì vẽ lại trong view như trước.
5. **Settings là trang**, mục lục ở Explorer; Esc quay lại màn trước (thay cho đóng hộp thoại).
6. **Môi trường cấu hình được** (`@shared/environments`, cài đặt `environments`): nhãn ngắn, kiểu
   Highlighted / Neutral, vạch trên cùng, mức xác nhận khi xoá (`type` / `confirm` / `undo`), chỉ đọc
   mặc định. Đặt ở **nhóm** (`GroupDefaults.environment`, kế thừa theo cây — nhóm cũ chỉ có màu thì
   suy từ màu) và ở **nguồn của module** (`sourceEnvironments["<module>:<id>"]` trong cài đặt lõi —
   module không phải thêm migration). Tab module báo môi trường cho khung bằng `useReportEnvironment`.
7. **Token cũ trỏ vào token mới**: `--sh-*` (bg-surface, text-muted…) lấy giá trị từ `--ds-*`, nên mọi
   màn hình chưa viết lại vẫn cùng bảng màu; component dùng chung (nút, bảng, menu, modal) được vẽ lại
   theo ds. Module được import `ds/` (ESLint).

## 3. Hệ quả

- E2E chọn khu vực trước khi bấm vào mục của module (`openArea`), đọc tiêu đề tab module qua test hook
  (`activeTabTitle`) vì tab module không có dải tab khi chỉ có một.
- Workspace (lưu bố cục) ghi thêm tab module sau bố cục dockview.
- Môi trường "Type name" bắt gõ tên khi xoá ở Kubernetes (GuardProvider), Docker (container, image,
  volume, network, Compose down) và S3 (object). Form tài khoản S3 chọn được môi trường ngay khi thêm.
- Chọn môi trường ngay khi import kubeconfig; Docker endpoint qua SSH kế thừa môi trường của host
  (đặt riêng bằng menu chuột phải sẽ ghi đè).
