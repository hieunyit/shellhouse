import { inspect } from 'node:util'

const REDACTED = '***'

/**
 * Bọc dữ liệu nhạy cảm (password, passphrase, private key, DEK).
 * Mọi cách chuyển sang chuỗi/JSON/log đều ra `***`; chỉ `reveal()` mới lấy được giá trị.
 * `dispose()` ghi đè bộ nhớ bằng 0 — gọi ngay khi dùng xong.
 */
export class Secret {
  #bytes: Buffer | null

  private constructor(bytes: Buffer) {
    this.#bytes = bytes
  }

  /** Nhận quyền sở hữu buffer (không copy). Người gọi không được dùng buffer đó nữa. */
  static adopt(bytes: Buffer): Secret {
    return new Secret(bytes)
  }

  static fromString(value: string): Secret {
    return new Secret(Buffer.from(value, 'utf8'))
  }

  get disposed(): boolean {
    return this.#bytes === null
  }

  get length(): number {
    return this.#bytes?.length ?? 0
  }

  /** Buffer gốc — không lưu lại tham chiếu, không log. */
  reveal(): Buffer {
    if (!this.#bytes) throw new Error('Secret has been disposed')
    return this.#bytes
  }

  revealString(): string {
    return this.reveal().toString('utf8')
  }

  dispose(): void {
    if (!this.#bytes) return
    this.#bytes.fill(0)
    this.#bytes = null
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`
  }

  [Symbol.toPrimitive](): string {
    return REDACTED
  }
}
