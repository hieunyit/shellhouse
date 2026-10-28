# Rà soát import host — 2026-10-28

Đã kiểm tra sáu nguồn trong Import hosts: OpenSSH config, MobaXterm, CSV/Termius,
Ansible inventory, Shellhouse YAML và Remote Desktop (.rdp).

## Vị trí host sau khi import

- Mọi host được nhập trực tiếp vào group có sẵn được chọn ở “Into group”.
- Không chọn group: host nằm ở “Không nhóm”.
- Không tự tạo group, kể cả các thư mục nguồn lồng nhau. Đường dẫn nguồn chỉ để xem trước.
- Có thể chọn một group con đã tồn tại làm đích. Import không tạo thêm cấp nào bên dưới nó.
- Kiểm tra group đích còn tồn tại trước khi ghi dữ liệu. RDP dùng cùng cách chọn group.

## Import trực tiếp từ group và giao diện

Di chuột vào hàng group và bấm biểu tượng import, hoặc mở menu của group và chọn
“Import host vào đây…”. Hộp thoại chọn sẵn đúng group, kể cả group con đã tồn tại.
Đổi nguồn import không làm mất group đích. Nếu group bị xoá khi hộp thoại còn mở,
người dùng phải chọn lại đích trước khi nhập.

Thanh thao tác group giữ ba nút thường dùng: thêm host, import và menu. Thêm group con,
sửa group và export có trong menu. Các nút hiện khi di chuột hoặc dùng bàn phím.

Hộp import đặt nguồn và group đích phía trên, hiển thị file nguồn, số host đã chọn,
số mục trùng/lỗi, tìm kiếm và xem trước tối đa 100 dòng mỗi trang. Lựa chọn áp cho cả
lượt import và được giữ khi đổi trang/lọc; chuyển trang đưa phần xem trước về đầu.
Đã kiểm tra luồng group cha, group con và cửa sổ 720×600 bằng Electron.

## Lỗi đã sửa

| Luồng       | Vấn đề                                                                                   | Cách xử lý                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ghi host    | Ghép cây group nguồn vào group đích, có thể để lại group rỗng khi host lỗi               | Bỏ hoàn toàn việc tạo group khi import; xác thực host trước khi lưu                        |
| Xem trước   | Kết quả quét cũ hoặc hộp chọn file cũ có thể ghi đè lựa chọn mới                         | Bỏ kết quả không thuộc lượt quét hiện tại ở cả renderer và main                            |
| Ghi host    | Đọc lại file khi import có thể nhập dữ liệu khác bản người dùng đã xem                   | Main giữ các candidate đã quét, chỉ dùng một lần sau khi nhập thành công                   |
| Giao diện   | Bấm lặp có thể gửi nhiều lượt import; user SSH cũ có thể chặn import RDP                 | Chặn gửi lặp, khoá điều khiển trong lúc nhập, tách xác thực user theo giao thức            |
| MobaXterm   | Thiếu file private key khiến không thể chọn key thay thế                                 | Chuyển thành cảnh báo và cho phép chọn key trong vault                                     |
| CSV/YAML    | Host dùng tài khoản chung có thể bị gán user của máy hiện tại                            | Yêu cầu người dùng cung cấp user thay vì đoán                                              |
| YAML        | Thiếu user bị coi là lỗi không thể sửa trong hộp import                                  | Cho nhập user ở tuỳ chọn chung                                                             |
| YAML        | Port sai kiểu bị đổi ngầm thành 22; cấu trúc null hoặc alias vòng lặp có thể gây crash   | Kiểm tra cấu trúc, phiên bản, vòng lặp, độ sâu và giá trị port                             |
| YAML        | Tham chiếu jump host trong file export bị bỏ qua âm thầm                                 | Hiện tên jump host cần chọn hoặc cấu hình lại                                              |
| CSV         | Dấu chấm phẩy trong header có nháy làm nhận sai delimiter; nháy chưa đóng gộp nhiều dòng | Đếm delimiter ngoài nháy và báo lỗi trường chưa đóng                                       |
| CSV         | Tên trùng với hậu tố tự sinh có thể trùng khoá chọn host                                 | Tìm hậu tố đến khi có khoá duy nhất                                                        |
| CSV export  | Mất user/port kế thừa; nhiều tag bị gộp thành một                                        | Xuất giá trị kết nối hiệu lực và phân cách tag bằng dấu chấm phẩy                          |
| Ansible     | Dải lồng nhau vượt giới hạn tổng hoặc số quá lớn gây treo/tràn                           | Giới hạn tổng mở rộng 10.000 host, kiểm tra số nguyên an toàn                              |
| Ansible     | Thứ tự khai báo có thể làm biến nhóm cha ghi đè nhóm con hoặc sai ưu tiên giữa các nhóm  | Gộp theo độ sâu, ansible_group_priority, tên nhóm, sau đó biến host; từ chối vòng lặp nhóm |
| Ansible INI | Host dạng hostname:port có thể bị nhập nguyên vào hostname                               | Tách hostname và port trước khi tạo candidate                                              |
| OpenSSH     | Include có đường dẫn trong nháy chứa dấu cách bị tách sai                                | Đọc token trong nháy, hỗ trợ dấu bằng và comment phía sau                                  |
| RDP         | Port ngoài khoảng hợp lệ vẫn được cho chọn nhập                                          | Kiểm tra port ở bản xem trước và xác thực HostInput trước khi lưu                          |

Quy tắc ưu tiên nhóm Ansible đối chiếu với
[tài liệu inventory chính thức](https://docs.ansible.com/projects/ansible/latest/inventory_guide/intro_inventory.html).

## Kiểm chứng và giới hạn

Các kiểm thử bao gồm bộ đọc từng định dạng, IPC với database/vault thật, dữ liệu
thay đổi sau khi quét, lượt quét đồng thời, chọn group, lỗi ghi từng host, và giao diện React.
Kiểm thử Electron trên Linux nhập đủ cả sáu định dạng, xác nhận không sinh group và host vào
đúng group đích.

CSV, Ansible, MobaXterm và Shellhouse YAML là luồng nhập SSH; các giao thức khác được thông báo
bỏ qua. Host RDP dùng file .rdp. Các luồng này không khôi phục mật khẩu hay tài khoản chung;
người dùng chọn key/jump host hoặc thiết lập tài khoản sau khi nhập. Đây không phải thao tác
Restore backup của vault. Kiểm thử import không thay thế kiểm tra đăng nhập vào từng máy thật.
