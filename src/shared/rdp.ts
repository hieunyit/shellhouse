import { z } from 'zod'

/**
 * Remote Desktop (RDP): Shellhouse KHÔNG tự cài giao thức RDP mà mở client có sẵn của hệ điều hành
 * (mstsc trên Windows, Windows App trên macOS, FreeRDP / Remmina trên Linux). Mọi trường đi vào
 * file .rdp / argv đều được kiểm ở đây — không ký tự xuống dòng (chèn thêm dòng cấu hình vào .rdp),
 * không bắt đầu bằng '-' (bị hiểu thành tuỳ chọn dòng lệnh).
 */

export const RDP_DEFAULT_PORT = 3389

/**
 * Host (RD Gateway) — cùng quy tắc với `Hostname` trong hosts.ts nhưng khai báo lại ở đây: hosts.ts
 * import file này, import ngược lại sẽ tạo vòng.
 */
const GatewayHost = z
  .string()
  .min(1)
  .max(255, 'The hostname is too long')
  .regex(/^[A-Za-z0-9._:[\]%-]+$/, 'Invalid gateway address')
  .refine((v) => !v.startsWith('-'), 'Hostname must not start with "-"')

/** Tên đăng nhập Windows: cho phép UPN (user@corp.com) và khoảng trắng giữa tên; cấm ký tự Windows cấm. */
export const RdpUsername = z
  .string()
  .min(1, 'Enter a username')
  .max(104, 'The username is too long')
  // eslint-disable-next-line no-control-regex -- chặn đúng ký tự điều khiển
  .regex(/^[^\u0000-\u001f\u007f"/\\[\]:;|=,+*?<>]+$/, 'Invalid username')
  .refine((v) => v.trim() === v, 'The username must not start or end with a space')
  .refine((v) => !v.startsWith('-'), 'Username must not start with "-"')

/** Domain NetBIOS (CORP) hoặc DNS (corp.example.com); "." = tài khoản trên chính máy đích. */
export const RdpDomain = z
  .string()
  .max(255, 'The domain is too long')
  .regex(/^(\.|[A-Za-z0-9][A-Za-z0-9._-]*)$/, 'Invalid domain')

/** Hệ số scale mstsc / FreeRDP chấp nhận (desktopscalefactor, /scale-desktop). */
export const RDP_SCALES = [100, 125, 150, 175, 200, 250, 300] as const
export const RdpScale = z.union(
  RDP_SCALES.map((s) => z.literal(s)) as unknown as [
    z.ZodLiteral<100>,
    z.ZodLiteral<125>,
    ...z.ZodLiteral<(typeof RDP_SCALES)[number]>[]
  ]
)

/** Kích thước cửa sổ gợi ý trong form (vẫn gõ tay được). */
export const RDP_SIZES = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
  [2560, 1440]
] as const

/**
 * Mở host RDP ở đâu: 'tab' = trình xem nhúng trong tab của app (mặc định); 'native' = client RDP
 * của hệ điều hành (mstsc / Windows App / FreeRDP / Remmina).
 */
export const RdpOpenWith = z.enum(['tab', 'native'])
export type RdpOpenWith = z.infer<typeof RdpOpenWith>

export const RdpSettings = z
  .object({
    openWith: RdpOpenWith,
    /** '' = không có domain. */
    domain: RdpDomain.or(z.literal('')),
    fullScreen: z.boolean(),
    width: z.number().int().min(640, 'Width must be at least 640').max(8192),
    height: z.number().int().min(480, 'Height must be at least 480').max(8192),
    /** Dùng mọi màn hình (chỉ có tác dụng khi toàn màn hình). */
    multiMonitor: z.boolean(),
    /** Đổi độ phân giải phiên theo kích thước cửa sổ. */
    dynamicResolution: z.boolean(),
    /** null = theo hệ thống. */
    scale: RdpScale.nullable(),
    clipboard: z.boolean(),
    drives: z.boolean(),
    audio: z.boolean(),
    printers: z.boolean(),
    /** RD Gateway (host[:port]); null = kết nối thẳng. */
    gateway: GatewayHost.nullable(),
    /** Đi qua SSH host đã lưu (forward cổng local → đích); null = kết nối thẳng. */
    viaHostId: z.string().min(1).max(64).nullable()
  })
  .refine((s) => !(s.gateway && s.viaHostId), {
    message: 'Use either an RD Gateway or an SSH tunnel, not both',
    path: ['gateway']
  })
export type RdpSettings = z.infer<typeof RdpSettings>

export const DEFAULT_RDP: RdpSettings = {
  openWith: 'tab',
  domain: '',
  fullScreen: false,
  width: 1920,
  height: 1080,
  multiMonitor: false,
  dynamicResolution: true,
  scale: null,
  clipboard: true,
  drives: false,
  audio: true,
  printers: false,
  gateway: null,
  viaHostId: null
}

/** Client RDP Shellhouse biết mở. `stub` chỉ có khi chạy E2E. */
export const RdpClientKind = z.enum(['mstsc', 'windows-app', 'xfreerdp', 'remmina', 'stub'])
export type RdpClientKind = z.infer<typeof RdpClientKind>

export const RdpClientInfo = z.object({
  kind: RdpClientKind,
  /** Tên hiển thị: "mstsc", "xfreerdp3", "Windows App"… */
  name: z.string()
})
export type RdpClientInfo = z.infer<typeof RdpClientInfo>

/** Kiểm tra trước khi kết nối (chưa mở tunnel, chưa chạy gì). */
export const RdpCheckResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    client: RdpClientInfo,
    /** Client không tự hỏi mật khẩu (FreeRDP chạy nền) và host không lưu mật khẩu → Shellhouse hỏi. */
    askPassword: z.boolean(),
    username: z.string(),
    target: z.object({ host: z.string(), port: z.number().int() }),
    via: z.object({ id: z.string(), label: z.string() }).nullable()
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    /** Cách cài client còn thiếu. */
    hint: z.string().nullable()
  })
])
export type RdpCheckResult = z.infer<typeof RdpCheckResult>

