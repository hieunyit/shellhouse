# S3 số lượng lớn và hạn chứng chỉ Kubernetes

## S3

Sync và xem trước cho phép tối đa **100.000.000 object mỗi bên**. Danh sách nguồn,
đích và kế hoạch được lưu vào SQLite tạm trong thư mục tạm riêng của hệ điều hành.
Quét, so sánh và thực thi theo trang 1.000 object; cache SQLite giới hạn 8 MiB,
mẫu xem trước tối đa 300 mục. Dung lượng đĩa tạm tăng theo số lượng và độ dài key;
cần đủ đĩa cho cả hai danh sách và kế hoạch. Nội dung object không lưu vào index.
Index được dọn khi xong, lỗi hoặc dừng bình thường.

Trong bucket có **Copy all objects… / Move all objects…** để xử lý toàn bộ vị trí
đang mở, kể cả các object chưa được tải vào danh sách giao diện. Ở gốc bucket,
mọi object được xử lý theo trang; trong thư mục, thư mục được chép vào vị trí đích.
Copy/move và đổi tên luôn chạy nền sau khi gửi lệnh. Giới hạn 1.000 của API S3
chỉ là kích thước mỗi trang/lô xóa, không phải tổng số object của tác vụ.

Sync có nút **Run in background**. Đóng hộp thoại khi đang chạy cũng thu nhỏ
tác vụ; bấm hàng tác vụ để mở lại chi tiết, xem trước, kết quả và nút **Stop**.
Có thể mở nhiều tác vụ trong cùng tab, duyệt vị trí khác hoặc chuyển sang tab khác.
Các tác vụ đang chạy không bị hủy vì không poll trong hai phút. Kết quả backend
chưa đọc được giữ tối đa một ngày sau khi hoàn tất.

Giữ ứng dụng và tab S3 mở trong khi chạy. Đóng tab/ứng dụng sẽ dừng các tác vụ;
chưa có tiếp tục sau khi khởi động lại. Mirror vẫn kiểm tra số xóa với bản xem trước;
move chỉ xóa nguồn sau khi copy thành công. Sync dừng trước khi ghi nếu phân trang
không trả token kế tiếp hợp lệ.

## Kubernetes

Nút **Certificates** trong tab cluster hiển thị hạn cert API server, client đang
được dùng (gồm exec plugin), CA của cluster và TLS Secret. Cảnh báo khi còn tối đa
30 ngày, báo lỗi từ đúng thời điểm `notAfter`. Ngày còn lại được làm tròn lên.
Các cảnh báo xuất hiện ở cluster và Home › Needs attention nếu tính năng đó bật.
Tab đang mở kiểm tra mỗi phút, gồm lúc tab bị ẩn; cluster theo dõi nền đọc lại theo
chu kỳ Fleet hiện có (3 phút).

TLS Secret đọc theo trang 500, tối đa 10.000 Secret mỗi lần kiểm tra. Thiếu quyền,
lỗi hoặc bị cắt trang đều hiện rõ rằng kiểm tra chưa đầy đủ. Chỉ tên/namespace và
hạn được gửi sang renderer; không gửi certificate PEM hoặc private key.
Đây là kiểm tra hạn, chưa kiểm tra hostname, chuỗi tin cậy hoặc đường TLS của Ingress.
Chỉ đọc được chứng chỉ đang cung cấp qua API/kubeconfig, không quét file cert
của kubelet/etcd trên từng node.

Exec credential dùng thời điểm hết hạn sớm hơn giữa timestamp do plugin trả về
và cert client. Catalog/quyền/số lượng/sức khỏe và Home attention bỏ dữ liệu của
phiên cũ ngay khi đổi context hoặc kết nối lại.

## Kiểm chứng

Kiểm thử tự động gồm preview xuyên suốt **1.000.001 object** qua danh sách S3 giả
lập phân trang và index SQLite thật; kiểm tra biên 100 triệu bằng bộ đếm giả lập;
copy/move hơn 1.000 mục và toàn bộ bucket; thu nhỏ/mở lại sync và hủy riêng job;
phân trang Secret, RBAC, hạn đúng biên, exec refresh và đổi phiên K8s.
Chưa chạy benchmark end-to-end với 100 triệu object trên dịch vụ S3 thật.

Đã chạy typecheck, lint, production build, bộ kiểm thử S3/K8s và renderer liên quan.
E2E Electron xác nhận thao tác S3 thường ngày, export/sync giữa hai tài khoản,
hai sync chạy đồng thời trong khi tạo thư mục và dừng riêng một tác vụ, cùng luồng
K8s đọc chứng chỉ và thao tác list/watch/log/shell/scale/Secret/port-forward/chỉ đọc.
