/** Bản dịch tiếng Việt — Remote Desktop bằng control RDP gốc của Windows (mstscax). */
export const rdpNative: Readonly<Record<string, string>> = {
  // Main
  'The Remote Desktop control stopped with error {code}':
    'Control Remote Desktop dừng với lỗi {code}',
  'The window is not ready yet': 'Cửa sổ chưa sẵn sàng',
  'Could not start the connection: {reason}': 'Không bắt đầu kết nối được: {reason}',
  'Could not start the Remote Desktop helper: {reason}':
    'Không chạy được tiến trình phụ Remote Desktop: {reason}',
  'The Remote Desktop helper stopped: {reason}': 'Tiến trình phụ Remote Desktop đã dừng: {reason}',
  'The Remote Desktop helper stopped unexpectedly (code {code})':
    'Tiến trình phụ Remote Desktop dừng bất thường (mã {code})',
  'The native Remote Desktop control is only available on Windows':
    'Control Remote Desktop gốc chỉ có trên Windows',
  'The native Remote Desktop helper is not installed — using the built-in viewer':
    'Chưa cài tiến trình phụ Remote Desktop — dùng trình xem tích hợp',
  'The native Remote Desktop helper is not installed': 'Chưa cài tiến trình phụ Remote Desktop',
  'The native Remote Desktop control is not available':
    'Không dùng được control Remote Desktop gốc',
  // Form host
  'Remote Desktop engine': 'Engine Remote Desktop',
  'Windows RDP': 'Windows RDP',
  'Built-in (IronRDP)': 'Tích hợp (IronRDP)',
  'Uses the built-in viewer (IronRDP), the same as on macOS and Linux.':
    'Dùng trình xem tích hợp (IronRDP), giống trên macOS và Linux.',
  'Uses the Remote Desktop control of Windows (the engine of mstsc): GPU rendering, RemoteFX / H.264 and RD Gateway. Falls back to the built-in viewer if it is not available.':
    'Dùng control Remote Desktop của Windows (engine của mstsc): vẽ bằng GPU, RemoteFX / H.264 và RD Gateway. Không có thì dùng trình xem tích hợp.',
  // Tab
  'The remote computer has the keyboard — click to give it back to Shellhouse':
    'Bàn phím đang ở máy từ xa — bấm để trả lại cho Shellhouse',
  'Send the keyboard to the remote computer': 'Chuyển bàn phím sang máy từ xa',
  'Open in IronRDP': 'Mở bằng IronRDP',
  'Rendered by the Remote Desktop control of Windows (the engine of mstsc). Change it in the host settings.':
    'Vẽ bằng control Remote Desktop của Windows (engine của mstsc). Đổi trong cài đặt của host.',
  'Gateway {gateway}': 'Gateway {gateway}',
  'Keyboard on the remote computer — click Shellhouse to use its shortcuts':
    'Bàn phím đang ở máy từ xa — bấm vào Shellhouse để dùng phím tắt của app',
  'Starting the Remote Desktop control…': 'Đang khởi động control Remote Desktop…',
  'Connecting to {address}…': 'Đang kết nối tới {address}…',
  'The connection failed (code {code})': 'Kết nối thất bại (mã {code})'
}
