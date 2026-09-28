# ADR-001: Electron + TypeScript cho app shell

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Bối cảnh

Ưu tiên số một của Shellhouse là **ổn định và chắc chắn**. Thiết kế ban đầu dùng Go + Wails v2
(WebView của hệ điều hành). Rủi ro chính của thiết kế đó: WebView khác nhau trên 3 OS
(WebView2, WKWebView, WebKitGTK), WebGL không ổn định trên Linux, cộng đồng Wails nhỏ,
phải tự viết auto-update, và ConPTY trong Go ít được dùng.

## Quyết định

Dùng **Electron + TypeScript + React**, với bộ thư viện lõi đã chạy trong sản phẩm lớn:

| Việc     | Thư viện                  | Dùng trong                  |
| -------- | ------------------------- | --------------------------- |
| Terminal | xterm.js                  | VS Code, Termius, Tabby     |
| PTY      | node-pty (Microsoft)      | VS Code                     |
| SSH/SFTP | ssh2                      | Tabby và nhiều công cụ khác |
| SQLite   | better-sqlite3            | Nhiều app Electron          |
| Crypto   | libsodium (sodium-native) | Đã audit                    |
| Update   | electron-updater          | Chuẩn de facto              |

## Hệ quả

- (+) Chromium giống nhau trên mọi OS; không còn lớp khác biệt WebView.
- (+) Auto-update, keychain (`safeStorage`), crash reporter có sẵn.
- (−) Bản cài ~100 MB, RAM cao hơn. Tiêu chí RAM 10 tab SSH nới lên < 500 MB.
- (−) Native module phải khớp ABI Electron. Giảm thiểu: chỉ node-pty cần rebuild;
  better-sqlite3 và sodium-native dùng bản build N-API.
- (−) Không dùng được `sodium_malloc` (V8 memory cage của Electron cấm buffer ngoài heap).
  Secret giữ trong `Buffer` thường và `sodium_memzero` ngay sau khi dùng.
