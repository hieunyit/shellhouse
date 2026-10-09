# Kế hoạch: an toàn production, quét bảo mật, Docker TLS, runbook (2026-10)

Nguồn: bản đề xuất ưu tiên 1–4 của người dùng. Kế hoạch này đã đối chiếu với code hiện tại — phần
nào đã có thì ghi rõ, không làm lại.

## 0. Hiện trạng (đã kiểm trong code, tháng 10/2026)

Môi trường (`src/shared/environments.ts`) có mức xác nhận `type | confirm | undo`; Production dựng
sẵn dùng `type` (gõ lại tên). Cờ `production` = `env.confirm === 'type'`.

| Thao tác trên Production                                                                                                                                        | Hiện tại                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| K8s: delete (mọi loại, kể cả namespace / node), scale (kể cả về 0), drain, restart, cordon, Helm rollback / uninstall, Argo sync + prune, sửa bằng editor ngoài | Gõ lại tên đối tượng ✅               |
| K8s: thao tác hàng loạt                                                                                                                                         | Gõ lại tên context ✅                 |
| S3: xoá                                                                                                                                                         | Gõ lại tên ✅                         |
| Docker: stop / kill / remove (`rm -f`) một container, xoá image / volume / network, Compose down                                                                | Gõ lại tên ✅                         |
| **Docker: thao tác hàng loạt (nhiều container / image / volume / network)**                                                                                     | Chỉ bấm nút ❌                        |
| **Docker: prune (image, volume, network, container, build cache)**                                                                                              | Chỉ bấm nút ❌                        |
| **K8s: lưu YAML sửa (replace) và Apply**                                                                                                                        | Chỉ qua màn xem diff, không gõ tên ❌ |

Kết luận: Ưu tiên 1 không phải làm từ đầu — chỉ còn ba lỗ hổng trên. Đóng ba lỗ này, có test, là xong.

Không làm trong đợt này: ép buộc ở Session Host (phía renderer vẫn là lớp bảo vệ duy nhất cho
"gõ tên"). Chế độ chỉ đọc đã được Session Host kiểm riêng (không tin cờ renderer) — giữ nguyên.

## 1. Ưu tiên 1 — đóng ba lỗ hổng xác nhận (làm trước) — XONG (3fbc448)

Quy tắc chung: chỉ khi môi trường của đích có `confirm === 'type'` và thao tác nguy hiểm. Chuỗi phải
gõ:

- Một đối tượng → tên đối tượng (như hiện nay).
- Nhiều đối tượng → cụm đếm, đúng như hộp xác nhận một-lần của Docker đang dùng: `3 containers`,
  `2 volumes`.
- Prune → cụm đếm theo bản xem trước (`12 images`).
- K8s lưu YAML: sửa một đối tượng → tên đối tượng; Apply (tạo / nhiều tài liệu) → tên context.

Việc làm:

1. `docker/renderer/Bulk.tsx`: `BulkDialog` nhận `typeName?`; khi có, hiện ô gõ, nút chạy bị khoá tới
   khi khớp. `DockerView` truyền khi `env.confirm === 'type' && plan.danger`.
2. `docker/renderer/dialogs.tsx` `PruneDialog`: tương tự với cụm đếm từ `preview`.
3. `k8s/renderer/YamlEditor.tsx`: trước khi gửi `replace` / `apply`, `guard()` với tên phù hợp (dùng
   `useClusterGuard`, giống các thao tác khác). Chỉ hỏi sau khi người dùng đã xem diff.
4. Test: unit cho hàm chọn chuỗi cần gõ; e2e Docker (bulk + prune trên endpoint Production) và K8s
   (lưu YAML trên context Production); kiểm nút bị khoá khi gõ sai và không gọi API.
5. i18n + CHANGELOG.

Tiêu chí xong: trên Production không còn đường nào xoá / ghi hàng loạt chỉ bằng một cú bấm; e2e xanh
trên cả ba hệ điều hành.

## 2. Ưu tiên 2a — quét bằng Trivy (không tự viết engine quét) — XONG

Nguyên tắc: gọi `trivy` nếu máy có; hiển thị kết quả. Không tải, không cài, không tự cập nhật CSDL
ngoài những gì Trivy tự làm.

- Quyền: thêm `trivy` vào `ModuleBinary` + `run-program` trong manifest Docker và K8s → lần đầu có
  hộp thoại xin phép như `docker` / `aws`.
