# Hướng dẫn thiết kế giao diện Kubernetes (và các module)

Bổ sung cho [ADR-007](adr/0007-ui-design-system.md) (token, component chung, sáng/tối). Tài liệu
này chốt những quy tắc rút ra khi làm trang K8s — để màn hình mới không phải qua nhiều vòng
"rối mắt / đơn điệu quá" nữa. Docker và S3 dùng cùng quy tắc.

## 1. Nguyên tắc

1. **Trả lời một câu hỏi mỗi vùng.** Bảng: "có gì, cái nào hỏng". Bảng chi tiết: "nó đang thế
   nào, làm gì với nó". Bản đồ: "cái gì nối với cái gì". Thông tin không giúp trả lời câu hỏi của
   vùng đó → ẩn hoặc chuyển chỗ.
2. **Bình thường thì im lặng, bất thường thì nổi.** Điều kiện `Ready=True`, pod `Running`,
   restart = 0 không cần hiện. Chỉ hiện khi xấu (xem §3).
3. **Không lặp.** Một thông tin / thao tác chỉ có một chỗ chính. Ví dụ đã sửa: nút "View YAML"
   cạnh tab YAML, nút "Inspect" cạnh tab Inspect (Docker) → chỉ để trong menu `…` và phím tắt.
4. **Số liệu thật, đơn vị thật.** Hiện `250m`, `128Mi`, `2.0 MB/s` — đúng cách kubectl / Prometheus
   viết. Không đổi sang % nếu không có mốc (request / limit) để so.

## 2. Mật độ thông tin

| Vùng                 | Tối đa                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| Hàng trong bảng      | Tên + 4–6 cột; cột hẹp dần theo độ rộng (`@container`), tên luôn còn        |
| Header bảng chi tiết | Tên, một badge trạng thái, một dòng phụ (`Kind · namespace · tuổi`)         |
| Nút thao tác chính   | **3** (phần còn lại vào `…`); không nút nào trùng với một tab               |
| Tab                  | ≤ 7; tab mặc định là tab trả lời câu hỏi chính (ConfigMap/Secret → Data)    |
| Thẻ số liệu          | Một hàng, cùng cỡ; 3 thẻ → `grid-cols-3`, không để thẻ lẻ một mình một hàng |
| Nhãn trường (form)   | Một dòng — nhãn dài làm lệch hàng ô nhập ("Container name" → "Name")        |

Chữ: nội dung 12–13 px, phụ 11 px, chữ hoa nhỏ (heading mục) 11 px `tracking-wider`. Dưới 11 px
chỉ dùng trên bản đồ khi đã thu nhỏ. Tên tài nguyên dùng `font-mono`; tên dài thì `truncate` +
`title` đầy đủ — **không** thêm hậu tố như "(external)" vào chỗ đã chật, đưa nó vào `title` hoặc
dòng phụ.

## 3. Khi nào ẩn mặc định

Ẩn (gập / tắt sẵn, bấm mới hiện):

- Labels, annotations, owner → gập ở đầu tab Overview (`MetaHeader`), hiện số lượng.
- Điều kiện (conditions) đang tốt → chỉ hiện điều kiện xấu (`NEGATIVE_CONDITION`).
- Topology: lớp RBAC và Scheduling tắt sẵn; Ownership, Traffic, Config, Policies bật.
- Namespace hệ thống (`kube-*`, …) trên bản đồ; cluster ≥ 25 namespace → gập hết.
- Node: hàng rỗng (không taint, không label đặc biệt) không hiện.
- Traffic: đường < 1 B/s ghi "idle"; nút "Hide idle" trên service map.

Luôn hiện:

- Mọi trạng thái xấu: CrashLoopBackOff, Pending lâu, node NotReady, restart > 0, quota vượt.
- Lý do không có dữ liệu (thiếu quyền, chưa cài Caretta / Prometheus) — kèm cách khắc phục một dòng.

Không báo lỗi trên form trống: chưa nhập thì chỉ khoá nút chính; thông báo lỗi chỉ hiện khi người
dùng đã gõ (Docker Run: "Enter an image…" chỉ hiện khi ô Image có chữ mà sai).

## 4. Bảng màu trạng thái

Dùng token, không dùng màu Tailwind trực tiếp (`text-red-500`).

