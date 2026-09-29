# ADR-010: Kế thừa theo nhóm, màu môi trường, mở hàng loạt và thao tác trên sidebar

- Trạng thái: Chấp nhận
- Ngày: 2026-09-29

## Quyết định

### 1. Giá trị mặc định của nhóm, host kế thừa

- Migration 0004: `groups.defaults` (JSON, có schema zod `GroupDefaults`) gồm `username`, `port`,
  `keyId`, `jumpHostIds`, `color`.
- Mỗi trường được lấy từ **nhóm gần nhất** (tính từ host đi lên gốc) có đặt trường đó, nên nhóm
  con chỉ cần ghi đè phần khác. Logic dùng chung ở `src/shared/inherit.ts` cho main (lúc kết nối)
  và renderer (form hiển thị lấy từ nhóm nào; sidebar hiện địa chỉ thực tế).
- Host "để trống" nghĩa là kế thừa:
  - username `''`;
  - port `null` (DB giữ cột `port` làm giá trị giữ chỗ, cờ `options.inheritPort`);
  - jump host rỗng và không có ProxyJump riêng. Có tuỳ chọn `direct` ("Connect directly") để bỏ
    qua jump của nhóm.
- Key của nhóm chỉ được **thử thêm** khi host dùng xác thực _Automatic_. Host đã chọn Password hay
  một key cụ thể thì giữ nguyên lựa chọn đó.
- Jump host kế thừa bỏ qua chính host đang kết nối, các host đang nằm trên đường đi, và host đã bị
  xoá. Nhờ vậy bastion nằm trong chính nhóm có `jump = bastion` sẽ kết nối thẳng, không báo lỗi
  vòng lặp.
- Không ai đặt username thì báo lỗi rõ ràng lúc kết nối. Form host chặn lưu khi username trống mà
  nhóm cũng không có.
- Lưu nhóm: kiểm tra key và jump host trong `defaults` còn tồn tại.

### 2. Màu môi trường

- `defaults.color` của nhóm là màu môi trường; host có màu riêng thì màu riêng thắng.
- Hiển thị ở ba chỗ:
  - Vạch màu trên tab.
  - Viền trên thanh phiên, kèm badge đường dẫn nhóm (ví dụ `Production / Web`).
  - Icon thư mục nhóm trong sidebar.
- Form hiển thị "Using red from Production" khi đang kế thừa màu.

### 3. Mở cả nhóm và MultiExec (gõ đồng loạt)

- Menu nhóm và menu khi chọn nhiều host có ba lựa chọn: mở thành tab, mở thành lưới chia màn hình,
  và **Open in MultiExec**. Mở hơn 8 phiên một lúc thì hỏi xác nhận.
- **MultiExec** (giống MobaXterm; nút trên thanh công cụ, `Ctrl+Shift+M` / `Cmd+Shift+M`):
  - **Mọi** terminal đang mở được xếp đều thành lưới gần vuông trên một màn hình, là một lớp phủ
    lên vùng làm việc.
  - Mỗi ô có công tắc **Send input**. Gõ (và dán) ở một ô đang bật thì được gửi tới mọi ô đang
    bật; gõ ở ô đang tắt thì chỉ vào ô đó.
  - Thanh trên cùng: "Typing goes to N of M terminals", Select all, None, Exit MultiExec. Nút ⤢
    trên từng ô: thoát và mở tab đó.
- Terminal **không được tạo lại**: `TerminalController.mountIn()` chuyển phần tử DOM của xterm vào
  ô lưới và trả về tab khi thoát. Phiên, scrollback và kết nối giữ nguyên; bố cục tab/chia màn
  hình không bị đụng tới. Không dùng cách dựng lại bố cục của dockview, vì panel sẽ bị mount lại
  và phiên bị mất.
- Prompt (host key, mật khẩu) hiện **ngay trong ô lưới**. Trạng thái prompt nằm trong
  `useTabStatus.prompts`, và TerminalView không vẽ bản thứ hai khi đang ở MultiExec.
