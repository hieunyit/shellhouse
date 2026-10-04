import { z } from 'zod'
import type { RdpEngine } from './rdp'

/**
 * Remote Desktop trong tab bằng control RDP gốc của Windows (mstscax.dll — MsRdpClient, cùng engine
 * với mstsc / MobaXterm / mRemoteNG). Control chạy trong tiến trình phụ `shellhouse-rdp-host.exe`
 * (native/rdp-host-win), cửa sổ của nó được gắn làm cửa sổ con của BrowserWindow, nằm đè đúng vùng
 * nội dung của tab. Renderer chỉ báo vị trí / kích thước vùng tab (CSS px) và lớp phủ; mật khẩu chỉ
 * đi main → tiến trình phụ.
 *
 * Hợp đồng IPC renderer ↔ main và các phép tính thuần (chọn engine, đổi toạ độ, cỡ phiên).
 */

/** Hình chữ nhật CSS px (renderer) hoặc pixel vật lý (main / tiến trình phụ). */
export const RdpNativeRect = z.object({
  x: z.number().min(-100_000).max(100_000),
  y: z.number().min(-100_000).max(100_000),
  width: z.number().min(0).max(100_000),
  height: z.number().min(0).max(100_000)
})
export type RdpNativeRect = z.infer<typeof RdpNativeRect>

/** Vùng nội dung của tab theo CSS px (tính từ góc trên trái vùng web) + devicePixelRatio. */
export const RdpNativeViewport = RdpNativeRect.extend({
  /** window.devicePixelRatio của renderer — đã gồm hệ số zoom của trang. */
  dpr: z.number().min(0.25).max(8),
  /** Tab đang hiện (không bị ẩn sau tab khác, không cuộn khuất, cửa sổ không thu nhỏ). */
  visible: z.boolean()
})
export type RdpNativeViewport = z.infer<typeof RdpNativeViewport>

export const RdpNativeAvailability = z.object({
  available: z.boolean(),
  /** Lý do không dùng được (đã dịch) — null khi dùng được. */
  reason: z.string().nullable()
})
export type RdpNativeAvailability = z.infer<typeof RdpNativeAvailability>

export const RdpNativePrepare = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    label: z.string(),
    /** host:port để hiển thị. */
    address: z.string(),
    username: z.string(),
    domain: z.string(),
    hasPassword: z.boolean(),
    via: z.object({ id: z.string(), label: z.string() }).nullable(),
    gateway: z.string().nullable(),
    /** Mục tiêu của tunnel SSH (renderer mở forward tới đây). */
    target: z.object({ host: z.string(), port: z.number().int() })
  }),
  z.object({ ok: z.literal(false), message: z.string() })
])
export type RdpNativePrepare = z.infer<typeof RdpNativePrepare>

export const RdpNativeOpenRequest = z.object({
  hostId: z.string().min(1).max(64),
  /** Cổng local của tunnel SSH (127.0.0.1) — chỉ nhận khi host đi qua SSH host. */
  tunnelPort: z.number().int().min(1).max(65535).optional(),
  /** Gõ lúc kết nối (host chưa lưu mật khẩu). Không có = dùng thông tin đã lưu. */
  username: z.string().max(256).optional(),
  domain: z.string().max(255).optional(),
  password: z.string().min(1).max(1024).optional(),
  viewport: RdpNativeViewport
})
export type RdpNativeOpenRequest = z.infer<typeof RdpNativeOpenRequest>

export const RdpNativeOpenResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sessionId: z.uuid() }),
  z.object({ ok: z.literal(false), message: z.string() })
])
export type RdpNativeOpenResult = z.infer<typeof RdpNativeOpenResult>

/**
 * Lớp phủ của app (hộp thoại, menu, toast…) đè lên vùng RDP. Cửa sổ native luôn nằm trên nội dung
 * web nên phải chừa chỗ: 'holes' = khoét lỗ (CSS px, tương đối với vùng tab); 'hide' = ẩn hẳn (vùng
 * tab hiện ảnh chụp thay thế).
 */
export const RdpNativeOverlay = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('hide') }),
  z.object({ mode: z.literal('holes'), holes: z.array(RdpNativeRect).min(1).max(16) })
])
export type RdpNativeOverlay = z.infer<typeof RdpNativeOverlay>

export const RdpNativeCommand = z.enum(['focus', 'cad', 'disconnect'])
export type RdpNativeCommand = z.infer<typeof RdpNativeCommand>

