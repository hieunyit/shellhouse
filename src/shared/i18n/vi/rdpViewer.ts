/** Bản dịch tiếng Việt — Remote Desktop trong tab (IronRDP + proxy RDCleanPath). */
export const rdpViewer: Readonly<Record<string, string>> = {
  // Main
  '“{name}” connects through an RD Gateway, which the built-in viewer does not support yet':
    '“{name}” kết nối qua RD Gateway — trình xem trong app chưa hỗ trợ',
  'RD Gateway is not supported by the built-in viewer':
    'Trình xem trong app chưa hỗ trợ RD Gateway',
  'The certificate check expired — connect again':
    'Lần kiểm tra chứng chỉ đã hết hạn — kết nối lại',
  'The server certificate has not been trusted yet': 'Chưa tin chứng chỉ của server',
  // Session Host (proxy)
  'The SSH connection for the tunnel is not open': 'Kết nối SSH cho tunnel chưa mở',
  'The TLS handshake with the server was inconsistent (possible interception) — connection stopped':
    'Bắt tay TLS với server không nhất quán (có thể bị chặn giữa đường) — đã dừng kết nối',
  '{address} refused the connection — is Remote Desktop enabled?':
    '{address} từ chối kết nối — Remote Desktop đã bật chưa?',
  'Timed out connecting to {address}': 'Hết thời gian chờ kết nối tới {address}',
  'Could not resolve {host}': 'Không phân giải được {host}',
  '{address} is unreachable': 'Không tới được {address}',
  'Could not connect to {address}: {reason}': 'Không kết nối được tới {address}: {reason}',
  'The server requires TLS but it is not configured correctly':
    'Server yêu cầu TLS nhưng cấu hình TLS chưa đúng',
  'The server only allows legacy RDP security, which is not supported':
    'Server chỉ cho phép RDP security kiểu cũ — không được hỗ trợ',
  'The server has no TLS certificate': 'Server không có chứng chỉ TLS',
  'The server requires Network Level Authentication (CredSSP)':
    'Server yêu cầu Network Level Authentication (CredSSP)',
  'The server requires TLS with client certificate authentication':
    'Server yêu cầu TLS kèm xác thực bằng chứng chỉ client',
  'The server rejected the connection settings (code {code})':
    'Server từ chối thông số kết nối (mã {code})',
  'The server did not send a TLS certificate': 'Server không gửi chứng chỉ TLS',
  'The server did not answer the Remote Desktop handshake':
    'Server không trả lời bước bắt tay Remote Desktop',
  'Too many pending Remote Desktop connections': 'Có quá nhiều kết nối Remote Desktop đang chờ',
  // Renderer — tab
  'Could not switch to full screen': 'Không chuyển sang toàn màn hình được',
  'Remote desktop of {name}': 'Màn hình từ xa của {name}',
  '{address} via {via}': '{address} qua {via}',
  'Send Ctrl+Alt+Del': 'Gửi Ctrl+Alt+Del',
  'Send the Windows key': 'Gửi phím Windows',
  'Send clipboard text to the remote computer': 'Gửi nội dung clipboard sang máy từ xa',
  'Clipboard sharing is turned off for this host': 'Host này đã tắt chia sẻ clipboard',
  'Clipboard sent': 'Đã gửi clipboard',
  'Keyboard shortcuts go to the remote computer — click to keep Shellhouse shortcuts':
    'Phím tắt đang gửi sang máy từ xa — bấm để dùng phím tắt của Shellhouse',
  'Shellhouse shortcuts are active — click to send all keys to the remote computer':
    'Đang dùng phím tắt của Shellhouse — bấm để gửi mọi phím sang máy từ xa',
  'Exit full screen': 'Thoát toàn màn hình',
  'Connecting to {name}…': 'Đang kết nối tới {name}…',
  Subject: 'Subject',
  Issuer: 'Issuer',
  'Self-signed': 'Tự ký',
  Valid: 'Hiệu lực',
  '{from} to {to}': '{from} đến {to}',
  'The server certificate has changed': 'Chứng chỉ của server đã thay đổi',
  'Trust this Remote Desktop server?': 'Tin server Remote Desktop này?',
  'The certificate of {address} is different from the one you trusted before. This can happen after the server was reinstalled or its certificate renewed — or someone may be intercepting the connection.':
    'Chứng chỉ của {address} khác với chứng chỉ bạn đã tin trước đây. Có thể do server vừa cài lại hoặc gia hạn chứng chỉ — hoặc có người đang chặn giữa kết nối.',
  'This is the first connection to {address}. Check that the fingerprint matches the server before you sign in.':
    'Đây là lần đầu kết nối tới {address}. Kiểm tra fingerprint khớp với server trước khi đăng nhập.',
  Fingerprint: 'Fingerprint',
  'Trusted before': 'Đã tin trước đây',
  'Trust the new certificate': 'Tin chứng chỉ mới',
  'Sign in to {name}': 'Đăng nhập {name}',
  'user or DOMAIN\\user': 'user hoặc DOMAIN\\user',
  'Domain (optional)': 'Domain (không bắt buộc)',
  'Could not connect to {name}': 'Không kết nối được tới {name}',
  'Opening SSH tunnel…': 'Đang mở SSH tunnel…',
  'Waiting for you to check the certificate': 'Chờ bạn kiểm tra chứng chỉ',
  'Waiting for credentials': 'Chờ thông tin đăng nhập',
  'Encrypted with TLS; server certificate verified': 'Mã hoá TLS; đã xác minh chứng chỉ server',
  'Encrypted with TLS 1.2 using RSA key exchange ({cipher}): the server certificate does not allow modern key exchange, as is usual for Windows. Server certificate verified':
    'Mã hoá TLS 1.2, trao đổi khoá RSA ({cipher}): chứng chỉ server không cho phép trao đổi khoá hiện đại (thường gặp với Windows). Đã xác minh chứng chỉ server',
  'via {via}': 'qua {via}',
  // Renderer — luồng kết nối
  'The username or password is incorrect': 'Sai tên đăng nhập hoặc mật khẩu',
  'The connection request expired — connect again': 'Yêu cầu kết nối đã hết hạn — kết nối lại',
  'Could not reach the server (socket error {code})': 'Không tới được server (lỗi socket {code})',
  'The TLS handshake with the server failed (alert {code})':
    'Bắt tay TLS với server thất bại (alert {code})',
  'The Remote Desktop proxy could not connect: {detail}':
    'Proxy Remote Desktop không kết nối được: {detail}',
  'Could not reach the Remote Desktop proxy': 'Không tới được proxy Remote Desktop',
  'The server rejected the connection: {detail}': 'Server từ chối kết nối: {detail}',
  'The connection failed': 'Kết nối thất bại',
  'Connecting to {via}…': 'Đang kết nối tới {via}…',
  'Checking the server certificate…': 'Đang kiểm tra chứng chỉ của server…',
  'You did not trust the server certificate': 'Bạn không tin chứng chỉ của server',
  'Connection cancelled': 'Đã huỷ kết nối',
  'Signing in…': 'Đang đăng nhập…',
  'Starting the Remote Desktop client…': 'Đang khởi động client Remote Desktop…',
  'Signing in as {user}…': 'Đang đăng nhập bằng {user}…',
  'The session ended: {reason}': 'Phiên đã kết thúc: {reason}',
  'The session ended': 'Phiên đã kết thúc',
  'The connection to the server was lost — check the network or the server, then reconnect.':
    'Mất kết nối tới máy chủ — kiểm tra mạng hoặc máy chủ rồi kết nối lại.',
  'The connection to the server was lost and could not be restored — check the network or the server, then reconnect.':
    'Mất kết nối tới máy chủ và không khôi phục được — kiểm tra mạng hoặc máy chủ rồi kết nối lại.',
  'Connection lost — reconnecting in {seconds}s (attempt {n}/{max})…':
    'Mất kết nối — tự kết nối lại sau {seconds}s (lần {n}/{max})…',
  // Hiệu năng (bảng đo Ctrl+Shift+Alt+P, tuỳ chọn trong form host)
  'Best performance': 'Nhanh nhất',
  Balanced: 'Cân bằng',
  'Best quality': 'Đẹp nhất',
  'Visual experience': 'Hiệu ứng hình ảnh',
  'No wallpaper, animations, themes or font smoothing; windows move as outlines. Fastest on slow links.':
    'Tắt hình nền, hiệu ứng, theme và làm mượt chữ; kéo cửa sổ chỉ hiện khung. Nhanh nhất khi mạng chậm.',
  'Wallpaper, animations and font smoothing, like sitting at the computer.':
    'Có hình nền, hiệu ứng và làm mượt chữ, như ngồi trước máy.',
  'No wallpaper or animations; font smoothing stays on.':
    'Tắt hình nền và hiệu ứng; vẫn làm mượt chữ.',
  'HiDPI (sharper, slower)': 'HiDPI (nét hơn, chậm hơn)',
  'Uses every physical pixel of a scaled display (125–200%). Sharper text, but the server has to send up to 4× more pixels.':
    'Dùng mọi pixel vật lý của màn hình có scale (125–200%). Chữ nét hơn, nhưng server phải gửi số pixel nhiều gấp tới 4 lần.',
  Performance: 'Hiệu năng',
  Frames: 'Khung hình',
  '{n} fps': '{n} fps',
  'Screen updates': 'Vùng cập nhật',
  '{n}/s': '{n}/giây',
  'Decode + draw': 'Giải mã + vẽ',
  '{ms} ms per frame · {busy} of main thread': '{ms} ms mỗi khung hình · {busy} luồng chính',
  Bandwidth: 'Băng thông',
  '↓ {down} · ↑ {up}': '↓ {down} · ↑ {up}',
  'Input → screen': 'Input → màn hình',
  'type or click to measure': 'gõ phím hoặc bấm chuột để đo',
  Resolution: 'Độ phân giải',
  'HiDPI on': 'HiDPI bật',
  'HiDPI off': 'HiDPI tắt',
  Encoding: 'Mã hoá hình',
  'Ctrl+Shift+Alt+P to hide': 'Ctrl+Shift+Alt+P để ẩn',
  'The Remote Desktop client stopped on an internal error ({detail}). Reconnect to continue.':
    'Trình xem Remote Desktop dừng do lỗi nội bộ ({detail}). Kết nối lại để tiếp tục.'
}
