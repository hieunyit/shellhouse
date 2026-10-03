import { t } from '@shared/i18n'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Bỏ chuỗi điều khiển terminal (màu, di chuyển con trỏ, tiêu đề cửa sổ…) để log đọc được như văn
 * bản thường. Có trạng thái: một chuỗi ESC có thể bị cắt ngang giữa hai lần nhận dữ liệu.
 */
export class AnsiStripper {
  private state: 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'string' | 'string-esc' = 'text'
  private readonly decoder = new TextDecoder('utf-8')
  /** "\r" cuối lần trước — để ghép "\r\n" bị cắt đôi. */
  private pendingCr = false

  push(bytes: Uint8Array): string {
    return this.strip(this.decoder.decode(bytes, { stream: true }))
  }

  private strip(text: string): string {
    let out = ''
    for (const ch of text) {
      const code = ch.charCodeAt(0)
      switch (this.state) {
        case 'text':
          if (code === 0x1b) this.state = 'esc'
          else if (code === 0x9b) this.state = 'csi'
          else if (ch === '\r') {
            this.pendingCr = true
            continue
          } else if (ch === '\n') {
            this.pendingCr = false
            out += '\n'
            continue
          } else if (ch === '\t' || code >= 0x20) {
            // "\r" rồi chữ (thanh tiến trình vẽ đè dòng) → xuống dòng để không mất nội dung.
            if (this.pendingCr) out += '\n'
            this.pendingCr = false
            out += ch
            continue
          } else if (code === 0x08 && out.length > 0) {
            // Backspace (xoá ký tự vừa gõ) — chỉ xử lý trong cùng lần nhận.
            out = out.slice(0, -1)
          }
          break
        case 'esc':
          if (ch === '[') this.state = 'csi'
          else if (ch === ']') this.state = 'osc'
          else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') this.state = 'string'
          else if (code >= 0x20 && code <= 0x2f)
            this.state = 'esc' // trung gian (ví dụ ESC ( B)
          else this.state = 'text'
          break
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) this.state = 'text'
          break
        case 'osc':
          if (code === 0x07) this.state = 'text'
          else if (code === 0x1b) this.state = 'osc-esc'
          break
        case 'osc-esc':
          this.state = ch === '\\' ? 'text' : 'osc'
          break
        case 'string':
          if (code === 0x1b) this.state = 'string-esc'
          break
        case 'string-esc':
          this.state = ch === '\\' ? 'text' : 'string'
          break
      }
    }
    return out
  }
}

export interface SessionLogOptions {
  path: string
  stripAnsi: boolean
  /** Dòng đầu file (ai, ở đâu, lúc nào). */
  header: string
}

/**
 * Trần dữ liệu chờ ghi xuống đĩa. Đĩa chậm (ổ mạng, USB) hơn output (`cat` file lớn) → không dồn
 * bộ nhớ vô hạn, cũng không làm chậm terminal: bỏ phần vượt trần và ghi một dòng đánh dấu.
 */
export const MAX_PENDING_LOG_BYTES = 8 * 1024 * 1024

/** Ghi toàn bộ output của một phiên ra file (nối thêm nếu file đã có). */
export class SessionLog {
  private readonly stream: WriteStream
  private readonly stripper: AnsiStripper | null
  private failed = false
  /** Số byte đã bỏ vì đĩa không theo kịp (ghi dòng đánh dấu khi đĩa theo kịp lại). */
  private dropped = 0

  constructor(
    options: SessionLogOptions,
    private readonly onError: (message: string) => void
  ) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.stream = createWriteStream(options.path, { flags: 'a', mode: 0o600 })
    this.stream.on('error', (error) => {
      if (this.failed) return
      this.failed = true
      this.onError(t('Session log stopped: {error}', { error: error.message }))
    })
    this.stripper = options.stripAnsi ? new AnsiStripper() : null
    this.stream.write(`${options.header}\n`)
  }

  write(data: Uint8Array): void {
    if (this.failed) return
    // Vẫn đưa qua bộ lọc ANSI (giữ đúng trạng thái chuỗi ESC bị cắt ngang) dù có thể bỏ kết quả.
    const out = this.stripper ? this.stripper.push(data) : data
    if (out.length === 0) return
    if (this.stream.writableLength > MAX_PENDING_LOG_BYTES) {
      this.dropped += out.length
      return
    }
    if (this.dropped > 0) {
      this.stream.write(`\n[… ${this.dropped} bytes not logged: the disk is too slow …]\n`)
      this.dropped = 0
    }
    this.stream.write(out)
  }

  close(footer: string): void {
    if (this.failed) return
    this.stream.end(`\n${footer}\n`)
  }
}
