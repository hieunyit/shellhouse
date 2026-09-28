# Rà soát bảo mật (Phase 4)

Ngày: 2026-09-28. Phạm vi: toàn bộ mã nguồn, cấu hình đóng gói, chuỗi phát hành.
Ký hiệu: ✅ đạt, kèm test tự động nếu có · ⚠️ còn hạn chế, đã ghi lại · 🔧 đã sửa trong đợt rà soát.

## Electron

| Mục                                                                   | Trạng thái | Bằng chứng                                             |
| --------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `sandbox`, `contextIsolation`, không `nodeIntegration`, không webview | ✅         | `src/main/security.ts` (`secureWebPreferences`)        |
| CSP chặt trong bản build (không inline script, `object-src 'none'`)   | ✅         | e2e `security.spec.ts`: script inline bị chặn          |
| Chặn điều hướng / cửa sổ mới / mọi permission request                 | ✅         | `installGlobalGuards`                                  |
| Link ngoài: chỉ http(s), **hỏi xác nhận** và hiện URL đầy đủ          | 🔧         | e2e: Cancel → không mở; `file://` → bị chặn, không hỏi |
| Link trong terminal thực sự mở được (handler cũ bị chặn)              | 🔧         | WebLinksAddon gửi thẳng URL                            |
| IPC: zod validate mọi tham số, chỉ nhận từ webContents của app        | ✅         | e2e: cửa sổ lạ có preload của app → `Forbidden`        |
| IPC: chỉ nhận từ **frame gốc** (không nhận iframe)                    | 🔧         | `isTrustedSender` kiểm tra `frame.parent`              |
| Preload không phơi `ipcRenderer`, chỉ hàm cụ thể                      | ✅         | `src/preload/index.ts`                                 |
| Không `dangerouslySetInnerHTML` trong renderer                        | ✅         | ESLint `no-restricted-syntax`                          |
| Fuses: RunAsNode, NODE_OPTIONS, `--inspect` tắt; asar integrity bật   | ✅         | `@electron/fuses read` trên bản đóng gói; smoke test   |
| Test hooks / `SHELLHOUSE_USER_DATA` bị bỏ qua trên bản đóng gói       | ✅         | smoke test: `__shellhouseTest` không tồn tại           |

## Bí mật

| Mục                                                                  | Trạng thái | Bằng chứng                                              |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------------- |
| Mật khẩu / private key mã hoá trong DB (AD gắn với bảng, id, trường) | ✅         | `vault.test.ts`                                         |
| Không có secret dạng rõ trong log, DB, WAL, dữ liệu Chromium         | ✅         | e2e quét mọi file trong userData (UTF-8 + UTF-16)       |
| Log IPC không in tham số; lỗi auth không in mật khẩu                 | ✅         | rà soát tay mọi lệnh `log.*`                            |
| Không hiện mật khẩu trong terminal                                   | ✅         | e2e `ssh.spec.ts`                                       |
| "Nhớ trên máy": từ chối khi keychain Linux là `basic_text`           | ✅         | `electron-protector.ts`; e2e `settings.spec.ts`         |
| ⚠️ Secret nằm trong heap JS lúc đang dùng (không có `sodium_malloc`) | ⚠️         | Giới hạn của Electron; khi khoá vault, DEK bị `memzero` |

## SSH

| Mục                                                                                           | Trạng thái | Bằng chứng                                     |
| --------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------- |
| Host key: unknown / changed / revoked; khi changed phải xác nhận 2 bước                       | ✅         | e2e `ssh.spec.ts`, unit `known-hosts`          |
| System ssh: tham số dạng mảng, có `--` trước hostname                                         | ✅         | `system-ssh.test.ts`                           |
| Deploy key: public key qua stdin, không nội suy vào lệnh                                      | ✅         | test key chứa `$(...)`                         |
| ssh config: không chạy `Match exec`                                                           | ✅         | `matchExec: false` + fuzz                      |
| Parser dữ liệu không tin cậy (ssh config, quick connect, known_hosts, settings, snippet, IPC) | 🔧         | fuzz tìm ra và đã sửa 4 lỗi (prototype, crash) |
| SFTP: không treo khi mất kết nối giữa chừng                                                   | 🔧         | `LossGuard` + chaos test                       |

## Chuỗi cung ứng và phát hành

| Mục                                                                  | Trạng thái | Bằng chứng                         |
| -------------------------------------------------------------------- | ---------- | ---------------------------------- |
| `pnpm audit`: không có lỗ hổng đã biết                               | ✅         | CI chạy `--audit-level high`       |
| Lockfile cố định (`--frozen-lockfile`)                               | ✅         | CI                                 |
| Windows / macOS: ký code + notarize, thiếu secret thì dừng           | ✅         | `release.yml`                      |
| Linux: file kênh cập nhật ký ed25519, app từ chối nếu sai hoặc thiếu | 🔧         | `update-signature.test.ts`         |
| Release luôn là bản nháp, người phát hành duyệt tay                  | ✅         | `release.yml`, `docs/RELEASING.md` |
| SHA256SUMS đính kèm release                                          | ✅         | `release.yml`                      |

## Công cụ tĩnh

Electronegativity (2026-09-28): 7 cảnh báo, không cảnh báo nào còn tồn tại thật.

- `NODE_INTEGRATION`, `CONTEXT_ISOLATION`, `SANDBOX` và `AUXCLICK` tại `index.ts:324`: báo nhầm, vì
  công cụ không lần theo được `secureWebPreferences()`. Auxclick (bấm chuột giữa) cũng đi qua
  `setWindowOpenHandler`.
- `REMOTE_MODULE`: module `remote` đã bị gỡ khỏi Electron.
- `CSP_GLOBAL`: báo nhầm, vì CSP được chèn lúc build (`electron.vite.config.ts`).
- `OPEN_EXTERNAL`: đã sửa bằng hộp thoại xác nhận (xem trên).

## Việc còn lại

- Chạy ma trận OpenSSH thật (Docker) trước bản 1.0.
- Thuê hoặc nhờ người ngoài rà soát trước bản 1.0 (ưu tiên: vault, IPC, xử lý host key).
