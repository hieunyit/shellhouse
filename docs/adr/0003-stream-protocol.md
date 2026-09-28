# ADR-003: Giao thức stream terminal

- Trạng thái: Chấp nhận
- Ngày: 2026-09-28

## Bối cảnh

Mọi byte output của terminal đi từ PTY/SSH tới xterm.js. Đây là đường nóng duy nhất của app:
output lớn (`cat` file log, build) không được làm treo UI, và phải có backpressure để một
tab xả output không ăn hết RAM.

## Quyết định

### Kênh

Mỗi session một `MessageChannelMain`: main tạo cặp port, gửi `port1` cho Session Host
(`utilityProcess.postMessage`) và `port2` cho renderer (`webContents.postMessage`).
Dữ liệu đi **thẳng** renderer ↔ Session Host, không qua main, không mở cổng mạng, không cần token.

`contextBridge` không chuyển được `MessagePort`, nên preload chuyển port vào main world bằng
`window.postMessage` (renderer chỉ nhận khi `event.source === window`).

### Tin nhắn (`src/shared/stream-protocol.ts`)

| Hướng           | Tin                                  | Validate                            |
| --------------- | ------------------------------------ | ----------------------------------- |
| Renderer → Host | `input`, `resize`, `ack`             | zod đầy đủ (tần suất thấp)          |
| Host → Renderer | `data` (Uint8Array), `exit`, `error` | kiểm tra kiểu thủ công (đường nóng) |

### Flow control (`OutputPump`)

- Gom output, gửi khi đủ **256 KB** hoặc sau **8 ms** kể từ byte đầu của batch.
- Renderer gọi `term.write(data, cb)`; trong `cb` gửi `ack(n)`.
- Chưa ack > **4 MB** → `pty.pause()`; < **1 MB** → `pty.resume()`. Với SSH sẽ là
  `stream.pause()`, áp lực tự đẩy về server qua SSH window.

### Vòng đời

- Renderer đóng tab/reload/crash → port đóng → Session Host kill PTY (không có shell mồ côi).
- Session Host crash → renderer thấy `restarts` thay đổi → bỏ client cũ, giữ scrollback,
  mở phiên mới. Mỗi lần kết nối có số thế hệ; kết quả của lần kết nối cũ về muộn bị bỏ.

## Số đo (WSL2 + WSLg, không có GPU → xterm dùng DOM renderer)

| Batch / high / low             | `cat` 100 MB | UI bị chặn lâu nhất |
| ------------------------------ | ------------ | ------------------- |
| 64 KB / 1 MB / 128 KB          | 8,0 s        | 64 ms               |
| 128 KB / 2 MB / 512 KB (16 ms) | 6,5 s        | 41 ms               |
| **256 KB / 4 MB / 1 MB**       | **5,5 s**    | 72 ms               |
| 512 KB / 8 MB / 2 MB (16 ms)   | 5,2 s        | 69 ms               |

Chọn 256 KB / 4 MB: nhanh hơn 30% so với ban đầu. 512 KB / 8 MB chỉ nhanh thêm ~5% nhưng
lượng output xếp hàng (phải vẽ hết sau khi bấm Ctrl+C) tăng gấp đôi.

Chưa đạt mục tiêu < 5 s trên máy **không có GPU**. Cần đo lại trên Windows/macOS có GPU (WebGL
renderer) trước khi kết luận; nếu vẫn chưa đạt, hướng tiếp theo là giảm số lần render khi
output quá nhanh (bỏ khung hình trung gian như tmux).

## Hệ quả

- (+) UI không treo dưới output lớn (bị chặn tối đa ~70 ms khi `cat` 100 MB).
- (+) Bộ nhớ đệm mỗi tab bị chặn trên ~4 MB + phần đang gom.
- (−) Sau Ctrl+C, terminal có thể còn vẽ tiếp tối đa ~4 MB output đã xếp hàng.
