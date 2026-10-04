# Shellhouse — Thiết kế lại giao diện (prototype v0.3)

Prototype HTML bấm thử được cho bản thiết kế lại toàn bộ giao diện Shellhouse, theo phong cách **Linear**:
tối là mặc định, xám trung tính dịu, viền 1px rất mảnh, Inter cỡ nhỏ (13px), lưới 4px, **màu luôn mang nghĩa** (trạng thái, môi trường, ngưỡng),
cửa sổ frameless, chuyển động ≤150ms, ưu tiên bàn phím, mật độ thông tin cao nhưng không rối.

**v0.2** áp dụng các quyết định ngày 2026-10-04 (teal duy nhất · frameless · Comfortable mặc định · gõ tên để xác nhận chỉ cho production ·
môi trường đặt theo nhóm), đồng thời bổ sung màn hình cho các tính năng còn thiếu (mục 12, 13).
**v0.3** (2026-10-04) quay lại **màu của v0.1** — xanh lá cho trạng thái khỏe, chip tô nhạt, logo OS/nhà cung cấp màu thương hiệu,
nhãn môi trường có màu — theo tiêu chí *đơn giản & hiện đại* (mục 1), giữ nguyên mọi thay đổi không phải màu của v0.2 (mục 15).

> Đây là **tài liệu thiết kế + prototype**, không đụng `src/`. Mọi token/component ở đây là hạt giống
> cho design system thật (Storybook) khi triển khai vào React.

## Mở prototype

