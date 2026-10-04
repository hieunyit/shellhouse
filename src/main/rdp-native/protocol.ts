import { z } from 'zod'
import type { RdpNativeRect } from '@shared/rdp-native'

/**
 * Giao thức main ↔ shellhouse-rdp-host.exe: mỗi dòng một JSON (UTF-8, '\n'). JSON không bao giờ chứa
 * xuống dòng thật trong chuỗi (escape thành \n) nên tách theo dòng là đủ. Tiến trình phụ chỉ nhận
 * lệnh từ stdin (ống của tiến trình cha), không mở cổng mạng nào; stdin đóng = cha đã chết → thoát.
 * Phía Windows: native/rdp-host-win/src (Program.cs, HostForm.cs).
 */

/** Pixel vật lý, tương đối với góc trên trái vùng client của cửa sổ cha. */
interface PhysicalRect {
  x: number
  y: number
  width: number
  height: number
}

export interface HelperConnect {
  type: 'connect'
  server: string
  port: number
  username: string
  domain: string
  /** Chỉ đi qua stdin của tiến trình phụ; không bao giờ ghi log. */
  password: string
  /** RD Gateway (host[:port]); null = không dùng. */
  gateway: string | null
  /** Kích thước desktop ban đầu (pixel vật lý của vùng tab hoặc cỡ cố định của host). */
  width: number
  height: number
  desktopScale: number
  deviceScale: number
  colorDepth: 32
  /** Co giãn hình theo khung (không đổi độ phân giải phiên theo cửa sổ). */
  smartSizing: boolean
  clipboard: boolean
  drives: boolean
  printers: boolean
  /** 0 = phát ở máy này, 2 = không phát. */
  audioMode: 0 | 2
  /** 0 = tổ hợp phím Windows ở máy này, 1 = gửi sang máy từ xa (khi control có focus). */
  keyboardHookMode: 0 | 1 | 2
  /** 2 = cảnh báo khi không xác thực được server (hộp thoại của chính control). */
  authenticationLevel: 0 | 1 | 2
  enableCredSsp: boolean
}

export type HelperCommand =
  | HelperConnect
  | ({ type: 'bounds'; visible: boolean } & PhysicalRect)
  /** 'full' = hiện cả vùng; 'none' = không vẽ gì (vẫn "visible" với Win32); 'holes' = khoét lỗ. */
  | { type: 'region'; mode: 'full' | 'none' }
  | { type: 'region'; mode: 'holes'; holes: PhysicalRect[] }
  | { type: 'resize'; width: number; height: number; desktopScale: number; deviceScale: number }
  | { type: 'focus' }
  | { type: 'cad' }
  | { type: 'disconnect' }
  | { type: 'quit' }
  | { type: 'snapshot'; id: number }
  | { type: 'query'; id: number }

const Int = z.number().int().min(-1_000_000).max(1_000_000)
const Text = (max: number) => z.string().max(max)

export const HelperEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    /** Lớp control đã tạo được (MsRdpClient10NotSafeForScripting…) hoặc "selftest". */
    control: Text(128),
    selftest: z.boolean(),
    hwnd: Text(32),
    version: Text(64)
  }),
  z.object({ type: z.literal('connecting') }),
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('loginComplete') }),
  z.object({
    type: z.literal('disconnected'),
    reason: Int,
    extended: Int,
    message: Text(2048)
  }),
  z.object({ type: z.literal('warning'), code: Int }),
  z.object({ type: z.literal('fatalError'), code: Int }),
  z.object({ type: z.literal('logonError'), code: Int }),
  z.object({ type: z.literal('desktopSize'), width: Int, height: Int }),
  z.object({ type: z.literal('focus'), focused: z.boolean() }),
  /** Người dùng bấm tổ hợp trả focus của control (Ctrl+Alt+mũi tên…). */
  z.object({ type: z.literal('focusReleased'), direction: Int }),
  z.object({
    type: z.literal('snapshot'),
    id: Int,
    ok: z.boolean(),
    /** JPEG base64 (ảnh thay thế khi lớp phủ che vùng RDP). */
    data: z
      .string()
      .max(64 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/=]*$/)
      .optional(),
    width: Int.optional(),
    height: Int.optional(),
    message: Text(1024).optional()
  }),
  z.object({
    type: z.literal('state'),
    id: Int,
    hwnd: Text(32),
    parent: Text(32),
    /** Vị trí thật của cửa sổ (pixel vật lý, tương đối client của cửa sổ cha). */
    x: Int,
    y: Int,
    width: Int,
    height: Int,
    visible: z.boolean(),
    region: Text(16),
    connected: z.boolean(),
    /** Selftest: màu điểm giữa cửa sổ đọc từ màn hình (#RRGGBB) — kiểm cửa sổ thật sự nổi trên web. */
    screenColor: Text(16).optional()
  }),
  /** Lệnh hỏng / không chạy được. */
  z.object({ type: z.literal('error'), message: Text(2048) }),
  z.object({ type: z.literal('log'), level: z.enum(['info', 'warn']), message: Text(2048) })
])
export type HelperEvent = z.infer<typeof HelperEvent>

