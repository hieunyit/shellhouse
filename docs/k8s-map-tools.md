# Chẩn đoán và so sánh topology

Trong Kubernetes → Map, thanh công cụ có nút **Diagnose request path** (biểu tượng đường đi)
và **Topology snapshots** (biểu tượng máy ảnh). Dùng được khi không có collector traffic.

## Chẩn đoán đường đi request

Chọn URL, Ingress hoặc Service. Với URL, nhập địa chỉ HTTP/HTTPS đầy đủ rồi bấm **Run diagnosis**.
Mỗi lần chạy đọc lại dữ liệu trong các namespace đang chọn; không dùng dữ liệu cũ của canvas.

Kết quả lần theo Ingress host/path, class, TLS Secret/hạn chứng chỉ, backend Service/cổng,
selector của Pod thực tế, EndpointSlice, readiness và targetPort. Các tài nguyên có bằng chứng
được liên kết để mở chi tiết. Prefix khớp theo đoạn đường dẫn; Exact và wildcard host được xét
riêng. Nhiều luật cùng độ ưu tiên hoặc ImplementationSpecific được báo chưa xác định.

- Thiếu quyền, giới hạn list, dữ liệu cũ không đủ trường hoặc namespace ngoài phạm vi → unknown.
- Named targetPort thiếu trên Pod là vấn đề cấu hình. Numeric targetPort chưa khai báo không
  chứng minh tiến trình không lắng nghe cổng đó.
- URL dùng Gateway API chưa được tự lần theo; kết quả không thấy Ingress sẽ yêu cầu kiểm tra
  route Gateway API/namespace khác. Chọn Ingress để xem tất cả backend trong phạm vi tài nguyên đó.
- Đây là kiểm tra cấu hình và trạng thái API báo cáo, không gửi request tới ứng dụng. Không
  xác nhận DNS, hiệu lực CNI/NetworkPolicy, ingress controller, chuỗi chứng chỉ hoặc bắt tay TLS.
- Các loại tài nguyên được list song song, không phải một transaction xuyên toàn cluster.

## Snapshot trước/sau deploy

1. Chọn namespace cần theo dõi, mở **Topology snapshots**, đặt tên và bấm **Save baseline**.
2. Deploy thay đổi, chọn baseline rồi bấm **Compare with current** để đọc lại và so sánh.
3. Mở tài nguyên từ kết quả để điều tra image, selector, port, policy hoặc dependency thay đổi.

Mốc lưu theo context kubeconfig + bastion và tập namespace; không so sánh chéo cluster/phạm vi.
Snapshot giữ cấu hình phục vụ topology, bỏ trạng thái biến động như readiness/restart và không
lưu nội dung Secret, biến môi trường hoặc ConfigMap. Lưu tối đa tám mốc mỗi cluster, tự bỏ mốc
cũ nhất khi thêm; tổng dữ liệu cục bộ giới hạn khoảng 2 MB. Lỗi quota/định dạng hiện rõ trên màn hình.
Có thể xóa từng mốc. Dữ liệu không đồng bộ sang thiết bị khác, không tự rollback ứng dụng.

Chỉ danh sách đầy đủ mới chứng minh được tài nguyên thêm/xóa. Khi một lượt bị từ chối/giới hạn,
kết quả tương ứng là unknown. Không có diff không chứng minh cluster khỏe hay không có thay đổi
ngoài các trường được snapshot.

## Cách đọc traffic sau khi sửa

Caretta hiển thị byte/giây; tổng đo ở Service được giữ ở Service. Hubble live hiển thị số quan sát
TCP SYN/UDP mỗi giây (`obs/s`), lịch sử Prometheus hiển thị cờ TCP SYN mỗi giây (`SYN/s`). Hai phép
đo này khác nhau và không phải số kết nối thành công. Một gói Hubble có thể xuất hiện ở nhiều điểm
quan sát. Lost events, node mất kết nối hoặc đọc thiếu agent được báo trên giao diện; không dùng
số 0/không thấy bản ghi để kết luận không có traffic khi coverage không đầy đủ.