| File | Nội dung |
|---|---|
| `index.html` | Ứng dụng prototype (SPA, hash routing). Mở trực tiếp bằng double-click (file://) trên Chrome/Edge/Brave/Firefox. |
| `kit.html` | Bộ sưu tập component (tối + sáng cạnh nhau, đổi density) — hạt giống design system; mở đầu bằng bảng quy tắc màu theo ngữ nghĩa. |
| `tokens.css` | Design tokens (CSS custom properties). |
| `components.css` | Style component + app shell. |
| `icons.js` | Bộ icon kiểu Lucide (inline SVG) + glyph hệ điều hành/nhà cung cấp (màu thương hiệu đặt bằng CSS `svg.ic.os-*`). |
| `app.js` | Router, tương tác, mock data. |
| `assets/fonts.css` | Inter Variable + JetBrains Mono Variable nhúng base64 (data: URL). |
| `tools/shoot.mjs` | Chụp toàn bộ màn hình → `screens/` (Electron + Playwright). |
| `tools/verify.mjs` | Kiểm tra file:// từ thư mục có dấu cách, bàn phím, focus, lỗi console. |

**Vì sao font nhúng base64?** Chromium (Chrome/Brave/Edge) coi mỗi file `file://` là một origin riêng
nên chặn `@font-face` tải file `.woff2` cạnh bên (lỗi CORS). Prototype vì vậy **không fetch bất kỳ tài nguyên nào**
lúc chạy: chỉ `<link rel=stylesheet>` và `<script src>` cổ điển (đều chạy được trên file://), không iframe,
không ES module, không `fetch()`. Bản sao thư mục ở bất kỳ đâu (kể cả đường dẫn có dấu cách) đều chạy.

URL demo (thêm sau `index.html`) — danh sách đầy đủ ở **mục 13**. Tham số chung:
`theme=light|dark` · `density=comfortable|compact` · `lang=en|vi` · `os=win|mac` (nút cửa sổ trên title bar; mặc định `win`).

Chụp lại ảnh: `node design/prototype/tools/shoot.mjs [lọc-tên]` · kiểm tra: `node design/prototype/tools/verify.mjs`.

---

## 1. Nguyên tắc thiết kế — Màu theo ngữ nghĩa (v0.3, bắt buộc)

Phản hồi v0.2: màu “calm” rút gần hết (trạng thái khỏe xám, logo đơn sắc) “không ổn lắm” → v0.3 dùng lại **màu của v0.1**,
tiêu chí **đơn giản & hiện đại**: màu luôn có nghĩa, nhưng không gây nhiễu (mỗi hàng một chỉ báo trạng thái, không badge trùng lặp, chip cùng một hình dạng).

1. **Trạng thái dùng màu ngữ nghĩa rõ ràng** (chấm 6px + chữ cùng màu):
   xanh lá `--success` = Running/Healthy/Ready/Active/Completed-ok · vàng `--warning` = Pending/Updating/Warning/Degraded ·
   đỏ `--danger` = Failing/Error/CrashLoop/Unhealthy · xanh dương `--info` = Info/Progress (ContainerCreating, Pulling…) · xám = Unknown/Stopped/Exited (vòng rỗng).
   Trong cây host: online = chấm xanh lá, tải cao = chấm vàng, offline = vòng rỗng.
2. **Chip tô nhạt** (nền `-soft` + chữ màu, bo 4px, cao 20px — một hình dạng duy nhất) cho trạng thái ở **header Inspector** và lý do ở “Needs attention”.
   Trong bảng dùng chấm + chữ. **Mỗi hàng một chỉ báo trạng thái**: cột phụ (Health…) chỉ là chữ màu, không chip thứ hai.
3. **Số đếm tô theo nghĩa**: đỏ cho lỗi (“2 failing”, restarts > 5), vàng cho cảnh báo (restarts 1–5, “1 pending”), xám cho số trung tính.
4. **Môi trường có màu, đặt theo nhóm**: chip nhỏ ở hàng nhóm/cluster/endpoint/account — **PROD đỏ · STG vàng · DEV xanh dương · TEST tím**;
   header breadcrumb lặp lại đúng một nhãn cùng màu; PROD thêm vạch đỏ 2px ở đỉnh vùng nội dung. Host kế thừa, **không lặp badge**
   (danh sách host ở Home chỉ có chấm đỏ cho PROD + tên môi trường ở dòng phụ). Status bar không lặp môi trường.
5. **Logo OS/nhà cung cấp màu thương hiệu** (Ubuntu cam, Debian/RHEL đỏ, Windows/Alpine/Docker xanh, AWS cam, MinIO đỏ); macOS/Linux dùng màu chữ phụ.
   Theme sáng dùng tông đậm hơn để đạt ≥3:1 (đồ hoạ).
6. **Accent teal chỉ cho**: nút primary (≤1/màn), focus ring, hàng/mục đang chọn, vạch chỉ báo nav đang active, link (và ô logo Shellhouse).
   Không dùng teal cho trạng thái/badge/biểu đồ — những chỗ đó dùng màu ngữ nghĩa.
7. **Biểu đồ/meter có màu**: chuỗi 1 xanh dương `--chart-1` (CPU, dung lượng, tiến trình), chuỗi 2 tím `--chart-2` (bộ nhớ trong sparkline);
   vượt ngưỡng → vàng (≥75%) / đỏ (≥90%). Pod bar trong graph: xanh lá / vàng / đỏ.
8. **Toast**: thành công = icon xanh lá, thông tin = xanh dương, cảnh báo = vàng, lỗi = đỏ (nền toast vẫn trung tính). Callout info: không khung, icon xanh dương.
9. **Không gradient, không glow, không bóng nặng.** Chỉ popover/dialog có bóng mềm. Viền 1px mảnh. **Ưu tiên khoảng trắng và căn hàng hơn khung**; không card lồng card.
10. **Typography tạo phân cấp** (đậm/cỡ/màu phụ); màu chỉ để mang nghĩa.
11. **Icon 16px stroke 1.5–1.6, màu chữ phụ** (trừ glyph OS/vendor và icon mức độ).
12. **Chuyển động ≤150ms**, chỉ opacity/transform; tôn trọng `prefers-reduced-motion`. Skeleton dùng “pulse”.
13. **Hiệu năng**: không thêm thư viện nặng; danh sách dài phải ảo hóa; tránh layout thrash; module tùy chọn chỉ nạp khi bật (Settings › Modules).
14. **Tương phản AA**: mọi chữ màu và chữ trong chip ≥4.5:1 trên surface/nền khung của theme (xem mục 8).

Các nguyên tắc v0.1 vẫn giữ: một ngôn ngữ cho mọi module (Explorer → Header → Toolbar → List/Graph/Session → Inspector), an toàn theo rủi ro,
bàn phím trước, mật độ có kỷ luật (lưới 4px), trạng thái không hạnh phúc là thiết kế hạng nhất.

### 1.1 Quyết định đã chốt (2026-10-04)

| # | Quyết định | Áp dụng trong prototype |
|---|---|---|
| 1 | Accent = **teal Shellhouse** (bỏ indigo) | `tokens.css` chỉ còn một bộ accent; đã bỏ switch Accent ở Settings, palette, kit. |
| 2 | **Cửa sổ frameless** kiểu Linear | Title bar tự vẽ 38px (`#titlebar`): vùng kéo, ←/→, command center giữa, workspace hiện tại; `?os=win` nút −/□/× bên phải (mặc định), `?os=mac` đèn giao thông inset trái. |
| 3 | Mặc định **Comfortable** | `data-density="comfortable"`; Compact là tùy chọn trong Settings › Appearance. |
| 4 | **Gõ tên để xác nhận chỉ cho production** | `confirmAction`: level 3 tự hạ xuống level 2 nếu `env !== 'prod'` (kể cả hàng loạt ở staging). Demo: `09-confirm-prod` vs `09b-confirm-staging`. |
| 5 | **Môi trường đặt theo nhóm** | Hàng nhóm trong cây mang nhãn env; host kế thừa, không lặp lại. Dialog “Group” (nút ⚙ trên header Hosts) có chọn Environment + mặc định account/jump/port/snippet. Host editor không có ô môi trường. |

## 2. Kiến trúc thông tin (IA)

```
Title bar (frameless) : ⟵ ⟶ · [ Search hosts, resources, commands…  Ctrl K ] · workspace · (−□× | đèn macOS)
Activity bar          Explorer (theo ngữ cảnh)                       Main
─────────────         ───────────────────────────────────────        ──────────────────────────────────────
Home                  Pinned · Recent                                 Welcome, Quick connect, Favorites, Recent, Needs attention
Hosts                 Groups (env ở hàng nhóm) → Hosts                Tabs: Terminal | RDP | Editor | MultiExec
                      Tools: Snippets · Port forwarding ·             Side panel: SFTP | Forwards ; stats bar ; Snippets manager
                             MultiExec · Workspaces
Files                 This computer · Remote (SFTP) · Containers      Trình quản lý 2 khung Local ⇄ Remote + hàng đợi
Kubernetes            Clusters → Overview · Helm · Nodes →            Pods, Deployments (+rollout/RS/history), Helm (+rollback diff),
                      Namespaces → Topology · Kinds                   Topology (graph) + Inspector
Docker                Endpoints → Overview · Containers · Compose ·   Overview (disk usage), Containers ⇄ Compose, Images (+Pull/Build),
                      Images · Volumes · Networks · Registries        Volumes, Networks + Inspector
Storage (S3)          Accounts → Buckets                              Buckets → Objects + Inspector ; Sync… (preview) ; bucket menu
Transfers             All · Active · Queued · Failed · Completed ·    Trung tâm truyền tệp (Resume / Discard)
                      By source
──────────
Settings (đáy)        General · Appearance · Terminal · Shortcuts ·   Trang cài đặt phẳng; Accounts/Keys/Known hosts là danh sách
                      Files | Accounts · SSH keys · Known hosts |
                      Modules · Security & vault · Updates · Diagnostics
Avatar / Vault        menu: khóa vault, auto-lock, backup
```

Điều hướng chính: activity bar (1 cấp) → explorer (ngữ cảnh) → breadcrumb (có *switcher* cho context/endpoint/account).
Chuyển nhanh mọi nơi: ⌘K / Ctrl K (command center trên title bar). Tiền tố: `>` lệnh · `@` host · `;` snippet.

## 3. Giải phẫu App shell

| Vùng | Kích thước | Ghi chú |
|---|---|---|
| Title bar | 38px, toàn chiều ngang | Frameless; `app-region: drag`, mọi nút `no-drag`. Trái: (đèn macOS) logo (ô teal), ←/→. Giữa: command center (mở palette). Phải: workspace hiện tại, nút −/□/× 46px (Windows/Linux; Close hover đỏ theo quy ước OS). |
| Activity bar | 48px | Icon 18px trong ô 32px; chỉ báo active = vạch 2px **teal** bên trái + nền `--active`; chấm đỏ 6px khi module có lỗi; số đếm Transfers màu xám. |
| Explorer | 260px (240 @≤1440, 224 @≤1320), kéo giãn 200–420, thu gọn bằng `[` | Header (tiêu đề + New + thu gọn), ô tìm, tree có roving tabindex (1 điểm dừng Tab, ↑/↓ di chuyển). |
| Main (inset) | phần còn lại, cách mép 8px | Bo 8px, viền mảnh, không bóng. Dải đỏ 2px ở đỉnh khi môi trường là PROD. |
| Main header | 44 / 40px | Breadcrumb (crumb cuối đậm), switcher (`⇅`), scope chip (Namespaces), nhãn môi trường (PROD đỏ · STG vàng · DEV xanh dương · TEST tím), actions bên phải. |
| Toolbar | 44 / 38px | Ô lọc có gợi ý `/` → filter chips → (spacer) → đếm → Live → Segmented view → Columns → Refresh. |
| Bulk bar | thay thế toolbar | “N selected ×” → hành động an toàn → (spacer) → Delete… (đỏ, cuối cùng). Esc để bỏ chọn. |
| Workspace tabs | 36 / 32px | Tab dạng pill, chấm đỏ 5px cho phiên PROD, nút đóng hiện khi hover/active; Split, MultiExec bên phải. |
| Session header + stats bar | 36 + 24px | `● Connected · user@host:port · 18 ms · via bastion · account` + SFTP / Forwards / Snippets / Find / Reconnect; stats bar CPU · Mem · Disk · Load · Net · Up, chỉ báo Logging và tmux. |
| Inspector | 380px (344 @≤1440, 328 @≤1320), kéo 320–640, đóng bằng `]`/Esc | **< 1366px: nổi đè (sheet) lên bảng** để bảng giữ đủ cột. Header: icon tile, tên, kind · namespace · age, badges, action row; sub-tabs; nội dung. |
| Status bar | 26px | Kết nối, Vault, tác vụ nền (“2 transfers · 45%” + progress xanh dương), ngôn ngữ, theme, thông báo. **Không** có env và ⌘K (đã có ở header/title bar). |

## 4. Design tokens

Tất cả trong `tokens.css`. Component **chỉ** dùng token semantic.

### 4.1 Màu (dark / light)

| Token | Dark | Light | Dùng cho |
|---|---|---|---|
| `--bg` | `#08090a` | `#f3f3f4` | Khung: activity bar, explorer, status bar |
| `--surface-0` | `#0e0f11` | `#ffffff` | Panel chính, Inspector |
| `--surface-1` | `#141518` | `#fafafa` | Card, input, group row |
| `--surface-2` | `#1a1b1f` | `#f3f3f4` | Menu, popover, hover mạnh |
| `--surface-3` | `#222328` | `#ebebed` | Kbd, item active trong segmented |
| `--border-subtle / default / strong` | trắng 5.5% / 8.5% / 14% | đen 6% / 9% / 16% | Phân cách hàng / viền control / hover |
| `--text-primary` | `#ecedee` | `#18191b` | Nội dung chính |
| `--text-secondary` | `#a1a4ab` (7.7:1) | `#50545b` (7.6:1) | Giá trị phụ, nhãn |
| `--text-tertiary` | `#8a8e97` (≥4.78:1 trên mọi surface, 4.99 trên hàng đang chọn) | `#636770` (≥4.76:1) | Meta, header cột, placeholder — vẫn đạt AA |
| `--text-disabled` | `#4e5157` | `#a8abb0` | Chỉ cho trạng thái disabled (miễn AA theo WCAG) |
| `--success` | `#4cc38a` | `#146c42` | Trạng thái khỏe/chạy: chấm + chữ, chip `-soft`, pod bar, toast thành công, diff (+) |
| `--warning` | `#e5a83b` | `#8a4f00` | Chờ/cảnh báo/ngưỡng ≥75%, env STG |
| `--danger` | `#f5656a` | `#bc2b27` | Lỗi, số lỗi, ngưỡng ≥90%, env PROD, vạch PROD |
| `--info` | `#4ea7fc` | `#1a60b8` | Thông tin/tiến trình, progress, env DEV |
| `--purple` | `#b48cf2` | `#6a40c2` | Env TEST, `--chart-2` |
| `-soft` / `-border` | 12–13% / 28% | 8–13% / 24–26% | Nền chip/callout/env tag; chữ trong chip ≥4.5:1 trên surface-0…2 và nền khung |
| `--danger-solid` | `#d93a40` | `#c9302c` | Nền nút destructive (chữ trắng ≥4.5:1) |
| `--env-prod / staging / dev / test` (+`-soft`) | = danger / warning / info / purple | | Chip môi trường ở hàng nhóm + nhãn header |
| `--chart-1` / `--chart-2` / `--chart-fill` | `#4ea7fc` / `#b48cf2` / 12% | `#2b7bd9` / `#7d55d6` / 10% | Meter, usage bar, sparkline (vượt ngưỡng → warning/danger) |

**Accent** — chỉ teal (indigo đã bỏ):

| | dark | light |
|---|---|---|
| `--accent` | `#19b3a3` | `#0d7d71` |
| `--accent-contrast` (chữ trên accent) | `#04201c` (6.5:1) | `#ffffff` (5.0:1) |
| `--accent-text` (link) | `#3fcfbe` | `#0b7468` |

Teal sáng trên nền tối không đạt AA với chữ trắng, nên nút primary teal ở dark dùng **chữ gần đen** — có chủ ý.

### 4.2 Typography (Inter Variable; mono: JetBrains Mono Variable)

| Token | Size / line-height | Weight | Dùng cho |
|---|---|---|---|
| `--fs-xs` | 11 / 16 | 500 | Kbd, badge, status bar, nhóm menu |
| `--fs-sm` | 12 / 16 | 400–500 | Meta, header cột, bảng compact |
| `--fs-base` | 13 / 20 | 400–500 | **Mặc định** toàn app |
| `--fs-md` | 14 / 20 | 600 | Tên trong Inspector |
| `--fs-lg` | 16 / 24 | 600 | Tiêu đề dialog |
| `--fs-xl` | 20 / 28 | 600 | Tiêu đề trang (Home, Settings) |

Letter-spacing −0.011em (−0.018em cho tiêu đề); số dùng `tabular-nums`; mono 12px cho IP, image, path, YAML; terminal 13/20.

### 4.3 Spacing · Radius · Elevation · Motion · Z-index

- Spacing (4px grid): `0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64`.
- Radius: `xs 3` (kbd, tag) · `sm 4` (badge, chip) · `md 6` (button, input, menu item) · `lg 8` (card, panel, menu) · `xl 12` (dialog, palette).
- Elevation: phần lớn chỉ là viền 1px (`--shadow-panel`, `--shadow-sm` = viền). Bóng mềm **chỉ** cho `--shadow-popover` (menu/tooltip/toast) và `--shadow-dialog` (dialog/palette). `--shadow-xs: none`.
- Motion: `--dur-fast 120ms` (hover, màu), `--dur-base 150ms`, `--dur-slow 180ms` (vào/ra overlay); `--ease-standard cubic-bezier(.2,0,0,1)`, `--ease-out`. Tôn trọng `prefers-reduced-motion` (đưa về 0).
- Z-index: base 0 · sticky 10 · resizer 20 · dropdown 100 · overlay 200 · dialog 300 · palette 400 · toast 500 · tooltip 600.

### 4.4 Density (`data-density`)

Mặc định **Comfortable** (quyết định #3).

| Token | Comfortable | Compact |
|---|---|---|
| `--row-h` (hàng bảng) | 32 | 28 |
| `--tree-row-h` | 28 | 26 |
| `--ctl-h` / `--ctl-h-sm` / `--ctl-h-lg` | 28 / 24 / 36 | 24 / 20 / 32 |
| `--header-h` / `--toolbar-h` / `--tab-h` | 44 / 44 / 36 | 40 / 38 / 32 |
| `--cell-px` | 12 | 8 |
| `--table-fs` | 13 | 12 |

## 5. Danh mục component & trạng thái

Xem trực quan ở `kit.html`.

| Component | Biến thể | Trạng thái | A11y |
|---|---|---|---|
| Button | primary · secondary · ghost · danger · icon · sm/lg · có kbd | default, hover, active, focus-visible, disabled, loading (spinner) | `<button>`; icon-only bắt buộc `aria-label` + tooltip |
| Input / Filter | default · lg · ghost · có kbd hint | hover, focus (viền accent + halo), error (viền đỏ + message có icon), disabled | `<label>` bọc, `aria-describedby` cho hint/lỗi |
| Select (button-like) | — | như Button | `aria-haspopup="menu"` |
| Checkbox / Switch | checked · indeterminate | hover, focus, disabled | native checkbox / `role="switch" aria-checked` |
| Segmented | text · icon | checked | `role="radiogroup"` / `role="radio" aria-checked` |
| Status | success (xanh lá) · warning (vàng) · danger (đỏ) · info (xanh dương) · neutral (xám, vòng rỗng) — chấm + chữ cùng màu | — | luôn có chữ → không chỉ dựa màu |
| Badge (chip) | neutral · outline · success · info · warning · danger — nền nhạt + chữ màu, một hình dạng | — | một chỉ báo trạng thái mỗi hàng |
| Env tag / Env badge | chip nhỏ chữ hoa: PROD đỏ · STG vàng · DEV xanh dương · TEST tím (hàng nhóm) · badge header cùng màu | — | `aria-label` cho env badge |
| Chip (filter) | default · active (nền xám, có ×) · add (dashed) · static | hover | `aria-pressed` cho chip bật/tắt |
| Tag (key=value) | mono | — | — |
| Meter / Progress | xanh dương (`--chart-1`) · warning ≥75% · danger ≥90% · progress xanh dương | — | `role="meter"` + `aria-valuenow` |
| Tabs (underline) | có count, count cảnh báo | selected, hover, focus | `role="tablist/tab"`, roving tabindex |
| Workspace tab (pill) | terminal · RDP · editor; chấm PROD | selected, hover (hiện ×) | `role="tab"`, Alt+1…9 |
| Tree item | group (chevron) · leaf · có env/count/dot | hover, selected, focus | `role="tree/treeitem"`, `aria-expanded`, `aria-level`, roving tabindex |
| DataTable | sortable header · checkbox · actions ⋯ · group row · cột tùy chọn theo bề rộng | hover, selected (accent soft), active (vạch trái), keyboard focus (vòng), empty, loading (skeleton) | `role="grid"`, `aria-sort`, `aria-selected`, `aria-multiselectable` |
| Bulk bar | — | — | `role="toolbar"` |
| PropertyList | — | copy-on-hover | `<dl>` |
| Section / Icon tile | tile: neutral · success · info · warning · danger | — | — |
| Callout | info (không khung, icon xanh dương) · success · warning · danger (nền nhạt, không viền) | — | `role="alert"` cho danger |
| Title bar | win · mac | hover nút cửa sổ | `role="group" aria-label="Window controls"` |
| Diff | thêm (xanh nhạt) · xóa (đỏ nhạt) · hunk | — | `role="region"` |
| Transfer row | active · queued · failed (Resume/Discard) · done | hover | `role="listitem"` |
| Setting row | tiêu đề + mô tả + control (switch/segmented/select/button) | — | switch `role="switch"` |
| Menu / Context menu | item · checkbox item · label · separator · danger · disabled · meta/kbd | hover/active (↑↓) | `role="menu/menuitem(checkbox)"`, Esc trả focus về anchor |
| Tooltip | text + kbd | delay 450ms (hover), ngay lập tức (focus bàn phím) | `role="tooltip"` + `aria-describedby` |
| Toast | success · info · warning · danger · có action (Undo) | tự tắt 5s, dừng khi hover | `role="status"` / `alert` |
| Dialog | default · danger (3 mức rủi ro) | — | `role="(alert)dialog" aria-modal`, focus trap, Esc, trả focus |
| Command palette | nhóm: Recent · Navigation · Hosts · Actions; tiền tố `>` lệnh, `@` host | chọn bằng ↑↓/Ctrl+N/P | `role="combobox"` + `listbox`, `aria-activedescendant` |
| Empty state | no-data · no-results · error | có hành động | — |
| Graph node | resource card + problem pill (viền màu, nền trong) + pod bars (xanh lá; đỏ/vàng khi lỗi) | hover (path xám đậm), selected (viền teal), dim | `role="button"` + `aria-label` mô tả vấn đề bằng chữ |

## 6. Mẫu màn hình (screen patterns)

**Resource list** (Pods, Containers, Objects, Accounts) — Toolbar chuẩn → DataTable → Inspector. Cột theo thứ tự:
chọn · tên (đậm, có icon) · ngữ cảnh (namespace/image) · trạng thái (chấm + chữ màu) · số liệu (restarts tô màu theo ngưỡng, meter CPU/RAM) · vị trí (node/ports) · tuổi · ⋯.
Khi hẹp: ẩn cột tùy chọn theo bề rộng thật (node → namespace → thanh meter), Inspector chuyển thành sheet nổi < 1366px.
Mặc định sắp xếp **vấn đề lên đầu** (CrashLoop/ImagePull → Pending → Running).

**Resource detail (Inspector)** — Header (icon tile + tên + `Kind · namespace · age` + badges) → action row (thường dùng nhất trái, xóa ở phải, ghost đỏ) →
sub-tabs `Overview · Events · Logs · YAML · Metrics · Related` → Overview bắt đầu bằng **callout giải thích vấn đề bằng lời** + hành động gợi ý,
rồi PropertyList, Containers, Conditions, Labels. Events: Warning có nền vàng nhạt + vạch trái, đếm `×87`. Logs: tìm kiếm có số khớp, ERR tô nền đỏ nhạt, follow/wrap.

**Overview (Home)** — Quick connect `user@host:port` (chọn giao thức SSH/Telnet/Serial/RDP/Local, Enter) → Favorites (lưới phẳng) → Recent (danh sách phẳng, nhóm hiện ở dòng phụ) | Needs attention (icon mức độ + 1 chip lý do + mô tả + nguồn) → Get started (liên kết chữ, không tile).

**Graph (Topology)** — 4 lane `Entry → Services → Workloads → Pods`, card cùng ngôn ngữ với danh sách; cạnh vuông góc bo góc 6px, nằm *sau* card;
cạnh hỏng nét đứt đỏ; hover/focus một node làm sáng toàn bộ đường đi lên/xuống và làm mờ phần còn lại; problem pill viết bằng chữ (“CrashLoop”, “Unschedulable”, “No endpoints”);
panel “3 problems” giải thích nguyên nhân + tác động, **chỉ tự mở khi còn chỗ** (không bao giờ che node), thu gọn thành pill khi hẹp. Zoom −/+/Fit, Ctrl+cuộn, kéo để pan, legend.

**Session (Terminal / RDP / Editor)** — Tabs → Session header (`● Connected · user@host:port · 18 ms · via bastion · PROD`, hành động phải) → body.
SFTP là side panel bật/tắt (⌘⇧F), theo dõi cwd; Split (⌘\\) với nhãn pane và chấm focus. RDP dùng *cùng* header: độ phân giải, Fit, clipboard, Ctrl+Alt+Del, mở client ngoài.

**Settings** — Explorer là mục lục (3 nhóm: chung · Credentials · App); trang có tiêu đề + mô tả + các nhóm hàng cài đặt phẳng (tiêu đề nhóm xám, hàng có tiêu đề/mô tả/control bên phải) — không card.
Accounts là resource list (tên, username, badge Key/Password/Passphrase, “Used by N hosts” với chồng icon OS, last used) + Inspector (chi tiết, danh sách host dùng chung, ghi chú override theo host).

## 7. Quy tắc tương tác

### 7.1 Bàn phím

| Phím | Hành động |
|---|---|
| `Ctrl/⌘ K` | Command palette (lọc fuzzy, ↑↓, Enter; `>` lệnh, `@` host) |
| `?` | Bảng phím tắt |
| `/` | Focus ô lọc của view hiện tại |
| `[` / `]` | Thu/mở Explorer / Inspector |
| `g` rồi `h s f k d b t` | Home · Hosts · Files · Kubernetes · Docker · Storage · Transfers |
| `j` `k` / `↓` `↑` | Hàng kế / trước |
| `x` | Chọn/bỏ chọn hàng (hiện bulk bar) |
| `Enter` | Mở hàng trong Inspector |
| `L` · `S` · `E` · `F` | Logs · Shell · Edit YAML · Port-forward |
| `⇧R` | Restart/Refresh |
| `Ctrl/⌘ ⌫` | Xóa (luôn qua xác nhận theo mức rủi ro) |
| `Esc` | Đóng lớp trên cùng: menu → dialog → palette → bỏ chọn → đóng Inspector |
| `Alt+T` | Đổi theme |
| `Ctrl/⌘ T`, `W`, `\`, `⇧F`, `Alt+1…9` | Tab mới, đóng tab, split, SFTP, chuyển tab |
| `Ctrl/⌘ ⇧M` · `Ctrl/⌘ ⇧S` | MultiExec · Snippets (palette với tiền tố `;`) |
| Tree: `↑ ↓ Home End` | Di chuyển trong Explorer (1 điểm dừng Tab) |
| Graph: `+ − ⇧1` | Zoom, Fit |

Phím đơn chỉ hoạt động khi focus **không** ở ô nhập. Phím tắt luôn hiện trong tooltip và menu.

### 7.2 Xác nhận theo mức rủi ro

| Mức | Khi nào | Hình thức |
|---|---|---|
| 1 — Thấp | Có thể hoàn tác, không phá dữ liệu (restart Pod có controller ở dev, copy, scale lại) | Làm ngay + toast có **Undo** (5s) |
| 2 — Trung bình | Phá hủy ở **staging/dev/test/không môi trường**, kể cả hàng loạt (xóa container staging, object có versioning, account, image) | Dialog: mô tả tác động (+ số lượng nếu hàng loạt), Cancel (focus mặc định) / nút đỏ |
| 3 — Cao | Phá hủy trên **PRODUCTION** (chỉ production — quyết định #4) | Dialog + nhãn PROD + danh sách tác động + **gõ tên** (1 tài nguyên) hoặc **“N pods”** (hàng loạt); phân biệt hoa thường; chặn paste; nút chỉ bật khi khớp; ghi audit log |

Demo: *Topology/Pods → ⋯ → Delete…*, ⌘K → “Delete Deployment web…”, Helm › Uninstall (prod, level 3); Docker container › Remove (staging, level 2).

### 7.3 Bulk actions
Chọn bằng checkbox (hiện khi hover hoặc khi đã có lựa chọn), `x`, hoặc “Select all” (indeterminate khi chọn một phần).
Bulk bar thay toolbar, giữ nguyên chiều cao (không xô layout). Hành động không áp dụng được thì **disabled kèm lý do** (tooltip), không ẩn.

### 7.4 Empty / Error / Loading
- **Loading**: skeleton giữ đúng chiều cao hàng (không spinner toàn trang); hành động dài → task trên status bar.
- **Empty (chưa có dữ liệu)**: minh họa đơn giản + 1 câu giải thích + hành động chính.
- **No results**: nhắc lại truy vấn + “Clear filters”.
- **Error**: nói nguyên nhân bằng lời người dùng (“TLS handshake timeout after 10s”) + Retry; lỗi kết nối hiện ở status bar và toast danger.

## 8. Trợ năng (WCAG 2.2 AA)

- Tương phản (đo lại v0.3): mọi chữ ≥4.5:1 — `--text-tertiary` dark giữ `#8a8e97` (≥4.78:1 trên bg/surface-0…3); light `#636770` ≥4.76:1.
  Chữ màu trên surface: success/warning/danger/info/purple ≥5.1:1 (dark) / ≥5.0:1 (light). Chữ trong chip (nền `-soft`) ≥4.5:1 trên surface-0…2 và nền khung
  (thấp nhất: danger dark 4.86 trên surface-2, info light 4.90 trên nền khung) — vì vậy dark danger nâng lên `#f5656a`, light success/warning/info đậm hơn
  (`#146c42` / `#8a4f00` / `#1a60b8`). Nút primary 6.5:1 (dark) / 5.0:1 (light); danger-solid 4.6+. Glyph OS/vendor (đồ hoạ) ≥3:1.
- Focus luôn thấy được (`:focus-visible` = vòng 2px accent + khe 2px), không bị che (2.4.11); hàng bảng focus có vòng riêng.
- Không chỉ dựa màu: trạng thái có chữ, problem pill có chữ, cạnh hỏng là nét đứt, env có nhãn chữ.
- Kích thước mục tiêu (2.5.8): control nhỏ nhất 24px ở comfortable; ở compact icon button 20px dùng ngoại lệ khoảng cách (vòng 24px không chồng nhau).
- ARIA: landmarks (nav/aside/main/footer), tree/grid/tablist/menu/dialog/combobox đúng vai trò; live region cho status bar và toast.
- Skip link “Skip to content”; thứ tự Tab: activity bar → explorer (1 điểm dừng) → header → toolbar → bảng (1 điểm dừng, j/k bên trong) → inspector → status bar.
- `prefers-reduced-motion` tắt chuyển động. Ngôn ngữ trang (`lang`) đổi theo EN/VI.

## 9. i18n
Nút **EN/VI** ở status bar (hoặc Settings › Appearance) chỉ dịch nhãn khung. Thuật ngữ kỹ thuật giữ tiếng Anh theo glossary
(Pod, Deployment, Namespace, Container, Compose, Bucket, Object, Events, Logs, YAML…). Bố cục chịu được chuỗi tiếng Việt dài hơn ~30%.

## 10. Câu hỏi mở còn lại

1. **Inspector dưới 1366px**: sheet nổi (như prototype) hay tự thu gọn Explorer?
2. **Topology**: hiện Pod riêng lẻ (như prototype) hay gộp Pod vào card workload, chỉ bung khi chọn (đỡ cao với namespace lớn)?
3. **Accounts**: cho phép một host dùng nhiều account (chọn khi kết nối) hay chỉ một + override?
4. **Sắp xếp “vấn đề lên đầu”** có áp dụng cho mọi danh sách (Containers, Hosts, Helm) không?
5. **Home**: giữ bố cục cố định hay cho tùy biến widget?
6. **Chấm trạng thái trong cây host**: v0.3 hiện chấm xanh lá cho mọi host online (như v0.1). Nhóm 30+ host có cần tuỳ chọn “chỉ hiện host có vấn đề” không?
7. **Files** là activity riêng (như prototype) hay chỉ là side panel SFTP + tab “Open in file manager”?
8. **Command center trên title bar** thay hẳn nút Search trong header (như prototype) — có cần giữ phím `Ctrl ⇧ P` của app hiện tại làm phím phụ không? (Settings › Shortcuts đang để làm “Alternative”.)
9. **macOS**: đèn giao thông dùng màu hệ thống (không đổi được); có muốn vị trí `trafficLightPosition` 14/13 như prototype hay căn giữa title bar 38px?
10. **Bảng màu terminal mặc định** (“Match app”) có nên dịu hơn (ANSI desaturated) để hợp tông app, hay giữ màu chuẩn cho người dùng quen?

## 11. Bước tiếp theo đề xuất
1. Chốt các câu hỏi trên → khóa token v1 (màu theo ngữ nghĩa, v0.3).
2. Chuyển `tokens.css` thành nguồn token duy nhất (CSS vars + TS export), dựng Storybook từ `kit.html`.
3. Làm shell mới (Title bar frameless/Activity bar/Explorer/Inspector/Status bar/Palette) sau feature flag, rồi chuyển từng module theo thứ tự K8s → Hosts/Files → Docker → S3.
4. Áp dụng quy tắc màu theo ngữ nghĩa như một checklist review (mục 1) cho mọi PR giao diện.

## 12. Bảng đối chiếu tính năng

Đối chiếu với app thật (`src/` — đọc, không sửa). Cột **Nơi ở**: A = activity bar, E = explorer, V = view chính, I = inspector, P = command palette (⌘K), S = Settings,
T = title bar, SB = status bar, D = dialog. Cột **Mẫu** là pattern ở mục 5–6. **Prototype**: ✓ có màn hình/tương tác · ◐ có điểm vào + mô tả, dùng lại mẫu đã có · — chỉ trong bảng.

### 12.1 Kết nối & phiên

| Tính năng | Nơi ở trong UI mới | Mẫu | Prototype |
|---|---|---|---|
| Host SSH / Telnet / Serial / RDP | A Hosts → E cây nhóm → V tab phiên (Terminal / RDP) | Session (tabs · session header · body) | ✓ SSH, RDP; ◐ Telnet/Serial (nhóm “Network gear”, nhãn giao thức ở hàng) |
| Nhóm host + mặc định (account, jump host, port, snippet khởi động, forwards) | E hàng nhóm → D “Group” (nút ⚙ header Hosts, `+` cạnh “Groups”) | Dialog form | ✓ `02g-group-dialog` |
| Môi trường theo nhóm | E nhãn ở hàng nhóm; header nhãn PROD; vạch đỏ 2px | Env tag (màu theo môi trường) | ✓ |
| Favorites / Recent | V Home; E Home (Pinned/Recent); P nhóm Recent | Plain list | ✓ |
| Quick connect | V Home (ô `user@host:port` + chọn giao thức); T command center | Input lớn + menu | ✓ |
| Accounts (credential dùng chung) | S › Accounts (list + I) ; session header hiện account | Resource list + Inspector | ✓ `07-settings-accounts` |
| SSH keys: generate / import / export / deploy key | S › SSH keys (bảng + Copy public key / Deploy key…) ; menu ⋯ phiên terminal “Deploy SSH key…” | Resource list | ✓ `07f-settings-keys` |
| Known hosts (fingerprint, key đổi) | S › Known hosts (callout cảnh báo + bảng) ; E đếm “1 changed” đỏ | Resource list + Callout | ✓ `07g-settings-known-hosts` |
| Jump host | D Group (mặc định) ; session header “via bastion-01” | Form field / meta | ✓ |
| Port forwarding L / R / D, đã lưu, auto-start | V phiên → side panel **Forwards** ; E Hosts › Tools › Port forwarding | Side panel list + form | ✓ `02d-hosts-forwards` |
| SFTP | V phiên → side panel SFTP (theo cwd) ; A **Files** 2 khung | Side panel / Two-pane | ✓ `02-hosts-terminal`, `15-files` |
| Local file manager | A Files → khung trái “This computer” | Two-pane | ✓ |
| Hàng đợi truyền (resume / discard) | A **Transfers** ; dải queue dưới Files ; SB “2 transfers · 45%” | Transfers center | ✓ `16-transfers` |
| Editor trong app (CodeMirror) | V tab Editor (nginx.conf) ; Files › Edit (F4) ; double-click file | Session (tab · header · body) + Diff “Compare with server” | ✓ `02f-editor` |
| Snippets có biến `{{name}}` / `{{name:default}}`, macro | P tiền tố `;` → D điền biến ; E Hosts › Tools › Snippets (list + I chỉnh sửa) ; nút `{}` ở session header | Palette + Dialog + Resource list | ✓ `08b`, `08c`, `17-snippets` |
| MultiExec (broadcast) | V Hosts — tab “MultiExec · N”, thanh broadcast trên lưới terminal, checkbox từng pane ; `Ctrl ⇧ M` | Broadcast bar + split | ✓ `02e-multiexec` |
| Workspaces (bố cục tab/split) | T tên workspace ; E Hosts › Tools › Workspaces → D ; P | Dialog list | ✓ (dialog) |
| Gợi ý lệnh từ lịch sử | Terminal (ghost text) ; S › Terminal “Suggest commands from history”, “Clear history…” | Setting row | ◐ |
| Server stats bar | V phiên — dải 24px dưới session header | Stats bar (meter xanh dương, vàng/đỏ theo ngưỡng) | ✓ |
| Session logs | Stats bar “● Logging” ; S › Files › Session logs | Setting row | ✓ |
| tmux | Stats bar “tmux: main” ; menu ⋯ “Attach tmux session…” | Menu | ◐ |
| Tìm trong terminal | Session header (🔍, `Ctrl ⇧ F`) | Find bar (như logs search) | ◐ |
| Split pane | Tabs bar (Split, `Ctrl \`) | Split | ✓ `02b-hosts-split` |
| RDP (embedded / mstsc) | V tab RDP: Fit, clipboard, Ctrl+Alt+Del, Open in external client | Session | ✓ `02c-hosts-rdp` |

### 12.2 Ứng dụng

| Tính năng | Nơi ở | Mẫu | Prototype |
|---|---|---|---|
| Themes (app sáng/tối, theme terminal, import .json/.itermcolors) | S › Appearance, S › Terminal › Colors | Setting rows + swatch | ✓ `07b`, `07c` |
| Font / cursor / scrollback / copy on select / paste nhiều dòng | S › Terminal | Setting rows | ✓ |
| Trình sửa phím tắt (ghi phím, xung đột, phím thay thế) | S › Keyboard shortcuts ; `?` mở bảng tóm tắt (link “Customize…”) | Bảng 3 cột | ✓ `07d-settings-shortcuts` |
| Vault: khóa, auto-lock, đổi master password, nhớ trên máy | S › Security & vault ; avatar menu ; SB “Vault unlocked” ; `Ctrl ⇧ L` | Setting rows | ✓ `07e-settings-security` |
| Backup / restore | S › Security & vault › Backup | Setting rows | ✓ |
| Updates (kênh Stable/Beta) | S › Updates | Setting rows | ✓ `07k` |
| Diagnostics | S › Diagnostics (phiên bản, bộ nhớ, session host, copy details) | Setting rows | ✓ `07l` |
| Modules manager (bật/tắt K8s, Docker, S3, RDP, Serial) | S › Modules | Setting rows + switch | ✓ `07h` |
| Import hosts (ssh config, MobaXterm, Termius, CSV) | V Home “Import” ; Get started | Dialog | ◐ |
| Command palette | T command center ; `Ctrl K` | Palette (`>` `@` `;`) | ✓ |
| i18n EN/VI | SB, S › Appearance | — | ✓ `14-i18n-vi` |

### 12.3 Docker

| Tính năng | Nơi ở | Mẫu | Prototype |
|---|---|---|---|
| Endpoints (local / SSH / TCP-TLS), môi trường theo endpoint | E Endpoints ; header switcher | Tree + switcher | ✓ |
| Overview: số liệu, disk usage, reclaimable, clean up | E › Overview | Stat row + usage bars (xanh dương; phần thu hồi được màu vàng) + Needs attention | ✓ `05d-docker-overview` |
| Containers + bulk (start/stop/restart/remove) | E › Containers | Resource list + Bulk bar + I | ✓ `05-docker-containers` |
| Compose (up/stop/restart/logs/edit file/down) | E › Compose | Grouped list | ✓ `05b-docker-compose` |
| Logs · Exec shell · Files tab · Env (ẩn secret) · Stats | I tabs của container | Inspector tabs | ✓ `05c-docker-env` |
| Images: pull / push / build / tag / remove, layers | E › Images ; D Pull, D Build ; I layers | Resource list + Dialog | ✓ `05e`, `05f`, `05g` |
| Volumes (dùng bởi, browse, remove unused) | E › Volumes | Resource list | ✓ `05h` |
| Networks (subnet, attachable, connect container) | E › Networks | Resource list | ✓ `05i` |
| Registries (Docker Hub, GHCR, GitLab, khác) | E › Registries ; D Pull “Registry login” | Dialog | ◐ |

### 12.4 Kubernetes

| Tính năng | Nơi ở | Mẫu | Prototype |
|---|---|---|---|
| Clusters / contexts, môi trường theo cluster | E Clusters ; header switcher | Tree + switcher | ✓ |
| Overview “needs attention” | E cluster › Overview ; Home Needs attention | Stat row + attention list (như Docker overview) | ◐ |
| Mọi loại tài nguyên + CRDs | E namespace › kinds (CRDs thêm nhóm “Custom resources”) | Resource list | ✓ Pods, Deployments; ◐ còn lại dùng cùng mẫu |
| Bulk | Bulk bar (Pods) | Bulk bar | ✓ `03d-k8s-pods-bulk` |
| Logs · Shell · Port-forward · Debug (ephemeral container) | I action row (L / S / F) ; menu ⋯ “Debug…” | Inspector | ✓ Logs; ◐ Shell/PF/Debug |
| YAML edit + diff trước khi apply | I › YAML / “Edit YAML” → D Review changes (diff, server dry-run) | Diff dialog | ✓ `03g-k8s-yaml-diff` |
| Deployment: rollout, ReplicaSets, history, roll back, scale, restart | V Deployments + I (Overview/History) | Resource list + Inspector | ✓ `03e`, `03f` |
| Helm releases: revisions, values, resources, rollback (diff), uninstall | E cluster › Helm releases ; I ; D rollback | Resource list + Diff dialog + Confirm L3 | ✓ `03h`, `03i` |
| Events live | I › Events (warning trước, vạch trái vàng) | Event list | ✓ `03b` |
| Map / Topology / Traffic service map | E namespace › Topology (Graph) | Graph | ✓ `04`, `04b` (traffic = lớp phủ cạnh, ◐) |
| Metrics | I › Metrics (sparkline CPU xanh dương / bộ nhớ tím, đỏ khi vượt ngưỡng) | Spark list | ✓ |
| Nodes: cordon / drain | E cluster › Nodes → list + I (Cordon, Drain… = Confirm L3 trên prod) | Resource list | ◐ |

### 12.5 S3

| Tính năng | Nơi ở | Mẫu | Prototype |
|---|---|---|---|
| Accounts (AWS, MinIO, R2…), môi trường theo account | E Accounts ; header switcher | Tree + switcher | ✓ |
| Buckets | V Buckets | Resource list | ✓ `06-s3-buckets` |
| Objects, upload kéo-thả, folder | V Objects + I | Resource list | ✓ `06b-s3-objects` |
| Versions (restore), metadata, tags | I › Overview (Versions, Tags) / Metadata | Inspector | ✓ |
| Share links (presigned, hạn dùng) | I › Share link | Inspector section | ✓ |
| Bucket settings: lifecycle, CORS, policy, versioning, stats | Toolbar ⚙ → menu bucket → trang/I tương ứng | Menu + Setting rows | ◐ |
| Sync / mirror có preview | Toolbar “Sync…” → D (So sánh, upload/update/delete, dry-run) ; P | Sync dialog | ✓ `06c-s3-sync` |
| Transfers | A Transfers (nguồn S3) ; tiến độ inline trong hàng object | Transfers center | ✓ |

## 13. Danh sách màn hình & URL (v0.2 · chụp lại ở v0.3)

Mở `index.html` + hash bên dưới (thêm `&theme=light`, `&os=mac`… tùy ý). Ảnh chụp trong `screens/` theo mẫu `{theme}-{size}-{tên}.png`.

| Tên ảnh | URL | Mới v0.2 |
|---|---|---|
| 01-home · 01b-home-mac | `#/home` · `#/home?os=mac` | title bar |
| 02-hosts-terminal | `#/hosts?tab=term&sftp=1` | stats bar |
| 02b-hosts-split · 02c-hosts-rdp | `#/hosts?split=1&sftp=0` · `#/hosts?tab=rdp` | |
| 02d-hosts-forwards | `#/hosts?panel=forwards` | ✓ |
| 02e-multiexec | `#/hosts?multi=1` | ✓ |
| 02f-editor | `#/hosts?tab=logs&panel=none` | ✓ |
| 02g-group-dialog | `#/hosts` → nút ⚙ “Edit group” | ✓ |
| 03-k8s-pods · 03b/03c/03d | `#/k8s/pods?itab=overview|events|logs` · `?select=3` | |
| 03e/03f-k8s-deployment | `#/k8s/deployments?itab=overview|history` | ✓ |
| 03g-k8s-yaml-diff | `#/k8s/deployments` → Edit YAML | ✓ |
| 03h-helm · 03i-helm-rollback | `#/k8s/helm?helm=shop` · Roll back… | ✓ |
| 04-k8s-topology · 04b | `#/k8s/topology` | |
| 05-docker-containers · 05b · 05c | `#/docker` · `#/docker/compose` · `?itab=env` | |
| 05d-docker-overview | `#/docker/overview` | ✓ |
| 05e-docker-images · 05f-pull · 05g-build | `#/docker/images` (+ Pull / Build…) | ✓ |
| 05h-docker-volumes · 05i-docker-networks | `#/docker/volumes` · `#/docker/networks` | ✓ |
| 06-s3-buckets · 06b-s3-objects | `#/s3` · `#/s3/objects` | |
| 06c-s3-sync | `#/s3/objects` → Sync… | ✓ |
| 07-settings-accounts | `#/settings/accounts` | |
| 07b…07l-settings-* | `#/settings/appearance|terminal|shortcuts|security|keys|known-hosts|modules|general|files|updates|diagnostics` | ✓ (trừ appearance) |
| 08-palette · 08b-palette-snippets · 08c-snippet-vars | `Ctrl K` · `Ctrl K` rồi `;` · chọn snippet | ✓ 08b, 08c |
| 09-confirm-prod · 09b-confirm-staging | Topology › Delete… · Docker › Remove container | ✓ 09b |
| 10-context-menu · 11-shortcuts · 12-toast-tooltip · 13-keyboard-focus · 14-i18n-vi | | |
| 15-files | `#/files` | ✓ |
| 16-transfers | `#/transfers` | ✓ (làm lại) |
| 17-snippets | `#/snippets` | ✓ |

## 14. Thay đổi v0.1 → v0.2 (trước / sau)

| Chỗ | v0.1 | v0.2 |
|---|---|---|
| Accent | Teal hoặc Indigo (switch) | Chỉ teal; bỏ switch ở Settings/palette/kit |
| Cửa sổ | Title bar của OS | Frameless: title bar tự vẽ 38px, command center giữa, nút cửa sổ Win / đèn macOS |
| Logo app | Ô teal đặc | Ô xám đơn sắc trên title bar |
| Logo OS / vendor | Màu thương hiệu (Ubuntu cam, Debian hồng, Windows xanh, AWS cam, MinIO đỏ…) | Đơn sắc, màu chữ phụ |
| Môi trường | Tag màu ở mọi host + badge nền đỏ + status bar “PRODUCTION” + STG vàng, DEV xanh, TEST tím | Chỉ hàng nhóm; prod = chấm đỏ + chữ xám; header “PROD” chữ đỏ nhỏ; vạch 2px; STG/DEV/TEST chữ xám; bỏ ở status bar |
| Trạng thái tốt | Chip xanh “Healthy”, “Running”, “Enabled”, dot 8px xanh đậm | Chữ xám + chấm 6px dịu; host online không chấm |
| Chip | success/info/accent/warning/danger | Chỉ danger/warning (vấn đề), ≤1 chip màu/hàng |
| Số đếm | Badge đỏ đặc cho Transfers, badge đỏ trong chip filter | Xám; đỏ chỉ cho số lỗi (chữ, không nền) |
| Biểu đồ | Xanh dương/tím | Một tông xám; đỏ khi vượt ngưỡng |
| Graph | Lane có nền, glow khi hover, pill đỏ đặc, pod bar xanh | Lane chỉ là vạch mảnh, hover viền xám, pill viền màu, pod bar xám |
| Home | Card cho Favorites/Recent/Attention/Get started, tile màu | Danh sách phẳng, icon mức độ nhỏ, liên kết chữ |
| Inspector | Card lồng (containers, sparklines), callout info có khung xanh | Hàng phẳng phân cách mảnh, callout info không khung |
| Input focus | Viền + halo 3px | Chỉ viền 1px teal (focus bàn phím vẫn có ring) |
| Bóng | Card, nút, panel đều có bóng | Chỉ popover/dialog |
| RDP / preview ảnh | Gradient | Màu phẳng |
| Xác nhận | Level 3 cho prod **hoặc** hàng loạt | Level 3 **chỉ** prod |
| Density mặc định | (chưa chốt) | Comfortable |
| Tính năng | 15 màn | 50+ màn: Forwards, MultiExec, Editor, Group, Snippets, Files 2 khung, Transfers center, Docker Overview/Images/Volumes/Networks + Pull/Build, K8s Deployments/Helm + diff, S3 Sync, 12 mục Settings |

## 15. Thay đổi v0.2 → v0.3 (màu theo v0.1)

Phản hồi: màu “calm” v0.2 “không ổn lắm” → dùng lại **màu của v0.1**, tiêu chí **đơn giản & hiện đại**. Chỉ đổi màu; mọi thay đổi không phải màu của v0.2
(teal duy nhất, frameless, Comfortable mặc định, gõ tên chỉ cho prod, env theo nhóm, màn hình mới, không gradient/glow/bóng nặng, ít khung) giữ nguyên.

| Chỗ | v0.2 (calm) | v0.3 |
|---|---|---|
| Trạng thái tốt | Chữ xám + chấm 6px dịu (`--ok-dot`); host online không chấm | Chấm + chữ **xanh lá**; host online có chấm xanh lá; Info/Progress xanh dương |
| Chip | Chỉ danger/warning | success · info · warning · danger (nền nhạt + chữ màu, một hình dạng); chip ở header Inspector, bảng dùng chấm + chữ |
| Một chỉ báo/hàng | ≤1 chip màu/hàng | Giữ tinh thần: cột Health của Docker là chữ màu, không chip thứ hai; Helm “Failed” trong bảng là chấm + chữ |
| Logo OS / vendor | Đơn sắc, màu chữ phụ | Màu thương hiệu (theme sáng tông đậm hơn) |
| Logo app | Ô xám | Ô teal đặc (như v0.1) |
| Môi trường | Prod = chấm đỏ + chữ xám; STG/DEV/TEST chữ xám; header “PROD” chữ đỏ | Chip màu ở hàng nhóm: PROD đỏ · STG vàng · DEV xanh dương · TEST tím; header cùng màu; vạch PROD 2px giữ nguyên; host vẫn không lặp badge |
| Số đếm | Xám; đỏ chỉ cho số lỗi | Đỏ = lỗi, vàng = cảnh báo (restarts 1–5, tab Events khi có warning), xám = trung tính |
| Meter / biểu đồ | Một tông xám, vàng/đỏ khi vượt ngưỡng | Xanh dương (CPU) / tím (bộ nhớ sparkline), vàng/đỏ khi vượt ngưỡng; progress xanh dương; usage “reclaimable” vàng |
| Graph | Pod bar xám | Pod bar xanh lá (đỏ/vàng khi lỗi); rollout bar xanh lá, revision mới xanh dương |
| Toast / callout | Icon success/info xám | Success xanh lá, info xanh dương; callout info vẫn không khung (icon xanh dương) |
| Token | `--ok-dot`, `--env-other`, `--chart-1` xám | Bỏ `--ok-dot`/`--env-other`; thêm `--purple*`, `--env-staging/dev/test(-soft)`, `--chart-2`; dark `--danger` `#f5656a`, light success/warning/info đậm hơn cho AA |
| Design system trong app | `--ds-status-ok/progress` chỉ cho chấm, không có nền xanh | `--ds-success(-soft/-border)`, `--ds-info(-soft/-border)`, `--ds-purple`, `--ds-env-*`, `--ds-chart-2`; `StatusText`/`StatusChip`/`Badge`/`EnvLabel`/`Meter`/`Toast` theo cùng quy tắc |
