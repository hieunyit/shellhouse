/**
 * Protobuf tối giản (wire format) cho Hubble Observer API: đọc / ghi đúng các trường app cần, không
 * kéo thêm thư viện gRPC / protobuf. Trường lạ bỏ qua theo wire type (tương thích bản Cilium mới).
 */

/** Một trường đã đọc: varint (số), hoặc bytes (chuỗi / message lồng). */
export type PbValue = { kind: 'varint'; value: bigint } | { kind: 'bytes'; value: Uint8Array }

/** Đọc mọi trường của một message: số trường → các giá trị (repeated giữ thứ tự). */
export function readMessage(buf: Uint8Array): Map<number, PbValue[]> {
  const out = new Map<number, PbValue[]>()
  let i = 0
  const varint = (): bigint => {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('protobuf: truncated varint')
      const b = buf[i++] ?? 0
      result |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return result
      shift += 7n
      if (shift > 70n) throw new Error('protobuf: varint too long')
    }
  }
  while (i < buf.length) {
    const key = varint()
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    const push = (v: PbValue): void => {
      const list = out.get(field)
      if (list) list.push(v)
      else out.set(field, [v])
    }
    if (wire === 0) push({ kind: 'varint', value: varint() })
    else if (wire === 2) {
      const len = Number(varint())
      if (i + len > buf.length) throw new Error('protobuf: truncated bytes')
      push({ kind: 'bytes', value: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else throw new Error(`protobuf: unsupported wire type ${String(wire)}`)
  }
  return out
}

const decoder = new TextDecoder()

export function str(m: Map<number, PbValue[]>, field: number): string {
  const v = m.get(field)?.[0]
  return v?.kind === 'bytes' ? decoder.decode(v.value) : ''
}

export function strs(m: Map<number, PbValue[]>, field: number): string[] {
  return (m.get(field) ?? []).flatMap((v) => (v.kind === 'bytes' ? [decoder.decode(v.value)] : []))
}

export function num(m: Map<number, PbValue[]>, field: number): number {
  const v = m.get(field)?.[0]
  return v?.kind === 'varint' ? Number(v.value) : 0
}

export function msg(m: Map<number, PbValue[]>, field: number): Map<number, PbValue[]> | null {
  const v = m.get(field)?.[0]
  return v?.kind === 'bytes' ? readMessage(v.value) : null
}

export function msgs(m: Map<number, PbValue[]>, field: number): Map<number, PbValue[]>[] {
  return (m.get(field) ?? []).flatMap((v) => (v.kind === 'bytes' ? [readMessage(v.value)] : []))
}

/** Ghi message: trường theo thứ tự đưa vào; số → varint, chuỗi / bytes / message → length-delimited. */
export type PbField = [number, number | boolean | string | Uint8Array | PbField[]]

function writeVarint(out: number[], value: bigint): void {
  let v = value
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
}

const encoder = new TextEncoder()

export function writeMessage(fields: readonly PbField[]): Uint8Array {
  const out: number[] = []
  for (const [field, value] of fields) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      writeVarint(out, BigInt(field) << 3n)
      writeVarint(out, BigInt(typeof value === 'boolean' ? (value ? 1 : 0) : value))
      continue
    }
    const bytes =
      typeof value === 'string'
        ? encoder.encode(value)
        : value instanceof Uint8Array
          ? value
          : writeMessage(value)
    writeVarint(out, (BigInt(field) << 3n) | 2n)
    writeVarint(out, BigInt(bytes.length))
    for (const b of bytes) out.push(b)
  }
  return Uint8Array.from(out)
}

/** Khung gRPC: 1 byte nén (0) + 4 byte độ dài (big-endian) + message. */
export function grpcFrame(message: Uint8Array): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(message.length, 1)
  return Buffer.concat([head, Buffer.from(message)])
}

/** Tách các khung gRPC từ luồng byte (giữ phần dở cho lần sau). */
export class GrpcFrameReader {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer, onMessage: (message: Uint8Array) => void): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    while (this.pending.length >= 5) {
      if (this.pending[0] !== 0) throw new Error('gRPC: compressed messages are not supported')
      const len = this.pending.readUInt32BE(1)
      if (this.pending.length < 5 + len) return
      onMessage(this.pending.subarray(5, 5 + len))
      this.pending = this.pending.subarray(5 + len)
    }
  }
}
