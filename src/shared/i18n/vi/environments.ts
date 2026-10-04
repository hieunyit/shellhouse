/** Bản dịch tiếng Việt — môi trường (Settings › Environments, chọn môi trường cho nhóm / nguồn). */
export const environments: Readonly<Record<string, string>> = {
  Inherit: 'Kế thừa',
  'Using {env} from {group}.': 'Đang dùng {env} của {group}.',
  'Hosts and subgroups inside inherit it: the label, the line at the top and how deleting is confirmed.':
    'Host và nhóm con bên trong kế thừa: nhãn, vạch trên cùng và cách xác nhận khi xoá.',
  'Edit environments…': 'Sửa môi trường…',
  'Type name': 'Gõ tên',
  'Undo toast': 'Hoàn tác',
  'Enter a short label': 'Nhập nhãn ngắn',
  'The short label has at most 4 characters': 'Nhãn ngắn tối đa 4 ký tự',
  'Edit environment': 'Sửa môi trường',
  'New environment': 'Môi trường mới',
  'Short label': 'Nhãn ngắn',
  Style: 'Kiểu',
  'Highlighted uses its own color; keep it for production only.':
    'Nổi bật có màu riêng; chỉ nên dùng cho production.',
  Neutral: 'Trung tính',
  Highlighted: 'Nổi bật',
  'Line at the top': 'Vạch trên cùng',
  'A thin line across the top of the content while you work here.':
    'Một vạch mảnh ở đỉnh vùng nội dung khi bạn làm việc ở đây.',
  'Before deleting': 'Trước khi xoá',
  'Type name: type the resource name. Confirm: a dialog. Undo toast: do it now, undo for 5 seconds.':
    'Gõ tên: gõ đúng tên tài nguyên. Xác nhận: một hộp thoại. Hoàn tác: làm ngay, hoàn tác được trong 5 giây.',
  'Read-only by default': 'Mặc định chỉ đọc',
  'Clusters, endpoints and accounts here hide actions that change things.':
    'Cluster, endpoint và tài khoản ở đây ẩn các thao tác làm thay đổi.',
  'Move them to:': 'Chuyển chúng sang:',
  'No environment': 'Không có môi trường',
  'Set an environment on a host group, cluster, Docker endpoint or S3 account. Everything inside inherits its label, the line at the top and how deleting is confirmed.':
    'Đặt môi trường cho nhóm host, cluster, Docker endpoint hoặc tài khoản S3. Mọi thứ bên trong kế thừa nhãn, vạch trên cùng và cách xác nhận khi xoá.',
  Environments: 'Môi trường',
  'Top line': 'Vạch trên',
  'Actions for {name}': 'Thao tác cho {name}',
  '{name} copy': '{name} (bản sao)',
  'Move up': 'Lên trên',
  'Move down': 'Xuống dưới',
  'Built-in, can’t be deleted': 'Dựng sẵn, không xoá được',
  '{n} group uses it': '{n} nhóm đang dùng',
  '{n} groups use it': '{n} nhóm đang dùng',
  '{n} cluster, endpoint or account uses it': '{n} cluster, endpoint hoặc tài khoản đang dùng',
  '{n} clusters, endpoints or accounts use it': '{n} cluster, endpoint hoặc tài khoản đang dùng',
  '{n} source': '{n} nguồn',
  '{n} sources': '{n} nguồn',
  Workspace: 'Không gian làm việc'
}