/** Sự kiện của phiên (main → renderer). */
export const RdpNativeSessionEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connecting') }),
  z.object({ type: z.literal('connected') }),
  z.object({ type: z.literal('loginComplete') }),
  z.object({
    type: z.literal('disconnected'),
    reason: z.number().int(),
    extended: z.number().int(),
    /** Mô tả của Windows (GetErrorDescription), theo ngôn ngữ của Windows. */
    message: z.string(),
    /** true = lỗi (không phải người dùng / server chủ động ngắt). */
    error: z.boolean()
  }),
  z.object({ type: z.literal('warning'), code: z.number().int() }),
  z.object({ type: z.literal('logonError'), code: z.number().int() }),
  z.object({ type: z.literal('desktopSize'), width: z.number().int(), height: z.number().int() }),
  /** Bàn phím đang ở máy từ xa (control giữ focus) hay ở Shellhouse. */
  z.object({ type: z.literal('focus'), focused: z.boolean() }),
  /** Tiến trình phụ chết / lỗi nặng của control. */
  z.object({ type: z.literal('fatal'), message: z.string() })
])
export type RdpNativeSessionEvent = z.infer<typeof RdpNativeSessionEvent>

export const RdpNativeEvent = z.object({
  sessionId: z.string(),
  event: RdpNativeSessionEvent
})
export type RdpNativeEvent = z.infer<typeof RdpNativeEvent>

// ——— Logic thuần (test được trên mọi nền tảng) ———

export type RdpEngineChoice = 'native' | 'ironrdp'

/**
 * Chọn engine cho một tab RDP. `override` = người dùng bấm "Open in IronRDP" trên tab này.
 * Control gốc chỉ có trên Windows và khi tiến trình phụ có trong bản cài.
 */
export function chooseRdpEngine(input: {
  platform: string
  nativeAvailable: boolean
  engine: RdpEngine | undefined
  override?: RdpEngineChoice | null
}): RdpEngineChoice {
  if (input.override) return input.override
  if (input.engine === 'ironrdp') return 'ironrdp'
  return input.platform === 'win32' && input.nativeAvailable ? 'native' : 'ironrdp'
}

/**
 * CSS px → pixel vật lý (tương đối với góc vùng web). Làm tròn từng CẠNH (không làm tròn rộng /
 * cao) để hai vùng kề nhau không hở / chồng 1 px ở hệ số scale lẻ (125 %, 150 %).
 */
export function toPhysical(rect: RdpNativeRect, dpr: number): RdpNativeRect {
  const left = Math.round(rect.x * dpr)
  const top = Math.round(rect.y * dpr)
  const right = Math.round((rect.x + rect.width) * dpr)
  const bottom = Math.round((rect.y + rect.height) * dpr)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Cắt hình chữ nhật vào vùng [0, width) × [0, height) (vùng web của cửa sổ). */
export function clampRect(rect: RdpNativeRect, area: { width: number; height: number }) {
  const left = Math.min(Math.max(rect.x, 0), area.width)
  const top = Math.min(Math.max(rect.y, 0), area.height)
  const right = Math.min(Math.max(rect.x + rect.width, 0), area.width)
  const bottom = Math.min(Math.max(rect.y + rect.height, 0), area.height)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Giới hạn của RDP cho kích thước desktop (UpdateSessionDisplaySettings). */
export const RDP_MIN_DESKTOP = 200
export const RDP_MAX_DESKTOP = 8192

/** Kích thước desktop từ xa cho vùng tab (pixel vật lý): rộng chẵn, trong giới hạn của RDP. */
export function desktopSizeFor(width: number, height: number): { width: number; height: number } {
  const clamp = (v: number): number =>
    Math.min(RDP_MAX_DESKTOP, Math.max(RDP_MIN_DESKTOP, Math.floor(v)))
  const w = clamp(width)
  return { width: w - (w % 2), height: clamp(height) }
}

/** Hệ số desktop scale RDP chấp nhận. */
const DESKTOP_SCALES = [100, 125, 150, 175, 200, 250, 300, 400, 500] as const

/**
 * Hệ số scale gửi cho server: theo host (nếu đặt) hoặc theo DPI màn hình (dpr đã gồm zoom của trang
 * — zoom app 110 % thì chữ trên máy từ xa cũng to hơn). Device scale chỉ có 100 / 140 / 180.
 */
export function scaleFactorsFor(
  dpr: number,
  hostScale: number | null
): { desktopScale: number; deviceScale: number } {
  const wanted = hostScale ?? Math.round(dpr * 100)
  let desktopScale: number = DESKTOP_SCALES[0]
  for (const s of DESKTOP_SCALES) if (s <= wanted + 12) desktopScale = s
  const deviceScale = desktopScale >= 200 ? 180 : desktopScale >= 140 ? 140 : 100
  return { desktopScale, deviceScale }
}

/**
 * Lý do ngắt (discReason của OnDisconnected): 1 = ngắt ở máy này (Disconnect), 2 = người dùng ngắt
 * / đăng xuất ở máy từ xa, 3 = server ngắt (admin, phiên khác chiếm…). Còn lại là lỗi (không tới
 * được server, sai mật khẩu, lỗi TLS…).
 */
export function disconnectIsError(reason: number): boolean {
  return reason !== 0 && reason !== 1 && reason !== 2 && reason !== 3
}
