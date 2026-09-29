# ADR-009: Nhóm host phân cấp (nhóm lồng nhóm)

- Trạng thái: Chấp nhận
- Ngày: 2026-09-29

## Bối cảnh

Schema v1 đã có `groups.parent_id` và sidebar đã vẽ đệ quy, nhưng trải nghiệm chưa dùng được:

- Không có cách tạo nhóm con ngay trên một nhóm.
- Ô chọn nhóm cha là danh sách phẳng, vẫn cho chọn nhóm cháu; lỗi vòng lặp chỉ bị backend bắt.
- Số đếm chỉ tính host trực tiếp; không kéo thả được nhóm.
- Xoá nhóm cha thì **xoá luôn mọi nhóm con** (`ON DELETE CASCADE`), host bị đẩy ra ngoài cùng.

## Quyết định

- **Logic cây dùng chung** (`src/shared/group-tree.ts`, hàm thuần, có unit test). Cả main (kiểm
  tra khi lưu) và renderer (vẽ cây, ô chọn, kéo thả) dùng cùng một hàm, nên giao diện không bao giờ
  cho phép điều mà backend từ chối.
  - Hàm: `path`, `depth`, `descendants`, `height`, `flatten`, `groupMoveProblem`,
    `countHostsRecursive`.
  - Bền với dữ liệu hỏng: cha không tồn tại thì nhóm lên cấp cao nhất; gặp vòng lặp thì dừng,
    không treo.
- **Giới hạn 6 cấp** (`MAX_GROUP_DEPTH`), tính cả cây con được đem theo khi di chuyển.
- **Không trùng tên trong cùng một nhóm cha** (không phân biệt hoa thường). Khác nhóm cha thì được
  trùng, ví dụ `Prod / DB` và `Staging / DB`.
- **Xoá nhóm không mất gì:** host và nhóm con dời lên nhóm cha của nhóm bị xoá (hoặc ra cấp cao
  nhất); nhóm con trùng tên ở cấp trên được thêm hậu tố ` (2)`. Chạy trong một transaction. Form
  xoá có bước xác nhận, nói rõ bao nhiêu host và nhóm con sẽ dời đi đâu.
- **Di chuyển nhóm:** IPC riêng `groups:move`; kéo thả nhóm trong sidebar, hoặc chọn "Inside" trong
  form. Khi kéo thả, chỗ thả không hợp lệ (vòng lặp, quá sâu, trùng tên) không sáng lên nên không
  thả được. `getData()` không đọc được trong `dragover`, nên nhóm đang kéo được nhớ ở biến module.
- **Sidebar:**
  - Mỗi nhóm có icon thư mục, đường kẻ dọc theo cấp, và số host tính cả nhóm con cháu.
  - Di chuột lên nhóm hiện các nút thêm host, thêm nhóm con, sửa. Nút nhóm con bị ẩn khi đã ở
    cấp tối đa.
  - Trạng thái đóng/mở được nhớ (localStorage, theo từng máy); có nút thu/mở tất cả.
  - Tìm kiếm khớp cả tên nhóm (ví dụ "prod db"); kết quả hiện đường dẫn nhóm.
  - Kéo mép phải để đổi độ rộng sidebar (208–520 px, có nhớ); nhấp đúp để về mặc định.
- **Ô chọn nhóm** (`GroupSelect`): hiện dạng cây, thụt lề theo cấp, tooltip là đường dẫn đầy đủ. Vị
  trí không hợp lệ bị vô hiệu hoá thay vì báo lỗi sau khi bấm Save.
- **Thông báo lỗi dễ hiểu:** mọi quy tắc trong schema host/nhóm có thông báo riêng. Trước đây người
  dùng thấy thông báo thô của zod ("Too small: expected string to have >=1 characters").

## Không làm (chưa)

- Không đổi schema: `parent_id` và `sort` đã có từ v1; `ON DELETE CASCADE` vẫn giữ nhưng không còn
  được dùng, vì service dời nhóm con lên trước khi xoá.
- Sắp xếp thủ công bằng kéo thả (cột `sort`): hiện sắp theo tên, so số tự nhiên (node2 < node10).
