# Shellhouse

SSH & terminal client (Electron + TypeScript). Kế hoạch: `../KE-HOACH-MOI.md`. Quyết định kiến trúc: `docs/adr/`.

## Yêu cầu

- Node.js 24 LTS, pnpm 12 (`corepack enable`)
- Công cụ build C++ cho node-pty:
  - Linux/WSL: `sudo apt install build-essential python3`
  - macOS: `xcode-select --install`
  - Windows: Visual Studio Build Tools (workload "Desktop development with C++")

## Bắt đầu

```bash
pnpm install
pnpm rebuild:native   # build node-pty cho ABI của Electron
pnpm dev
```

## Lệnh

| Lệnh                                                 | Việc                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`                                           | Chạy app với hot reload                                                           |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Kiểm tra tĩnh                                                                     |
| `pnpm test`                                          | Unit + integration + fuzz nhanh (Vitest)                                          |
| `pnpm fuzz`                                          | Fuzz parser 50.000 lần/thuộc tính                                                 |
| `pnpm test:compat`                                   | Ma trận server SSH thật (Docker): OpenSSH 7.4→10, Dropbear, legacy, TOTP, bastion |
| `pnpm build && pnpm test:e2e`                        | E2E trên app Electron thật (Playwright)                                           |
| `pnpm build && pnpm bench`                           | Benchmark throughput / độ trễ / RAM                                               |
| `pnpm build && SOAK_MINUTES=60 pnpm soak`            | Soak test: tải hỗn hợp, đo rò rỉ bộ nhớ / handle                                  |
| `pnpm package:dir && pnpm test:package`              | Đóng gói không ký vào `dist/` rồi smoke test bản đó                               |
| `pnpm package`                                       | Bộ cài đầy đủ (AppImage/deb/rpm, NSIS, dmg/zip)                                   |

Phát hành: [docs/RELEASING.md](docs/RELEASING.md). Bảo mật: [SECURITY.md](SECURITY.md),
[docs/security-review.md](docs/security-review.md). Lịch sử thay đổi: [CHANGELOG.md](CHANGELOG.md).

## Cấu trúc

```
src/main/          main process: cửa sổ, bảo mật, IPC, supervisor, (vault, store)
src/session-host/  utilityProcess: (SSH, PTY, SFTP, forwarding)
src/preload/       contextBridge — API duy nhất renderer thấy được
src/renderer/      React UI
src/shared/        hợp đồng IPC + schema zod, dùng chung giữa các process
src/node-shared/   tiện ích chỉ dành cho Node (Secret, host key, UUIDv7) — main + Session Host
migrations/        SQL migration (chỉ thêm file mới, không sửa file cũ)
test/unit/         Vitest
test/integration/  SSH thật với server giả (ssh2 Server) + proxy giả lập mất mạng
test/fuzz/         fast-check cho các parser nhận dữ liệu không tin cậy
test/e2e/          Playwright điều khiển Electron
test/compat/       Server SSH thật trong Docker (ma trận tương thích)
test/soak/         Soak test dài (CI chạy hằng đêm)
test/package/      Smoke test bản đã đóng gói (fuses, asar, native module)
scripts/           Icon, ký file kênh cập nhật, gộp kênh macOS, trích release notes
```

Quy tắc: không import chéo giữa các process (ESLint chặn); mọi dữ liệu qua ranh giới process phải có schema zod.
