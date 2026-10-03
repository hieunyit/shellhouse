/** Bản dịch tiếng Việt — Remote Desktop (RDP): form host, client RDP của hệ điều hành, tunnel SSH, import .rdp. */
export const rdp: Readonly<Record<string, string>> = {
  // Host / service
  '"{name}" is a Remote Desktop host — use Connect to open it':
    '"{name}" là host Remote Desktop — dùng Kết nối để mở',
  'A Remote Desktop host cannot be a jump host': 'Host Remote Desktop không làm jump host được',
  'Invalid username': 'Tên đăng nhập không hợp lệ',
  'Remote Desktop settings are missing': 'Thiếu cài đặt Remote Desktop',
  'Invalid Remote Desktop settings': 'Cài đặt Remote Desktop không hợp lệ',
  'Remote Desktop hosts sign in with a password': 'Host Remote Desktop đăng nhập bằng mật khẩu',
  'Remote Desktop hosts have no jump hosts': 'Host Remote Desktop không dùng jump host',
  'A host cannot tunnel through itself': 'Host không thể tunnel qua chính nó',
  'The SSH host for the tunnel no longer exists': 'SSH host dùng cho tunnel không còn nữa',
  '“{name}” is not an SSH host — pick an SSH host for the tunnel':
    '“{name}” không phải host SSH — chọn một host SSH cho tunnel',
  '“{name}” uses the system ssh command, which cannot forward ports for the tunnel':
    '“{name}” dùng lệnh ssh của hệ thống, không port forwarding được cho tunnel',
  '"{name}" is not a Remote Desktop host': '"{name}" không phải host Remote Desktop',
  // Kiểm tra dữ liệu (thông báo của zod)
  'The username is too long': 'Tên đăng nhập quá dài',
  'The username must not start or end with a space':
    'Tên đăng nhập không được bắt đầu hoặc kết thúc bằng khoảng trắng',
  'The domain is too long': 'Domain quá dài',
  'Invalid domain': 'Domain không hợp lệ',
  'Width must be at least 640': 'Chiều rộng tối thiểu là 640',
  'Height must be at least 480': 'Chiều cao tối thiểu là 480',
  'Use either an RD Gateway or an SSH tunnel, not both':
    'Chỉ dùng RD Gateway hoặc tunnel SSH, không dùng cả hai',
  'Invalid gateway address': 'Địa chỉ gateway không hợp lệ',
  // Kiểm tra / mở client
  'No Remote Desktop client was found on this computer':
    'Không tìm thấy client Remote Desktop nào trên máy này',
  'Add a username to “{name}” — {client} needs it to sign in':
    'Thêm tên đăng nhập cho “{name}” — {client} cần nó để đăng nhập',
  '“{name}” connects through {via} — the SSH tunnel is not open':
    '“{name}” kết nối qua {via} — tunnel SSH chưa mở',
  'This host does not use an SSH tunnel': 'Host này không dùng tunnel SSH',
  'Enter the password to connect': 'Nhập mật khẩu để kết nối',
  'Remote Desktop Connection (mstsc) ships with Windows. If it was removed, add it back in Settings → System → Optional features.':
    'Remote Desktop Connection (mstsc) có sẵn trong Windows. Nếu đã bị xoá, thêm lại trong Settings → System → Optional features.',
  'Install “Windows App” (formerly Microsoft Remote Desktop) from the Mac App Store.':
    'Cài “Windows App” (trước là Microsoft Remote Desktop) từ Mac App Store.',
  'Install FreeRDP (for example: sudo apt install freerdp3-x11, sudo dnf install freerdp) or Remmina.':
    'Cài FreeRDP (ví dụ: sudo apt install freerdp3-x11, sudo dnf install freerdp) hoặc Remmina.',
  'FreeRDP rejected the connection settings': 'FreeRDP không nhận cài đặt kết nối',
  'Could not reach the Remote Desktop server': 'Không kết nối được tới server Remote Desktop',
  'Sign-in failed — check the username, domain and password':
    'Đăng nhập thất bại — kiểm tra tên đăng nhập, domain và mật khẩu',
  'The account is locked out': 'Tài khoản đang bị khoá',
  'The server name could not be resolved': 'Không phân giải được tên server',
  'The secure (TLS) connection failed': 'Kết nối bảo mật (TLS) thất bại',
  'The password has expired and must be changed': 'Mật khẩu đã hết hạn, cần đổi mật khẩu',
  'The account is disabled': 'Tài khoản đã bị vô hiệu hoá',
  'Access denied — the account is not allowed to sign in remotely':
    'Bị từ chối — tài khoản không được phép đăng nhập từ xa',
  'No credentials were provided': 'Chưa cung cấp thông tin đăng nhập',
  'The Remote Desktop client exited with code {code}: {detail}':
    'Client Remote Desktop đã thoát với mã {code}: {detail}',
  'The Remote Desktop client exited with code {code}':
    'Client Remote Desktop đã thoát với mã {code}',
  'cmdkey.exe was not found — cannot pass the saved password to mstsc':
    'Không tìm thấy cmdkey.exe — không chuyển được mật khẩu đã lưu cho mstsc',
  'Could not store the credentials for mstsc (cmdkey failed)':
    'Không lưu được thông tin đăng nhập cho mstsc (cmdkey lỗi)',
  'Could not open {app}': 'Không mở được {app}',
  'Could not start {client}: {error}': 'Không chạy được {client}: {error}',
  // Import .rdp
  'Could not read the file': 'Không đọc được file',
  'No computer address in the file': 'File không có địa chỉ máy',
  'Invalid hostname': 'Hostname không hợp lệ',
  'Choose Remote Desktop (.rdp) files': 'Chọn file Remote Desktop (.rdp)',
  'Choose .rdp files first': 'Chọn file .rdp trước',
  'Remote Desktop (.rdp) files saved by mstsc or Windows App. Each file becomes an RDP host; saved passwords are not imported.':
    'File Remote Desktop (.rdp) do mstsc hoặc Windows App lưu. Mỗi file thành một host RDP; mật khẩu đã lưu không được import.',
  'Choose files…': 'Chọn file…',
  'Choose one or more .rdp files.': 'Chọn một hoặc nhiều file .rdp.',
  // Form host
  'Choose the SSH host to connect through': 'Chọn SSH host để kết nối qua',
  'Enter the RD Gateway address': 'Nhập địa chỉ RD Gateway',
  Domain: 'Domain',
  'Optional — or type DOMAIN\\user as the username':
    'Không bắt buộc — hoặc gõ DOMAIN\\user vào ô tên đăng nhập',
  'Save in vault': 'Lưu trong vault',
  'Ask each time': 'Hỏi mỗi lần',
  'The Remote Desktop client asks for the password when you connect.':
    'Client Remote Desktop sẽ hỏi mật khẩu khi kết nối.',
  'Open in': 'Mở bằng',
  'App tab': 'Tab trong app',
  'External client': 'Client bên ngoài',
  'Opens the remote desktop in a Shellhouse tab. Right-click the host to use the external client instead.':
    'Mở màn hình từ xa trong một tab của Shellhouse. Chuột phải vào host để dùng client bên ngoài.',
  'Opens the Remote Desktop client of your system (mstsc, Windows App, FreeRDP or Remmina).':
    'Mở client Remote Desktop của hệ điều hành (mstsc, Windows App, FreeRDP hoặc Remmina).',
  Display: 'Màn hình',
  'Full screen': 'Toàn màn hình',
  'Window size': 'Kích thước cửa sổ',
  Width: 'Rộng',
  Height: 'Cao',
  'Use all monitors': 'Dùng mọi màn hình',
  'Resize with the window': 'Đổi độ phân giải theo cửa sổ',
  'Automatic (system)': 'Tự động (theo hệ thống)',
  'Share with the remote computer': 'Chia sẻ với máy từ xa',
  Clipboard: 'Clipboard',
  'Local drives': 'Ổ đĩa trên máy',
  Audio: 'Âm thanh',
  Printers: 'Máy in',
  Connection: 'Kết nối',
  Direct: 'Trực tiếp',
  'Through SSH host': 'Qua SSH host',
  'RD Gateway': 'RD Gateway',
  'The Remote Desktop client connects to the host directly.':
    'Client Remote Desktop kết nối thẳng tới host.',
  'SSH host': 'SSH host',
  'Choose an SSH host…': 'Chọn SSH host…',
  'system ssh, no port forwarding': 'ssh hệ thống, không có port forwarding',
  'Shellhouse signs in to the SSH host, forwards a random local port (127.0.0.1) to this computer, points the Remote Desktop client at it, and closes the tunnel when you disconnect.':
    'Shellhouse đăng nhập SSH host, forward một port local ngẫu nhiên (127.0.0.1) tới máy này, cho client Remote Desktop kết nối vào đó và đóng tunnel khi bạn ngắt kết nối.',
  'Gateway address': 'Địa chỉ gateway',
  'Signs in to the gateway with the same credentials.':
    'Đăng nhập gateway bằng cùng thông tin đăng nhập.',
  // Thanh bên
  'Connect full screen': 'Kết nối toàn màn hình',
  'Open in external client': 'Mở bằng client bên ngoài',
  'Address copied': 'Đã sao chép địa chỉ',
  // Thẻ trạng thái phiên
  'Preparing…': 'Đang chuẩn bị…',
  'Waiting for the password…': 'Đang chờ mật khẩu…',
  'Opening SSH tunnel via {via}: {detail}': 'Đang mở tunnel SSH qua {via}: {detail}',
  'Opening SSH tunnel via {via}…': 'Đang mở tunnel SSH qua {via}…',
  'Starting {client}…': 'Đang chạy {client}…',
  'Connected via {client} (tunnel {address} via {via})':
    'Đã kết nối bằng {client} (tunnel {address} qua {via})',
  'Connected via {client}': 'Đã kết nối bằng {client}',
  'Opened in {client} (tunnel {address} via {via})':
    'Đã mở bằng {client} (tunnel {address} qua {via})',
  'Opened in {client}': 'Đã mở bằng {client}',
  'Could not connect': 'Không kết nối được',
  'Password for {user}': 'Mật khẩu của {user}',
  'Password (not saved)': 'Mật khẩu (không lưu)',
  'Used for this connection only. Save it on the host to skip this step.':
    'Chỉ dùng cho lần kết nối này. Lưu mật khẩu vào host để bỏ qua bước này.',
  'Remote Desktop': 'Remote Desktop',
  "Shellhouse can't tell when that window closes — disconnect here when you're done to close the tunnel.":
    'Shellhouse không biết khi nào cửa sổ đó đóng — dùng xong hãy ngắt kết nối ở đây để đóng tunnel.',
  "Shellhouse can't tell when that window closes.": 'Shellhouse không biết khi nào cửa sổ đó đóng.',
  'Remote Desktop connections': 'Kết nối Remote Desktop',
  'The SSH tunnel through {via} closed: {reason}': 'Tunnel SSH qua {via} đã đóng: {reason}',
  'Remote Desktop session to {name} ended': 'Phiên Remote Desktop tới {name} đã kết thúc',
  'Could not open the SSH tunnel': 'Không mở được tunnel SSH',
  'The SSH tunnel was closed': 'Tunnel SSH đã bị đóng',
  'The SSH connection closed': 'Kết nối SSH đã đóng'
}