export const RdpLaunchRequest = z.object({
  hostId: z.string().min(1).max(64),
  /** Ghi đè cài đặt của host (menu "Connect full screen"). */
  fullScreen: z.boolean().optional(),
  /** Cổng local của tunnel SSH (127.0.0.1) — chỉ nhận khi host có "Connect through SSH host". */
  tunnelPort: z.number().int().min(1).max(65535).optional(),
  /** Mật khẩu hỏi lúc kết nối (không lưu) — chỉ dùng cho FreeRDP (qua stdin). */
  password: z.string().min(1).max(1024).optional()
})
export type RdpLaunchRequest = z.infer<typeof RdpLaunchRequest>

export const RdpLaunchResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    launchId: z.string(),
    client: RdpClientInfo,
    /**
     * true = Shellhouse giữ tiến trình client (biết khi nào nó thoát, Disconnect đóng được nó);
     * false = đã giao cho ứng dụng khác (macOS `open`, Remmina đang chạy sẵn).
     */
    tracked: z.boolean()
  }),
  z.object({ ok: z.literal(false), message: z.string(), hint: z.string().nullable() })
])
export type RdpLaunchResult = z.infer<typeof RdpLaunchResult>

/** Main → renderer: client RDP đã thoát / đã giao cho ứng dụng khác. */
export const RdpStatusEvent = z.object({
  launchId: z.string(),
  state: z.enum(['exited', 'detached']),
  code: z.number().int().nullable(),
  /** Lỗi đọc được từ client (dòng cuối stderr) khi thoát bất thường. */
  message: z.string().nullable()
})
export type RdpStatusEvent = z.infer<typeof RdpStatusEvent>

/** IPv6 phải nằm trong [] khi ghép với cổng. */
export function hostPort(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${h}:${port}`
}

/** "user@host:port" cho thanh bên / sao chép (cổng 3389 thì bỏ). */
export function rdpAddress(host: {
  hostname: string
  port: number | null
  username: string
}): string {
  const port = host.port ?? RDP_DEFAULT_PORT
  const h = port === RDP_DEFAULT_PORT ? host.hostname : hostPort(host.hostname, port)
  return host.username ? `${host.username}@${h}` : h
}

/** "CORP\john" gõ vào ô username → tách domain; "john@corp.com" (UPN) giữ nguyên. */
export function splitDomainUser(raw: string): { domain: string | null; username: string } {
  const text = raw.trim()
  const i = text.indexOf('\\')
  if (i <= 0 || i === text.length - 1) return { domain: null, username: text }
  return { domain: text.slice(0, i), username: text.slice(i + 1) }
}
