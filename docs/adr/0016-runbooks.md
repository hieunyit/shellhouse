# ADR-016: Runbook — chuỗi kiểm tra gắn với môi trường, chạy một cú nhấp

- Trạng thái: **Đang triển khai** — phạm vi đã chọn (2026-10-09): cả bốn loại bước (http, lệnh SSH, K8s, Docker)
- Ngày: 2026-10-09
- Liên quan: ADR-014 (khuôn module), ADR-015 (môi trường); `docs/plan-2026-10-roadmap.md` mục 4;
  `src/shared/snippets.ts` (snippet), `MultiExecView` (gõ vào nhiều terminal)

## 1. Bối cảnh

Sau mỗi lần deploy, người vận hành chạy cùng một chuỗi kiểm tra bằng tay: `curl /health`,
`systemctl status`, xem rollout của Deployment, xem container có `healthy` không. Hôm nay:

- **Snippet** chỉ dán lệnh vào terminal đang mở. Không có kết quả đạt / lỗi, không dừng khi bước
  trước hỏng, không gắn với môi trường, không chạy trên K8s / Docker.
- Chuỗi kiểm tra nằm trong đầu người hoặc trong wiki; chạy trên Production dễ nhầm host.

Mục tiêu: **một Runbook = danh sách bước có điều kiện đạt**, gắn với một đích (host / nhóm / môi trường /
cluster / endpoint Docker), chạy một cú nhấp, hiện kết quả từng bước. Là cầu nối giữa SSH, K8s và
Docker.

## 2. Mô hình đề xuất

```
Runbook { id, name, description, target, steps[], variables (như snippet), updatedAt }
target  = { kind: 'host' | 'group' | 'environment' | 'k8s-context' | 'docker-endpoint', id }
Step    = { id, name, type, params, continueOnFail?: boolean, timeoutSec }
```

Loại bước (giai đoạn):

| Loại               | Làm gì                                                                         | Đạt khi                                                       | Chỉ đọc?       | Giai đoạn |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------- | --------- |
| `http`             | GET một URL từ máy này                                                         | mã trạng thái nằm trong danh sách; (tuỳ chọn) thân chứa chuỗi | có             | 1         |
| `command`          | chạy lệnh qua kênh exec của SSH (không phải terminal)                          | mã thoát 0; (tuỳ chọn) đầu ra chứa chuỗi                      | **không biết** | 1         |
| `k8s.rollout`      | Deployment / StatefulSet / DaemonSet đã sẵn sàng (số bản sẵn sàng = mong muốn) | đủ bản trong thời gian chờ                                    | có             | 2         |
| `docker.container` | container đang chạy / `healthy`                                                | đúng trạng thái                                               | có             | 2         |

Chạy tuần tự; bước hỏng thì dừng (trừ `continueOnFail`). Kết quả mỗi bước: đạt / lỗi / bỏ qua, thời
gian, 20 dòng cuối của đầu ra (đã che giá trị giống bí mật). Giữ lịch sử vài lần chạy gần nhất.

## 3. An toàn

- **Môi trường Production** (`confirm: 'type'`): trước khi chạy phải gõ lại tên runbook — cùng quy ước
  với thao tác phá huỷ hiện có (gõ tay, không dán).
- **Môi trường chỉ đọc**: chặn bước `command` (Shellhouse không biết lệnh có ghi hay không); các bước
  `http`, `k8s.rollout`, `docker.container` vẫn chạy vì chỉ đọc.
- Bước `command` chạy qua kênh exec của kết nối SSH đã có (cùng quyền người dùng, cùng log kiểm
  toán); không đưa mật khẩu vào dòng lệnh; biến `{{x}}` bắt buộc nhập, không có mặc định ngầm (như
  snippet).
- Runbook không tự chạy theo lịch trong giai đoạn này (chỉ khi người dùng bấm).
- Đầu ra đã che bí mật trước khi lưu lịch sử; không lưu đầu ra đầy đủ.

## 4. Lưu trữ và đồng bộ

Bảng lõi `runbooks` (JSON `steps`), đồng bộ như snippet (đã có hạ tầng đồng bộ bản ghi). Lịch sử chạy
chỉ ở máy này. Giai đoạn 2: module khai báo `contributes.runbookSteps` để K8s / Docker đưa loại bước
của mình vào (khuôn module hiện chưa có điểm mở rộng này).

## 5. Giao diện

Nơi xem / sửa / chạy: một mục trong Explorer của khu vực Hosts (cạnh Snippets) hoặc khu vực riêng —
**cần chọn** (câu hỏi 2). Bảng kết quả theo từng bước, nút "Chạy lại bước lỗi", sao chép kết quả
dạng văn bản để dán vào ticket.

## 6. Phương án đã cân nhắc

- **Mở rộng snippet thành macro có kiểm tra**: ít việc nhất, nhưng gắn với terminal đang mở và không
  chạy được trên K8s / Docker; không có kết quả có cấu trúc. Loại.
- **Chạy script shell trên máy này**: linh hoạt nhưng mở cửa chạy lệnh tuỳ ý trên máy người dùng và
  bỏ qua kết nối / vault đã có. Loại.
