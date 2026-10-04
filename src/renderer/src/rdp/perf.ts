/**
 * Đo hiệu năng tab Remote Desktop (bật bằng Ctrl+Shift+Alt+P): khung hình hiển thị mỗi giây, số
 * vùng cập nhật, thời gian giải mã + vẽ, byte vào / ra qua proxy, độ trễ input → khung hình, loại
 * mã hoá server đang dùng. Tắt thì gần như không tốn gì: chỉ một phép so sánh mỗi message WebSocket.
 */

/** Loại dữ liệu hình server gửi (đọc từ header PDU fast-path / slow-path). */
export type RdpCodecKind =
  | { kind: 'bitmap'; bpp: number; compressed: boolean }
  | { kind: 'surface'; codecId: number }
  | { kind: 'orders' }
  | { kind: 'pointer' }
  | { kind: 'slowpath' }
  | { kind: 'other' }

export function codecKey(c: RdpCodecKind): string {
  switch (c.kind) {
    case 'bitmap':
      return `bitmap:${c.bpp}:${c.compressed ? 1 : 0}`
    case 'surface':
      return `surface:${c.codecId}`
    default:
      return c.kind
  }
}

/** Tên giao thức (không dịch): "Bitmap 16-bit RLE", "RemoteFX"… IronRDP gán RemoteFX mã 3. */
export function codecLabel(key: string): string {
  const [kind, a, b] = key.split(':')
  switch (kind) {
    case 'bitmap': {
      const bpp = Number(a)
      if (b !== '1') return `Bitmap ${bpp}-bit raw`
      return bpp === 32 ? 'Bitmap 32-bit planar' : `Bitmap ${bpp}-bit RLE`
    }
    case 'surface':
      return a === '0' ? 'Surface raw' : a === '3' ? 'RemoteFX' : `Surface codec ${a}`
    case 'orders':
      return 'Drawing orders'
    case 'pointer':
      return 'Pointer'
    case 'slowpath':
      return 'Slow-path'
    default:
      return 'Other'
  }
}

const FASTPATH_UPDATE_ORDERS = 0x0
const FASTPATH_UPDATE_BITMAP = 0x1
const FASTPATH_UPDATE_SURFCMDS = 0x4
const FASTPATH_FRAGMENT_SINGLE = 0
const FASTPATH_FRAGMENT_FIRST = 2
const FASTPATH_COMPRESSION_USED = 0x2
const CMDTYPE_SET_SURFACE_BITS = 0x0001
const CMDTYPE_STREAM_SURFACE_BITS = 0x0006

/** Phân loại một fast-path update theo phần dữ liệu đầu. */
function classifyUpdate(code: number, data: Uint8Array): RdpCodecKind {
  const u16 = (i: number): number => (data[i] ?? 0) | ((data[i + 1] ?? 0) << 8)
  switch (code) {
    case FASTPATH_UPDATE_ORDERS:
      return { kind: 'orders' }
    case FASTPATH_UPDATE_BITMAP:
      // TS_UPDATE_BITMAP_DATA: updateType, numberRectangles, rồi TS_BITMAP_DATA đầu tiên.
      if (data.length < 4 + 18) return { kind: 'other' }
      return { kind: 'bitmap', bpp: u16(4 + 12), compressed: (u16(4 + 14) & 0x1) !== 0 }
    case FASTPATH_UPDATE_SURFCMDS: {
      // cmdType, đích (8 byte), rồi TS_BITMAP_DATA_EX: bpp, flags, reserved, codecID.
      const cmd = u16(0)
      if (
        (cmd === CMDTYPE_SET_SURFACE_BITS || cmd === CMDTYPE_STREAM_SURFACE_BITS) &&
        data.length >= 14
      )
        return { kind: 'surface', codecId: data[13] ?? 0 }
      return { kind: 'other' }
    }
    case 0x2:
    case 0x3:
      return { kind: 'other' }
    default:
      return code >= 0x5 && code <= 0xc ? { kind: 'pointer' } : { kind: 'other' }
  }
}

const PDUTYPE_DATA = 0x7
const PDUTYPE2_UPDATE = 0x02
const PDUTYPE2_POINTER = 0x1b

/**
 * Slow-path (TPKT → X.224 → MCS Send Data Indication → Share Control/Data header): update hình
 * (TS_UPDATE_BITMAP_DATA giống fast-path), con trỏ, còn lại là PDU điều khiển / kênh ảo.
 */
