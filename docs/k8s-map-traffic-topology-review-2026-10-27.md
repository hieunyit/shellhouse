# Map, Traffic và Topology — 2026-10-27

Phạm vi: working tree sau bản sửa 5 lỗi K8s trong
[review trước](k8s-review-2026-10-27.md). Các mục dưới đây ghi nhận hành vi tại thời điểm audit. **Các vấn đề 1–6 đã được sửa trong working tree**; hướng dẫn hai tính năng mới và giới hạn hiện tại nằm ở [Map tools](k8s-map-tools.md).

## Đánh giá sử dụng thực tế

| Phần                       | Điểm hữu ích hiện có                                                                                                                                                          | Điều kiện/giới hạn                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Map / application topology | Nhìn đường Entry → Service → Workload → Pods → config/storage; gom namespace, lọc label, mở chi tiết/log/shell/forward; chỉ ra selector, targetPort, TLS, PDB, trạng thái pod | Hữu ích cho chẩn đoán cấu hình. Là snapshot cấu hình/trạng thái, cập nhật khoảng 20 giây khi tab hiện; một cạnh không chứng minh request thực sự đi qua hoặc kết nối thông suốt. Cần sửa trạng thái dữ liệu thiếu quyền. |
| Object Topology            | Lần theo owner, rollout generations, node, Service, ConfigMap/Secret/PVC, policy và RBAC; mở rộng quanh đối tượng; tóm tắt, không trả nội dung Secret                         | Hữu ích khi điều tra một workload cụ thể. Tải lại theo đối tượng/nút Refresh, chưa tự cập nhật đồ thị theo mọi sự kiện watch. Có nhánh đọc owner xử lý lỗi quyền chưa đúng.                                              |
| Traffic                    | Đồ thị ai gọi ai, nguồn vào/ra, external, scope namespace, nhóm/mở rộng, nguồn và đơn vị riêng cho Caretta/Hubble; dùng chung mẫu giữa các màn                                | Có collector mới có dữ liệu; không phải mọi nguồn đều đo byte hoặc kết nối chính xác. Các vấn đề về stream và coverage dưới đây khiến chưa nên dựa hoàn toàn vào màu live/zero để kết luận mạng bình thường.             |

Bố cục theo namespace và các làn có hướng khá dễ đọc; focus vào workload rồi mở chi tiết
có giá trị hơn việc cố vẽ toàn cluster cùng lúc. Ảnh hiện có trong `docs/images/` cũng
cho thấy tên dài/label có thể bị cắt ở các thẻ nhỏ, và đồ thị Traffic ít node dùng nhiều
khoảng trống. Đây là các điểm có thể tinh chỉnh sau độ chính xác dữ liệu.

## Kiểm chứng

- Tám file test liên quan Map/Topology/Traffic/Hubble/Connections/history: **65/65 đạt**.
- Thêm bảy kịch bản audit tạm, **7/7 đạt** các assertion tái hiện vấn đề: API HTTPS giả,
  gRPC thật chạy trên HTTP/2 cục bộ, flow protobuf tổng hợp theo schema Cilium.
- Năm lỗi và một giới hạn phân bổ số liệu dưới đây được xác nhận từ các kịch bản này.
- Không chạy Cilium/Caretta thật, không đo sai số trên cluster multi-node hoặc benchmark
  lớn trong lượt này. Bài test đạt không đồng nghĩa collector đã được chứng nhận trên
  hạ tầng production.

## 1. [P2] Map mất trạng thái thiếu quyền và báo lỗi cấu hình giả

