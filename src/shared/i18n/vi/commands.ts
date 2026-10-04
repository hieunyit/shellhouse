/** Bản dịch tiếng Việt — "Copy as command" (lệnh kubectl / docker / AWS CLI tương đương). */
export const commands: Readonly<Record<string, string>> = {
  'Copy as command…': 'Sao chép thành lệnh…',
  'Copy as command': 'Sao chép thành lệnh',
  '{name} as docker commands': '{name} dưới dạng lệnh docker',
  'Follow logs': 'Theo dõi log',
  'CPU / memory now': 'CPU / bộ nhớ hiện tại',
  'Logs of the Compose project': 'Log của Compose project',
  '{kind} as kubectl': '{kind} dưới dạng kubectl',
  List: 'Liệt kê',
  '{kind} {name} as kubectl': '{kind} {name} dưới dạng kubectl',
  'Show as YAML': 'Xem dạng YAML',
  'Logs of the previous container': 'Log của container trước',
  'Rollout status': 'Trạng thái rollout',
  '{name} as AWS CLI commands': '{name} dưới dạng lệnh AWS CLI',
  'Sync to a local folder': 'Đồng bộ về thư mục trên máy',
  Metadata: 'Metadata',
  'Share link (1 hour)': 'Link chia sẻ (1 giờ)',
  'Equivalent commands for your own terminal, runbooks or tickets.':
    'Lệnh tương đương để chạy trong terminal của bạn, đưa vào runbook hay ticket.',
  'Copy all': 'Sao chép tất cả',
  'Label selector (kubectl -l)': 'Label selector (kubectl -l)',
  'Time range': 'Khoảng thời gian',
  'Any time': 'Mọi lúc',
  'Last {time}': '{time} gần nhất',
  'Same as': 'Tương đương',
  'Export hosts': 'Xuất danh sách host',
  'Save…': 'Lưu…',
  'Shellhouse YAML': 'YAML của Shellhouse',
  'OpenSSH config': 'OpenSSH config',
  'Hosts in': 'Host trong',
  'All groups': 'Mọi nhóm',
  'Passwords and keys are never exported — only the names of shared accounts.':
    'Không bao giờ xuất mật khẩu hay khoá — chỉ tên tài khoản dùng chung.',
  '{n} skipped (not SSH)': '{n} bỏ qua (không phải SSH)',
  'Export hosts…': 'Xuất danh sách host…',
  'Export hosts (Shellhouse YAML, OpenSSH config, CSV)':
    'Xuất danh sách host (YAML của Shellhouse, OpenSSH config, CSV)',
  'Choose a Shellhouse hosts file': 'Chọn file host của Shellhouse',
  'Choose a file first': 'Hãy chọn file trước',
  'This is not a Shellhouse hosts file (exported with Export hosts).':
    'Đây không phải file host của Shellhouse (xuất bằng Export hosts).',
  'The port must be between 1 and 65535': 'Port phải từ 1 đến 65535',
  'Uses the shared account “{name}” — set it after importing':
    'Dùng tài khoản chung “{name}” — đặt lại sau khi nhập',
  'No username': 'Chưa có tên đăng nhập',
  'A file saved with Export hosts (Shellhouse YAML). Groups are recreated; passwords are never in it.':
    'File lưu bằng Export hosts (YAML của Shellhouse). Nhóm được tạo lại; trong file không có mật khẩu.',
  'Choose a file saved with Export hosts.': 'Chọn file đã lưu bằng Export hosts.'
}