- **Tích hợp công cụ ngoài (Ansible, CI)**: đã có ansible-import cho host; chạy playbook là bài toán
  khác. Để sau.

## 7. Câu hỏi cần chọn trước khi code

1. **Phạm vi giai đoạn 1**: chỉ `http` + `command` qua SSH (nhanh, dùng ngay), hay làm luôn K8s /
   Docker (cần thêm điểm mở rộng cho module)?
2. **Vị trí**: Explorer của Hosts (gần Snippets), hay khu vực riêng "Runbooks" trên activity bar?
3. **Môi trường chỉ đọc**: chặn mọi bước `command` (đề xuất), hay cho đánh dấu từng bước là "chỉ
   đọc" thủ công?
4. **Đích kiểu nhóm / môi trường**: chạy tuần tự trên từng host rồi gộp kết quả, hay chỉ cho một host
   mỗi lần ở giai đoạn đầu?

## 8. Quyết định (2026-10-09)

1. **Phạm vi**: cả bốn loại bước ngay giai đoạn đầu (người dùng chọn).
2. **Là một module** (`runbook`, ADR-014): có bảng riêng, phần Session Host (chạy lệnh SSH, gọi HTTP)
   và khu vực riêng trên activity bar — đây cũng là câu trả lời cho "đặt ở đâu".
3. **Module không import module khác** (ESLint, ADR-014) → bước K8s / Docker đi qua điểm mở rộng
   mới của registry: `RendererModule.runbookSteps`. K8s đăng ký `k8s.rollout`, Docker đăng ký
   `docker.container`; Runbook chỉ thấy các loại bước của module **đang bật**. Bước của module đã
   tắt báo "module chưa bật", không chạy ngầm.
4. **Đích nằm ở từng bước**, không ở runbook: một runbook "sau deploy" có thể gồm HTTP + lệnh trên
   host + rollout trên cluster + container trên endpoint. (Đảo lại mô hình ở mục 2.)
5. **Môi trường suy ra từ các đích thật của bước**, không phải nhãn người dùng tự gắn cho runbook:
   bất kỳ đích nào thuộc môi trường `confirm: 'type'` → phải gõ lại tên runbook; bước `command` nhắm
   vào đích thuộc môi trường chỉ đọc → bị chặn (các bước kiểm tra còn lại chỉ đọc nên vẫn chạy).
6. Chưa đồng bộ runbook giữa các máy (lưu cục bộ trong DB của module); lịch sử chạy chỉ ở máy này.

## 9. Đã làm (2026-10-09)

- Module `runbook`: bảng `runbook_runbooks`, Session Host (`exec` qua kênh SSH, `http` từ máy này —
  chỉ `http:` / `https:`, đọc tối đa 64 KB thân), khu vực riêng trên activity bar.
- Bốn loại bước; K8s / Docker qua `RendererModule.runbookSteps`. Loại bước có thể khai `prepare()`
  (K8s: nạp danh sách context) — runbook gọi trước khi tính chính sách, để môi trường Production
  của đích không bị bỏ sót chỉ vì store của module chưa nạp.
- Hộp thoại chạy: nhập biến, cảnh báo bước bị chặn, gõ lại tên (không cho dán) khi có đích
  Production. Bảng kết quả theo bước, "Chạy lại bước lỗi" (chỉ chạy lại bước lỗi / bị chặn / bị bỏ
  qua, giữ kết quả bước đã đạt), "Sao chép kết quả"; lịch sử 5 lần gần nhất trong localStorage.
- Đang chạy thì khoá sửa bước; đóng tab khi đang chạy / còn thay đổi chưa lưu thì hỏi; xoá runbook
  thì đóng tab của nó.
- Một lần chạy dùng chung phiên theo đích (`SessionPool` trong `renderer-session.ts`): các bước trên
  cùng host / cluster / engine chỉ kết nối và hỏi mật khẩu một lần; bước lỗi / hết giờ / bị dừng
  thì bỏ phiên đó (bước sau kết nối lại); hết lần chạy thì đóng hết.
- Che bí mật cả khoá JSON (`"password": "…"`, `"access_token": "…"`), giữ ngoặc của giá trị.
- Bước HTTP: GET / HEAD / POST, header; giá trị header bí mật nằm ở bảng `runbook_secrets` (mã hoá
  bằng vault, quyền `secrets`) — bước chỉ giữ `secretId`; main giải mã trong `resolveSession` thẳng
  sang Session Host. Proxy theo Settings › Network (`ctx.proxyFor`, theo địa chỉ ban đầu); tuỳ chọn
  bỏ kiểm chứng chỉ theo bước. Chuyển hướng tự xử lý (tối đa 5): sang origin khác thì bỏ header bí
  mật / `Authorization` / `Cookie`. Bí mật không runbook nào dùng (quá 1 ngày) được dọn khi bật module.
- Lịch sử xem lại được từng bước. Nhân bản; xuất / nhập file `shellhouse-runbooks` v1: không có
  `secretId`; host SSH kèm nhãn + địa chỉ để máy nhập ghép host (nhãn + địa chỉ → địa chỉ → nhãn);
  tên trùng thêm "(2)".
