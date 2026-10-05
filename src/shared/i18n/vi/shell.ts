/**
 * Bản dịch tiếng Việt — khung app (thiết kế v0.5): title bar, activity bar, Explorer, status bar,
 * Quick connect, trung tâm Transfers (src/renderer/src/shell).
 */
export const shell: Readonly<Record<string, string>> = {
  'Compact fits more rows on screen; Comfortable is easier to read.':
    'Compact hiện được nhiều hàng hơn; Comfortable dễ đọc hơn.',
  Credentials: 'Thông tin đăng nhập',
  App: 'Ứng dụng',
  'Activity bar': 'Thanh hoạt động',
  'Hosts you pin or connect to show up here.': 'Host bạn ghim hoặc vừa kết nối sẽ hiện ở đây.',
  'Remote (SFTP)': 'Máy chủ (SFTP)',
  'Saved SSH hosts show up here.': 'Host SSH đã lưu sẽ hiện ở đây.',
  'By source': 'Theo nguồn',
  'Hide sidebar': 'Ẩn thanh bên',
  'No open sessions': 'Chưa mở phiên nào',
  'Pick a host in the sidebar, or open a terminal on this computer.':
    'Chọn một host ở thanh bên, hoặc mở terminal trên máy này.',
  'Choose an item in the sidebar to open it here.': 'Chọn một mục ở thanh bên để mở tại đây.',
  Tabs: 'Tab',
  'Host name, user@host:port or an ssh command': 'Tên host, user@host:port hoặc lệnh ssh',
  'Type user@host, user@host:port or a saved host name.':
    'Gõ user@host, user@host:port hoặc tên một host đã lưu.',
  'Type a host name or user@host:port.': 'Gõ tên host hoặc user@host:port.',
  'Connect to {target}': 'Kết nối tới {target}',
  'new tab': 'tab mới',
  'Vault unlocked': 'Vault đang mở',
  'Switch to light theme': 'Chuyển sang giao diện sáng',
  'Switch to dark theme': 'Chuyển sang giao diện tối',
  '{n} session': '{n} phiên',
  '{n} sessions': '{n} phiên',
  '{n} disconnected': '{n} mất kết nối',
  '{n} transfer': '{n} lượt truyền',
  '{n} transfers': '{n} lượt truyền',
  Back: 'Quay lại',
  Forward: 'Tiến tới',
  'Search hosts, resources, commands…': 'Tìm host, tài nguyên, lệnh…',
  'No transfers': 'Chưa có lượt truyền nào',
  'Nothing here': 'Không có gì ở đây',
  'Uploads and downloads from SFTP and S3 show up here while their tab is open.':
    'Lượt tải lên / tải xuống của SFTP và S3 hiện ở đây khi tab của chúng đang mở.',
  Active: 'Đang chạy',
  Completed: 'Đã xong',
  Clusters: 'Cluster',
  'The connection dropped. Reconnect to pick up where you left off.':
    'Kết nối đã rớt. Kết nối lại để tiếp tục từ chỗ cũ.',
  'user@host:port — e.g. deploy@10.10.1.11:22': 'user@host:port — ví dụ deploy@10.10.1.11:22',
  '{n} saved host in {groups}': '{n} host đã lưu trong {groups}',
  '{n} saved hosts in {groups}': '{n} host đã lưu trong {groups}',
  '{n} saved host': '{n} host đã lưu',
  '{n} saved hosts': '{n} host đã lưu',
  '{n} session open': '{n} phiên đang mở',
  '{n} sessions open': '{n} phiên đang mở',
  Groups: 'Nhóm',
  Look: 'Hiển thị',
  Startup: 'Khởi động',
  'Focus mode: only the terminal': 'Chế độ tập trung: chỉ còn terminal',
  Exit: 'Thoát',
  Focus: 'Tập trung',
  'save as host': 'lưu thành host',
  'via {name}': 'qua {name}',
  'Jump host “{name}” is not a saved host — add it first':
    'Jump host “{name}” chưa được lưu — hãy thêm host đó trước',
  'Pick a host in the sidebar to copy files to or from it.':
    'Chọn một host ở thanh bên để chép file qua lại.',
  'Theme, density, language and what the sidebar shows.':
    'Giao diện sáng / tối, mật độ, ngôn ngữ và những gì thanh bên hiển thị.',
  'Font, colors and behavior for SSH, Telnet, serial and local terminals.':
    'Font, màu và cách hoạt động của terminal SSH, Telnet, serial và máy này.',
  'Keyboard shortcuts for tabs, panes and the command palette.':
    'Phím tắt cho tab, chia màn hình và bảng lệnh.',
  'File manager and transfer behavior for SFTP and S3.':
    'Trình quản lý file và cách truyền file cho SFTP và S3.',
  'Labels, colors and safety rules for production, staging and other environments.':
    'Nhãn, màu và quy tắc an toàn cho production, staging và các môi trường khác.',
  'Shared accounts and SSH keys, stored in the encrypted vault.':
    'Tài khoản dùng chung và khoá SSH, lưu trong vault đã mã hoá.',
  'Vault, auto-lock and how secrets are stored.': 'Vault, tự khoá và cách lưu thông tin bí mật.',
  'Turn on Kubernetes, Docker, S3 and other tools.':
    'Bật Kubernetes, Docker, S3 và các công cụ khác.',
  'Release channel and automatic updates.': 'Kênh phát hành và tự động cập nhật.',
  'Logs and performance information for troubleshooting.': 'Log và thông tin hiệu năng để tìm lỗi.',
  'Version, licenses and links.': 'Phiên bản, giấy phép và liên kết.',
  'Search settings': 'Tìm trong cài đặt',
  'Filter transfers': 'Lọc lượt truyền',
  Any: 'Bất kỳ',
  Direction: 'Chiều',
  '{percent} of {total}': '{percent} của {total}',
  'Uploaded (resumed)': 'Đã tải lên (tiếp tục)',
  Uploaded: 'Đã tải lên',
  'Downloaded (resumed)': 'Đã tải về (tiếp tục)',
  Downloaded: 'Đã tải về',
  upload: 'tải lên',
  download: 'tải về'
}