| Tone    | Ý nghĩa                                  | Chấm / nền        | Chữ            |
| ------- | ---------------------------------------- | ----------------- | -------------- |
| `ok`    | Running, Ready, Bound, Healthy           | `bg-success`      | `text-success` |
| `warn`  | Pending, Degraded, restart 1–5, sắp đầy  | `bg-warning`      | `text-warning` |
| `bad`   | Failed, CrashLoopBackOff, NotReady       | `bg-danger-solid` | `text-danger`  |
| `info`  | Đang chọn, liên kết, đang tiến hành      | `bg-accent`       | `text-accent`  |
| `muted` | Completed, Succeeded, tạm dừng, không rõ | `bg-line-strong`  | `text-faint`   |

- Running là bình thường → trong danh sách gọn (pod grid) **không** ghi chữ "Running", chỉ chấm
  xanh; trạng thái khác mới ghi chữ.
- Restart: > 0 `warning`, > 5 `danger`.
- Badge (`Pill`): nền `*-soft` + chữ cùng tone, một chấm đầu. Không viền.
- Băng thông traffic dùng thang **tuyệt đối** `--map-t0 … --map-t4` (xanh ngọc → đỏ), giống nhau
  giữa các cluster; độ dày đường theo `BANDS`.
- Bản đồ có token riêng `--map-*` trên `.k8s-map` / `.k8s-map-dark` (nền tối riêng tuỳ chọn).

## 5. Mẫu bố cục

**Trang danh sách:** thanh công cụ một hàng (lọc, nút chính bên phải) → bảng → thanh phím tắt ở
chân. Bảng chi tiết mở bên phải, bảng chính co lại (ẩn cột ít quan trọng trước).

**Bảng chi tiết:** header (§2) → ≤ 3 nút chính + `…` → tab. Trong tab: mục có heading chữ hoa
nhỏ + số đếm; mục rỗng ghi "None" một dòng, hoặc gộp ("No ingresses, persistent volume claims.").

**Biểu đồ (`Usage`, `TimeChart`):** luôn có trục thời gian (mốc trái, "now" phải) và giá trị
hiện tại góc phải; đường request / limit gạch ngang có nhãn. Dữ liệu một điểm → không vẽ đường
phẳng giả, ghi "Collecting samples…". Có Prometheus → chọn 15m / 1h / 6h / 24h; không có → mẫu sống.

**Hộp thoại:** tiêu đề + một câu mô tả; trường bắt buộc có `*`; gợi ý dưới ô (11 px, `text-faint`);
nút chính góc phải dưới, Cancel bên trái nó.

**Bản đồ:** chi tiết theo mức zoom (far: chỉ namespace, tên đầy đủ; mid/near: thẻ workload, đường
nối thẻ → thẻ, kể cả khác namespace); chọn một mục → làm mờ phần không liên quan, không ẩn.

## 6. Trạng thái rỗng / đang tải / lỗi

- Đang tải lần đầu: skeleton hoặc "Loading…" chữ `text-faint` — không spinner giữa màn hình trống.
- Rỗng: một câu nói vì sao + một nút làm gì tiếp ("No deployments in shop. **Create**").
- Lỗi: `Notice tone="danger"` với lỗi đã `cleanError` (bỏ stack, bỏ tiền tố kỹ thuật).
- Thiếu quyền: nói quyền nào (`get pods/proxy in caretta`), không chỉ "Forbidden".

## 7. Thời gian, số

- Tuổi tài nguyên kiểu kubectl (`60m`, `3d`) trong bảng; `ago()` ("5 min ago") ở chỗ khác.
  Quá 45 ngày → tháng / năm, không "2,210 days ago".
- `tabular-nums` cho mọi cột số. Số lớn có dấu phẩy ngăn nghìn (`toLocaleString('en')`).

## 8. Kiểm tra trước khi merge

1. `pnpm build && pnpm screens` → xem `screens/{light,dark}-m-*.png` (module) và
   `screens/{light,dark}-*.png` (lõi). Cả sáng và tối.
2. Màn hình mới có trùng thông tin / nút với tab nào không? Thẻ lẻ một hàng? Nhãn xuống dòng?
3. Trạng thái tốt có đang "kêu" không cần thiết? Trạng thái xấu có nổi đủ không?
4. Ô nhập / select nhận `className` (`w-28`, `h-7`, `text-xs`) — `Input` / `Select` / `TextArea`
   tự bỏ class gốc cùng nhóm (`controlCx`), không cần `!important`.