export function encodeCommand(command: HelperCommand): string {
  return `${JSON.stringify(command)}\n`
}

/** Mô tả lệnh để ghi log — không bao giờ có mật khẩu. */
export function describeCommand(command: HelperCommand): string {
  switch (command.type) {
    case 'connect':
      return (
        `connect ${command.server}:${command.port}` +
        (command.gateway ? ` gateway=${command.gateway}` : '') +
        ` ${command.width}x${command.height}@${command.desktopScale}%` +
        (command.password ? ' (password provided)' : '')
      )
    case 'bounds':
      return `bounds ${command.x},${command.y} ${command.width}x${command.height}${command.visible ? '' : ' hidden'}`
    case 'region':
      return command.mode === 'holes'
        ? `region holes=${command.holes.length}`
        : `region ${command.mode}`
    case 'resize':
      return `resize ${command.width}x${command.height}@${command.desktopScale}%`
    default:
      return command.type
  }
}

/** Dòng dài nhất nhận từ tiến trình phụ (ảnh chụp 8K dạng base64 vẫn lọt). */
export const MAX_LINE = 72 * 1024 * 1024

/**
 * Tách luồng stdout thành từng dòng. Dòng quá dài (tiến trình phụ hỏng) bị bỏ, báo qua `onError`.
 */
export class LineDecoder {
  private buffer = ''
  private skipping = false

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onError: (message: string) => void,
    private readonly maxLine = MAX_LINE
  ) {}

  push(chunk: string): void {
    let data = chunk
    for (;;) {
      const nl = data.indexOf('\n')
      if (nl < 0) {
        if (!this.skipping) this.buffer += data
        if (this.buffer.length > this.maxLine) {
          this.buffer = ''
          this.skipping = true
          this.onError('line too long')
        }
        return
      }
      const piece = data.slice(0, nl)
      data = data.slice(nl + 1)
      if (this.skipping) {
        this.skipping = false
        continue
      }
      const line = (this.buffer + piece).replace(/\r$/, '')
      this.buffer = ''
      if (line.length > this.maxLine) {
        this.onError('line too long')
        continue
      }
      if (line.trim()) this.onLine(line)
    }
  }
}

/** Phân tích một dòng sự kiện; null = không hợp lệ (bỏ qua, ghi log). */
export function parseEvent(line: string): HelperEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = HelperEvent.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Lỗ (CSS px, tương đối vùng tab) → pixel vật lý trong cửa sổ native, đã cắt vào khung. */
export function physicalHoles(
  holes: readonly RdpNativeRect[],
  dpr: number,
  frame: { width: number; height: number }
): PhysicalRect[] {
  const out: PhysicalRect[] = []
  for (const h of holes) {
    const left = Math.max(0, Math.round(h.x * dpr))
    const top = Math.max(0, Math.round(h.y * dpr))
    const right = Math.min(frame.width, Math.round((h.x + h.width) * dpr))
    const bottom = Math.min(frame.height, Math.round((h.y + h.height) * dpr))
    if (right > left && bottom > top)
      out.push({ x: left, y: top, width: right - left, height: bottom - top })
  }
  return out
}