export function classifySlowPath(body: Uint8Array): string {
  // X.224 Data (3 byte), MCS Send Data Indication (0x68), initiator, channel, cờ, độ dài PER.
  if (body[0] !== 0x02 || body[1] !== 0xf0 || body[3] !== 0x68) return 'slowpath'
  let p = 9
  p += (body[p] ?? 0) & 0x80 ? 2 : 1
  const u16 = (i: number): number => (body[i] ?? 0) | ((body[i + 1] ?? 0) << 8)
  if (p + 18 > body.length || (u16(p + 2) & 0xf) !== PDUTYPE_DATA) return 'slowpath'
  const pduType2 = body[p + 6 + 8] ?? 0
  if (pduType2 === PDUTYPE2_POINTER) return 'pointer'
  if (pduType2 !== PDUTYPE2_UPDATE) return 'slowpath'
  const update = body.subarray(p + 6 + 12)
  const updateType = u16(p + 6 + 12)
  if (updateType === 0) return 'orders'
  if (updateType !== 1) return 'other'
  return codecKey(classifyUpdate(FASTPATH_UPDATE_BITMAP, update))
}

/**
 * Đọc header PDU server → client trên luồng byte (message WebSocket không trùng ranh giới PDU).
 * Bật giữa chừng / gặp byte lạ → chờ message sau bắt đầu bằng header hợp lệ rồi đọc tiếp.
 */
export class RdpStreamSniffer {
  /** Byte theo loại (mỗi PDU tính vào loại của update đầu tiên, phần lẻ vào loại gần nhất). */
  readonly bytes = new Map<string, number>()
  private skip = 0
  private synced = false
  /** Header PDU bị cắt ở cuối message trước (≤ 3 byte). */
  private carry: Uint8Array | null = null
  private lastKey = 'other'

  private add(key: string, n: number): void {
    this.bytes.set(key, (this.bytes.get(key) ?? 0) + n)
  }

  push(chunk: Uint8Array): void {
    let buf = chunk
    if (this.carry) {
      buf = new Uint8Array(this.carry.length + chunk.length)
      buf.set(this.carry)
      buf.set(chunk, this.carry.length)
      this.carry = null
    }
    let i = 0
    if (!this.synced) {
      if (!this.plausible(buf, 0)) return
      this.synced = true
      this.skip = 0
    }
    if (this.skip > 0) {
      const n = Math.min(this.skip, buf.length)
      this.add(this.lastKey, n)
      this.skip -= n
      i = n
    }
    while (i < buf.length) {
      const header = this.pduHeader(buf, i)
      if (header === 'short') {
        this.carry = buf.slice(i)
        return
      }
      if (header === null) {
        this.synced = false
        return
      }
      const end = i + header.length
      const body = buf.subarray(i + header.offset, Math.min(buf.length, end))
      const key = header.fastpath ? this.classifyPdu(body) : classifySlowPath(body)
      this.lastKey = key
      const n = Math.min(end, buf.length) - i
      this.add(key, n)
      this.skip = header.length - n
      i += n
    }
  }

  /** Byte đầu message có giống đầu PDU không (dùng khi bắt đầu đọc / đọc lại). */
  private plausible(buf: Uint8Array, at: number): boolean {
    const h = this.pduHeader(buf, at)
    return h !== null && h !== 'short'
  }

  private pduHeader(
    buf: Uint8Array,
    at: number
  ): { length: number; offset: number; fastpath: boolean } | null | 'short' {
    if (buf.length - at < 2) return 'short'
    const b0 = buf[at] ?? 0
    if (b0 === 0x03) {
      if (buf.length - at < 4) return 'short'
      if (buf[at + 1] !== 0) return null
      const length = ((buf[at + 2] ?? 0) << 8) | (buf[at + 3] ?? 0)
      return length >= 7 ? { length, offset: 4, fastpath: false } : null
    }
    // fpOutputHeader: action (2 bit) = 0, 4 bit dành riêng = 0, cờ mã hoá (TLS: không dùng).
    if ((b0 & 0x3) !== 0 || (b0 & 0x3c) !== 0 || (b0 & 0x80) !== 0) return null
    const b1 = buf[at + 1] ?? 0
    if (b1 & 0x80) {
      if (buf.length - at < 3) return 'short'
      const length = ((b1 & 0x7f) << 8) | (buf[at + 2] ?? 0)
      return length >= 4 ? { length, offset: 3, fastpath: true } : null
    }
    return b1 >= 3 ? { length: b1, offset: 2, fastpath: true } : null
  }