- Hook test `sendInput` không đi qua broadcast.

### 4. Menu chuột phải

- `ContextMenu` tự vẽ theo theme, điều hướng được bằng bàn phím (mũi tên, Enter, Esc), không tràn
  ra ngoài cửa sổ.
- Menu host: Connect, Connect in split, Open SFTP (mở tab kèm panel SFTP), Favorites, Copy SSH
  command, Duplicate, Edit, Move to…, Tags…, Delete.
- Menu nhóm: mở tất cả (ba kiểu), New host here, New subgroup, Edit group and defaults, mở/thu mọi
  thứ bên trong, Delete group.
- Copy SSH command (`shared/ssh-command.ts`) dựng lệnh từ giá trị đã kế thừa: `-J` cho jump,
  `-p`, `-i`. Mọi giá trị đều được bọc nháy nên không chèn được lệnh.
- Duplicate sao chép cả mật khẩu và forward. Secret được giải mã rồi **mã hoá lại** cho identity
  mới, vì AD của secret gắn với id.

### 5. Chọn nhiều

- Ctrl/Cmd+click để bật/tắt từng host, Shift+click để chọn dải theo thứ tự đang hiển thị, Ctrl+A,
  Esc, Delete.
- Chuột phải lên host chưa chọn thì chỉ chọn host đó (như trình quản lý file).
- Thanh thao tác ở chân sidebar: Open, Move, Tags, Delete. Kéo một host trong vùng chọn thì kéo cả
  vùng chọn.
- IPC hàng loạt, mỗi thao tác chạy trong một transaction: `hosts:moveMany`, `hosts:deleteMany`,
  `hosts:setFavorite`, `hosts:tag` (thêm/bỏ, không phân biệt hoa thường, tối đa 20 tag/host).

### 6. Favorites, Recent, sắp xếp thủ công

- `hosts.favorite`; mục Favorites ở đầu sidebar. Thả host lên tiêu đề Favorites để đánh dấu.
- Recent: 5 host dùng gần nhất (`last_used_at`).
- Các hàng này dùng testid riêng (`favorite-row`, `recent-row`) để không trùng với hàng trong cây.
- `hosts.sort`: kéo host lên nửa trên/dưới của host khác để xếp trước/sau. Kéo nhóm lên 25%
  trên/dưới của nhóm khác để xếp trước/sau, vào giữa để đưa vào trong.
- `sort = 0` nghĩa là chưa sắp, xếp theo tên. Host mới trong nhóm đã sắp thủ công được thêm vào
  cuối.
- Giữ chuột 0,7 giây trên nhóm đang thu gọn khi kéo thì nhóm tự mở ra.

## Lỗi tìm thấy trong phase này

- **`lazy.tsx`** (từ đợt tinh chỉnh giao diện): wrapper có thể đổi giữa `<Loaded>` và
  `<Suspense><Lazy>` khi chunk vừa nạp xong lúc dialog đang mở. React khi đó mount lại dialog, nên
  **mất dữ liệu đang nhập**; E2E hỏng ngẫu nhiên ở nhiều chỗ. Sửa: chốt cách render một lần lúc
  mount.
- `InheritedDefaults` từng dùng mapped type `-?`, vốn xoá luôn `| undefined`, làm TypeScript tin
  rằng giá trị kế thừa luôn tồn tại. Lint `no-unnecessary-condition` đã bắt được.
- Selector zustand trả về mảng mới mỗi lần (`hosts.flatMap(...)`) gây vòng render vô hạn, làm hộp
  thoại Tags sập.
- Mục Favorites trống từng hiện ra ngay khi bắt đầu kéo, đẩy cả danh sách xuống giữa lúc kéo và
  làm thả nhầm chỗ. Đã bỏ.
- Thanh phiên vỡ dòng khi ô hẹp (lưới). Dùng container query để thu về chỉ còn icon, vẫn giữ
  `aria-label`.
- Test `settings.spec` có race: `count()` không chờ trạng thái keychain tải xong.