- Docker, quét image: op `image.scan { ref }` → `trivy image --quiet --format json --scanners vuln
<ref>` chạy trên máy này (endpoint local / WSL). Endpoint SSH: chạy qua `ssh-exec` nếu server có
  `trivy`, không thì báo rõ "server chưa cài Trivy" — không kéo image về máy này.
- K8s, misconfig: lấy YAML của workload đang xem → ghi file tạm → `trivy config --format json`
  → xoá file tạm. Không đưa kubeconfig / token cho Trivy; không dùng `trivy k8s`.
- Giao diện: nút "Scan" ở chi tiết image (Docker) và chi tiết workload (K8s). Bảng kết quả: mức độ
  (CRITICAL…LOW), gói / luật, phiên bản, bản sửa, lọc "có bản sửa", chọn / copy (xem commit chọn văn
  bản), xuất CSV. Tóm tắt số theo mức độ ở đầu.
- An toàn: giới hạn thời gian (10 phút) + dung lượng JSON; huỷ được; lỗi Trivy hiện nguyên văn;
  không gửi gì ra ngoài ngoài những gì Trivy tự tải (CSDL lỗ hổng) — nói rõ trong hộp xin quyền.
- Test: parser JSON Trivy bằng fixture; tích hợp bằng trivy giả (script in JSON) qua `LimitedSpawn`;
  e2e hiển thị kết quả.

## 3. Ưu tiên 2b — Docker qua TCP + TLS — XONG (chỉ Engine API; không Compose / build / shell)

- Mô hình: endpoint mới `kind = 'tcp'` (host, port, có TLS, CA, chứng chỉ + khoá client). Hiện
  `docker_endpoints` chỉ có local / `host_id` SSH → migration `0004_tcp.sql`.
- Chứng chỉ: CA, cert, key lưu trong vault qua `ModuleSecrets.seal` (như mật khẩu registry); renderer
  chỉ thấy tên và dấu vân tay; giải mã ở main rồi chuyển thẳng sang Session Host.
- Kết nối: `tls.connect` với cert client, kiểm tra CA / tên máy (không có tuỳ chọn tắt kiểm tra
  mặc định; nếu có thì ghi chú đỏ). Quyền `network` trong manifest.
- Giao diện: "Add endpoint → Remote (TCP + TLS)" nhập host:port và chọn file chứng chỉ (hộp chọn file);
  kiểm tra kết nối trước khi lưu; hiện hết hạn chứng chỉ.
- Đồng bộ: `docker_endpoint` sync record — chỉ đồng bộ phần không bí mật; chứng chỉ theo cơ chế vault
  hiện có.
- Test: engine giả với TLS + mTLS (cert tự sinh trong test), từ chối khi sai CA / thiếu cert client.

## 4. Ưu tiên 3 (sau 1 và 2)

- Buildx / đa nền tảng (XONG): mở rộng `BuildSpec` (`platforms[]`, builder, push / load) — chỉ khi `docker
buildx` có trên máy; hiện tiến trình từng nền tảng.
- Runbook gắn môi trường (ĐANG CHỜ CHỌN PHẠM VI — xem `docs/adr/0016-runbooks.md`): chuỗi lệnh kiểm tra theo host / cluster / endpoint; chạy một cú nhấp; kết quả
  theo bước. Cần thiết kế riêng (lưu ở đâu, chạy lệnh nào ở K8s / Docker, xác nhận khi chạy trên
  Production) — viết ADR trước khi code.

## 5. Ưu tiên 4 — chưa làm

AI giải thích lỗi: để sau. Điều kiện bắt buộc khi làm: tắt mặc định, nói rõ dữ liệu nào được gửi, có
bước che bí mật, hỗ trợ mô hình cục bộ.

## 6. Thứ tự và rủi ro

1 → 2a → 2b → 3. Mỗi mục: một nhánh commit riêng, CI xanh trước mục tiếp theo, CHANGELOG theo mục.

Rủi ro: (a) Trivy tải CSDL lần đầu chậm / cần mạng — hiển thị tiến trình và lỗi rõ; (b) TLS: lưu khoá
client là dữ liệu nhạy cảm — chỉ vault, không log, không đồng bộ rõ; (c) quét image trên server SSH
phụ thuộc server có Trivy — chấp nhận, báo rõ.