  private classifyPdu(data: Uint8Array): string {
    let p = 0
    let first: string | null = null
    // Lấy update có dữ liệu hình đầu tiên (bỏ qua con trỏ / đồng bộ đứng trước).
    while (p < data.length) {
      const h = data[p] ?? 0
      const code = h & 0x0f
      const fragmentation = (h >> 4) & 0x3
      const compression = (h >> 6) & 0x3
      p += 1
      if (compression === FASTPATH_COMPRESSION_USED) p += 1
      if (p + 2 > data.length) break
      const size = (data[p] ?? 0) | ((data[p + 1] ?? 0) << 8)
      p += 2
      const body = data.subarray(p, Math.min(data.length, p + size))
      const isFirst =
        fragmentation === FASTPATH_FRAGMENT_SINGLE || fragmentation === FASTPATH_FRAGMENT_FIRST
      const key = isFirst ? codecKey(classifyUpdate(code, body)) : this.lastKey
      if (key !== 'pointer' && key !== 'other') return key
      first ??= key
      p += size
    }
    return first ?? this.lastKey
  }
}

export interface RdpPerfSnapshot {
  /** Khung hình có vẽ mới mỗi giây (đếm theo requestAnimationFrame). */
  fps: number
  /** Số vùng (putImageData) mỗi giây. */
  updates: number
  /** Thời gian từ lúc nhận dữ liệu tới khi vẽ xong, trung bình mỗi khung hình (ms). */
  frameMs: number
  /** Phần trăm thời gian luồng chính dành cho giải mã + vẽ. */
  busy: number
  inRate: number
  outRate: number
  /** Trung vị độ trễ input (phím / nút chuột / cuộn) → khung hình kế tiếp (ms); null = chưa có. */
  latencyMs: number | null
  /** Loại mã hoá theo tỉ lệ byte, nhiều nhất trước. */
  codecs: { key: string; share: number }[]
}

const LATENCY_SAMPLES = 15
/** Input không kéo theo khung hình nào trong khoảng này → bỏ (vd. gõ vào chỗ không hiện gì). */
const LATENCY_TIMEOUT_MS = 1000

/**
 * Bộ đo của một tab. `track(fn)` bao quanh lúc IronRDP mở WebSocket tới proxy (thay tạm lớp
 * WebSocket để đếm byte); `start(canvas)` / `stop()` bật / tắt phần đo vẽ.
 */
export class RdpPerfMeter {
  private enabled = false
  private inBytes = 0
  private outBytes = 0
  private puts = 0
  private frames = 0
  private busyMs = 0
  private msgAt = 0
  private lastPutEnd = 0
  private inputAt = 0
  private latencies: number[] = []
  private sniffer = new RdpStreamSniffer()
  private ctx: CanvasRenderingContext2D | null = null
  private raf: number | null = null
  private timer: number | null = null
  private lastPuts = 0
  private window = { at: 0, inBytes: 0, outBytes: 0, puts: 0, frames: 0, busyMs: 0 }
  private codecBase = new Map<string, number>()

  constructor(private readonly emit: (snapshot: RdpPerfSnapshot) => void) {}

  get active(): boolean {
    return this.enabled
  }

