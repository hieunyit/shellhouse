# ADR-016: Runbook — chuỗi kiểm tra gắn với môi trường, chạy một cú nhấp

- Trạng thái: **Đề xuất — chờ chọn phạm vi** (chưa code)
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