[map.ts:104](../src/modules/k8s/session-host/map.ts#L104) có thu cờ `denied`, nhưng
[mapData return](../src/modules/k8s/session-host/map.ts#L792) không truyền trạng thái
của Services, Pods, workloads, Nodes, PVC, routes... tới đồ thị. Một số loại phụ như
Secret/ConfigMap đã có xử lý unknown; chưa áp dụng đồng đều.

Tái hiện với fixture có Service và PVC thật:

- List Services trả 403 → `services: []`; Map dựng node đỏ “This Service does not
  exist”, Ingress báo “Backend Service web does not exist — these requests fail”.
- List PVC trả 403 → workload `media` báo “PersistentVolumeClaim uploads not found”.
- List Nodes trả 403 → `{total: 0, ready: 0}`, không có cờ phân biệt thiếu quyền.

Tài khoản hạn chế RBAC vì vậy có thể nhận hướng dẫn tạo/sửa tài nguyên vốn vẫn tồn tại.
Cần truyền completeness/denied/error theo loại và namespace, chỉ kết luận missing khi
đã đọc được đầy đủ hoặc GET nhận 404. Truncation cũng phải áp dụng cho mọi loại liên quan.

## 2. [P2] Object Topology nhầm lỗi đọc owner với owner không tồn tại

[Builder.get](../src/modules/k8s/session-host/topology.ts#L293) bắt mọi lỗi rồi trả null;
[wireOwners](../src/modules/k8s/session-host/topology.ts#L995) dùng null để dựng node missing.

Tái hiện: Pod `web-1` có ReplicaSet `web-rs2`; chỉ chặn GET ReplicaSet bằng 403.
Topology trả parent `summary: Not found`, `tone: bad`, `missing: true`, `notes: []`.

Nhánh dependency đã có `lookup/ref` phân biệt unknown/missing. Cần dùng cơ chế đó
cho owner và các nhánh đang gọi `get`, đồng thời không tiếp tục suy luận từ dữ liệu lỗi.

## 3. [P2] Số liệu Hubble không tương đương số kết nối mới

[flowLink](../src/modules/k8s/session-host/hubble.ts#L173) nhận mọi UDP flow chiều đi
và TCP SYN không ACK; [onResponse](../src/modules/k8s/session-host/hubble.ts#L322)
tăng counter một đơn vị mỗi flow rồi gắn `unit: connections`.

Tái hiện protobuf tổng hợp:

- Năm UDP datagram cùng nguồn/đích/source port/destination port → counter tăng 5,
  dù không có cơ chế xác định năm phiên mới.
- Cùng SYN được gửi dưới hai observation point FROM_ENDPOINT/TO_ENDPOINT → tăng 2.
  Code không dùng observation point để chọn một phía, không khử trùng/retransmission.

Nhánh Prometheus dùng `hubble_tcp_flags_total{flag="SYN"}`; metric này theo
[tài liệu Cilium](https://docs.cilium.io/en/stable/observability/metrics/#tcp) là số
lần xuất hiện cờ TCP. Không nên xem nó là số kết nối được thiết lập thành công hay
đồng nhất hoàn toàn với live flow có UDP. Schema flow có hướng và observation point:
[flow.proto](https://github.com/cilium/cilium/blob/main/api/v1/flow/flow.proto).

Cần định nghĩa riêng flow/packet/SYN/connection, chọn quy tắc quan sát rõ ràng, và
hiển thị giới hạn phép đo. Không chỉ đổi nhãn byte sang connections là đủ.

## 4. [P2] GetFlows kết thúc nhưng Traffic vẫn báo Hubble hoạt động

[HubbleCollector.open](../src/modules/k8s/session-host/hubble.ts#L275) xử lý error và
trailer lỗi, nhưng không xử lý stream end/close bình thường để hủy session/tái kết nối.
`touch()` gặp HTTP/2 session vẫn còn thì trả ngay.

Tái hiện bằng HTTP/2 cục bộ: kết thúc riêng GetFlows stream, giữ session. Số stream
ở server là **0**; yêu cầu traffic kế tiếp vẫn trả **`status: ok, source: hubble`**,
không mở lại stream. Counter đứng yên sau đó có thể bị hiểu là không còn traffic.

Cần theo dõi riêng vòng đời stream, reconnect/backoff và phân biệt thời điểm poll
với thời điểm quan sát dữ liệu/collector health.

## 5. [P2] Hubble bỏ qua tín hiệu dữ liệu bị mất

`onResponse` chỉ đọc field `flow = 1`. Các thông báo `node_status = 2` và
`lost_events = 3` của
[GetFlowsResponse](https://github.com/cilium/cilium/blob/main/api/v1/observer/observer.proto)
không được xử lý.

Tái hiện: gửi thông báo `lost_events.num_events_lost = 100` qua gRPC. Mẫu sau vẫn
`status: ok`, không reason/partial/lost count. Trên cluster quá tải, dữ liệu thiếu
có thể vẫn được trình bày như quan sát đầy đủ.

Caretta cũng chỉ yêu cầu ít nhất một agent trả lời để báo ok, đọc tối đa 300 agent,
chưa cung cấp số agent mong đợi/không đọc được. Đây là giới hạn coverage đọc từ code;
chưa benchmark sai số thực trên cluster nhiều node trong lượt này.

## 6. Giới hạn độ chính xác: gán traffic Service cho workload bằng cách chia đều

[resolveServices](../src/modules/k8s/session-host/traffic.ts#L220) tìm workload khớp
selector Service rồi chia byte cho số workload nguồn/đích. Kết quả chưa mang cờ estimated.

Tái hiện: hai Deployment `web` và `web-canary` cùng nằm sau một Service. Dù collector
chỉ cung cấp tổng của Service, kết quả gán byte bằng nhau cho hai workload (50/50).

Đây là quy tắc ước lượng, không phải phép đo backend thực tế; không dùng nó để xác
nhận phân phối canary 99/1. Nên giữ node Service khi thiếu dữ liệu hoặc đánh dấu
estimated và nêu rõ cách phân bổ.

## Ưu tiên cải thiện

1. Sửa unknown/denied/partial và các kết luận missing giả ở Map/Object Topology.
2. Sửa reconnect GetFlows, hiển thị lost events/coverage; cảnh báo dữ liệu thiếu và
   thời điểm collector có thể không còn hoạt động.
3. Chuẩn hóa phép đo Hubble và tách measured/estimated cho traffic gán qua Service.
4. Sau đó tinh chỉnh UX: khi chọn một cạnh thấy được loại quan hệ, nguồn bằng chứng,
   namespace/port, khoảng đo, độ đầy đủ và hướng đi tiếp để kiểm tra. Giữ focus/collapse
   và lọc hiện có, tránh làm đồ thị nhiều thông tin mặc định hơn.

Code audit/log tạm nằm trong `/tmp/shellhouse-map-traffic-review*`; không được đưa vào
bộ test chính như regression đã sửa vì chúng đang xác nhận hành vi lỗi hiện tại.

## Sau khi sửa

- Map trả coverage theo loại/namespace; chỉ danh sách đầy đủ mới chứng minh được tài nguyên
  không tồn tại. Snapshot cũng dùng coverage khi xác định thêm/xóa.
- Object Topology giữ lỗi quyền/lỗi đọc ở trạng thái unknown cho owner và các tham chiếu
  Node, PV, Gateway, ServiceAccount/RBAC.
- GetFlows xử lý end/close và reconnect có backoff, chặn callback/async open của phiên đã dispose.
- Traffic live Hubble dùng `obs/s` (TCP SYN và UDP); lịch sử Prometheus dùng `SYN/s`. UUID
  phát lại được khử trùng trong bộ nhớ có giới hạn. Không suy ra số kết nối TCP thành công.
- Lost events, node status và Caretta coverage được truyền tới giao diện; số đo dương vẫn
  hiện, thiếu bằng chứng không trở thành “not seen” hoặc “idle”.
- Caretta giữ node Service và tổng byte thực đo, bỏ phép chia 50/50 theo selector.
- Các regression chính thức ở `map-review-regressions.test.ts`, `mapDiagnostics.test.ts`,
  `connections.test.ts`, `k8s-map-tools.test.tsx`; có thêm kịch bản Electron lưu/so sánh/chẩn đoán.

Chưa chạy Cilium/Caretta thật trong lượt sửa này; kiểm thử collector dùng gRPC/HTTP2 thật
trên API server giả. Giới hạn quan sát nhiều điểm của Hubble được nêu rõ trên giao diện.

## Rà soát trước beta.36

Đã bổ sung test tái hiện và sửa các trường hợp còn lại:

- Snapshot không được sắp xếp mọi mảng: thứ tự image/rule có thể có ý nghĩa.
- Lỗi poll traffic bỏ baseline cũ, cần hai mẫu mới trước khi báo live.
- Rollout dùng nhãn và cổng của Pod thực tế; init container không restart không cung cấp cổng phục vụ.
- Gateway API giữ namespace/weight của backend; không nối sang Service trùng tên tại namespace route.
- Giới hạn dung lượng snapshot tính trên byte UTF-8.

Ngoài phần K8s, rà lại CI bản trước xác nhận ConPTY xóa viewport khi mở shell mới và modifier
chọn chữ macOS phải là Option. Bản sửa giữ viewport cũ vào scrollback trước khi ConPTY khởi tạo,
và bật Option-drag cùng hướng dẫn phù hợp trên macOS.