  /** Chạy `connect` với lớp WebSocket đếm byte cho kết nối tới proxy RDCleanPath. */
  async track<T>(proxyAddress: string, connect: () => Promise<T>): Promise<T> {
    const Original = window.WebSocket as typeof WebSocket | undefined
    if (typeof Original !== 'function') return connect()
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- lớp con cần tham chiếu bộ đo
    const meter = this
    class Counted extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url) !== proxyAddress) return
        this.addEventListener('message', meter.onMessage)
      }
      override send(data: Parameters<WebSocket['send']>[0]): void {
        if (meter.enabled)
          meter.outBytes +=
            typeof data === 'string'
              ? data.length
              : data instanceof Blob
                ? data.size
                : data.byteLength
        super.send(data)
      }
    }
    window.WebSocket = Counted
    try {
      return await connect()
    } finally {
      if (window.WebSocket === Counted) window.WebSocket = Original
    }
  }

  private readonly onMessage = (e: MessageEvent): void => {
    if (!this.enabled) return
    this.settleBusy()
    const data: unknown = e.data
    if (!(data instanceof ArrayBuffer)) return
    this.inBytes += data.byteLength
    this.sniffer.push(new Uint8Array(data))
    // IronRDP giải mã + vẽ ngay trong task này (sau listener của bộ đo).
    this.msgAt = performance.now()
  }

  private settleBusy(): void {
    if (this.msgAt > 0 && this.lastPutEnd > this.msgAt) this.busyMs += this.lastPutEnd - this.msgAt
    this.msgAt = 0
  }

  /** Người dùng vừa gửi input (phím / nút chuột / cuộn) — đo tới khung hình vẽ kế tiếp. */
  noteInput(): void {
    if (this.enabled && this.inputAt === 0) this.inputAt = performance.now()
  }

  start(canvas: HTMLCanvasElement): void {
    if (this.enabled) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    this.enabled = true
    this.ctx = ctx
    this.sniffer = new RdpStreamSniffer()
    this.codecBase = new Map()
    this.latencies = []
    this.inputAt = 0
    // Bọc putImageData của đúng context IronRDP dùng (thuộc tính riêng; tắt thì xoá đi).
    const original = Reflect.get(CanvasRenderingContext2D.prototype, 'putImageData') as (
      this: CanvasRenderingContext2D,
      ...a: unknown[]
    ) => void
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- hàm bọc cần bộ đo
    const meter = this
    Object.defineProperty(ctx, 'putImageData', {
      configurable: true,
      writable: true,
      value: function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        original.apply(this, args)
        meter.onPut()
      }
    })
    this.lastPuts = this.puts
    const tick = (): void => {
      if (this.puts !== this.lastPuts) this.frames++
      this.lastPuts = this.puts
      this.settleBusy()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    this.resetWindow()
    this.timer = window.setInterval(() => {
      this.report()
    }, 500)
  }

  stop(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.ctx) Reflect.deleteProperty(this.ctx, 'putImageData')
    this.ctx = null
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.msgAt = 0
  }

  private onPut(): void {
    const now = performance.now()
    this.puts++
    this.lastPutEnd = now
    if (this.inputAt > 0) {
      const latency = now - this.inputAt
      this.inputAt = 0
      if (latency < LATENCY_TIMEOUT_MS) {
        this.latencies.push(latency)
        if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift()
      }
    }
  }

  private resetWindow(): void {
    this.window = {
      at: performance.now(),
      inBytes: this.inBytes,
      outBytes: this.outBytes,
      puts: this.puts,
      frames: this.frames,
      busyMs: this.busyMs
    }
  }

  private report(): void {
    const now = performance.now()
    if (this.inputAt > 0 && now - this.inputAt > LATENCY_TIMEOUT_MS) this.inputAt = 0
    const w = this.window
    const secs = Math.max(0.001, (now - w.at) / 1000)
    const frames = this.frames - w.frames
    const busy = this.busyMs - w.busyMs
    // Loại mã hoá: tỉ lệ byte trong ~2 giây gần nhất (đổi theo nội dung đang chạy).
    const delta = new Map<string, number>()
    let total = 0
    for (const [key, n] of this.sniffer.bytes) {
      const d = n - (this.codecBase.get(key) ?? 0)
      if (d > 0) {
        delta.set(key, d)
        total += d
      }
    }
    if (total > 0) this.codecBase = new Map(this.sniffer.bytes)
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const snapshot: RdpPerfSnapshot = {
      fps: frames / secs,
      updates: (this.puts - w.puts) / secs,
      frameMs: frames > 0 ? busy / frames : 0,
      busy: (busy / (secs * 1000)) * 100,
      inRate: (this.inBytes - w.inBytes) / secs,
      outRate: (this.outBytes - w.outBytes) / secs,
      latencyMs: sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? null) : null,
      codecs: [...delta]
        .map(([key, n]) => ({ key, share: n / total }))
        .sort((a, b) => b.share - a.share)
    }
    this.lastCodecs = snapshot.codecs.length > 0 ? snapshot.codecs : this.lastCodecs
    this.emit({ ...snapshot, codecs: this.lastCodecs })
    this.resetWindow()
  }

  private lastCodecs: { key: string; share: number }[] = []

  dispose(): void {
    this.stop()
  }
}
