import { randomUUID } from 'node:crypto'
import { t } from '@shared/i18n'
import { hostPort, splitDomainUser, type RdpSettings } from '@shared/rdp'
import {
  clampRect,
  desktopSizeFor,
  disconnectIsError,
  scaleFactorsFor,
  toPhysical,
  type RdpNativeCommand,
  type RdpNativeEvent,
  type RdpNativeOpenRequest,
  type RdpNativeOpenResult,
  type RdpNativeOverlay,
  type RdpNativePrepare,
  type RdpNativeRect,
  type RdpNativeSessionEvent,
  type RdpNativeViewport
} from '@shared/rdp-native'
import type { ResolvedRdp } from '../hosts/service'
import { RdpHelper, type HelperChild, type HelperLog } from './helper'
import { physicalHoles, type HelperConnect, type HelperEvent } from './protocol'

export interface RdpNativeDeps {
  resolve(hostId: string, touch: boolean): ResolvedRdp
  /** Chạy shellhouse-rdp-host.exe với các đối số (không qua shell). */
  spawn(args: string[]): HelperChild
  /** HWND của cửa sổ chính (số thập phân); null = chưa có cửa sổ. */
  parentHandle(): string | null
  /** Kích thước vùng web của cửa sổ theo pixel vật lý (cắt toạ độ renderer gửi). */
  contentSize(): { width: number; height: number } | null
  emit(event: RdpNativeEvent): void
  /** Control trả focus (tổ hợp phím của RDP) → đưa bàn phím về Shellhouse. */
  focusApp(): void
  log: HelperLog
  /** E2E: tiến trình phụ chạy chế độ giả (không tạo control RDP thật). */
  selftest?: boolean
  /** Đợi chừng này sau lần đổi kích thước cuối mới đổi độ phân giải phiên (ms). */
  resizeDelayMs?: number
}

interface Session {
  id: string
  hostId: string
  helper: RdpHelper
  dynamic: boolean
  hostScale: number | null
  viewport: RdpNativeViewport
  /** Pixel vật lý trong cửa sổ cha. */
  rect: RdpNativeRect
  overlay: RdpNativeOverlay
  connected: boolean
  closing: boolean
  /** Desktop đã đặt gần nhất (khỏi gửi lại cùng cỡ). */
  desktop: { width: number; height: number; desktopScale: number } | null
  resizeTimer: ReturnType<typeof setTimeout> | null
  lastBounds: string
  lastRegion: string
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Thông tin host đã giải mã + kiểm tunnel — mật khẩu dispose ngay sau khi dùng. */
function withHost<T>(host: ResolvedRdp, use: (h: ResolvedRdp) => T): T {
  try {
    return use(host)
  } finally {
    host.password?.dispose()
  }
}

/**
 * Lệnh connect cho tiến trình phụ từ cài đặt host + vùng tab. Hàm thuần (test được trên mọi nền
 * tảng). `password` chỉ nằm trong lệnh — `describeCommand` không bao giờ in nó.
 */
export function buildConnect(input: {
  server: string
  port: number
  username: string
  domain: string
  password: string
  settings: RdpSettings
  physical: { width: number; height: number }
  dpr: number
}): HelperConnect {
  const s = input.settings
  const dynamic = s.dynamicResolution
  // Phiên co theo khung: desktop = vùng tab (pixel vật lý). Không: cỡ cố định của host, hình co giãn.
  const size = dynamic
    ? desktopSizeFor(input.physical.width, input.physical.height)
    : desktopSizeFor(s.width, s.height)
  const { desktopScale, deviceScale } = scaleFactorsFor(input.dpr, s.scale)
  return {
    type: 'connect',
    server: input.server,
    port: input.port,
    username: input.username,
    domain: input.domain,
    password: input.password,
    gateway: s.gateway,
    width: size.width,
    height: size.height,
    desktopScale,
    deviceScale,
    colorDepth: 32,
    smartSizing: !dynamic,
    clipboard: s.clipboard,
    drives: s.drives,
    printers: s.printers,
    audioMode: s.audio ? 0 : 2,
    keyboardHookMode: 1,
    authenticationLevel: 2,
    enableCredSsp: true
  }
}

/** Sự kiện của tiến trình phụ → sự kiện gửi renderer (null = không chuyển). */
export function sessionEventOf(event: HelperEvent): RdpNativeSessionEvent | null {
  switch (event.type) {
    case 'connecting':
    case 'connected':
    case 'loginComplete':
      return { type: event.type }
    case 'disconnected':
      return {
        type: 'disconnected',
        reason: event.reason,
        extended: event.extended,
        message: event.message,
        error: disconnectIsError(event.reason)
      }
    case 'warning':
      return { type: 'warning', code: event.code }
    case 'logonError':
      return { type: 'logonError', code: event.code }
    case 'fatalError':
      return {
        type: 'fatal',
        message: t('The Remote Desktop control stopped with error {code}', { code: event.code })
      }
    case 'desktopSize':
      return { type: 'desktopSize', width: event.width, height: event.height }
    case 'focus':
      return { type: 'focus', focused: event.focused }
    case 'error':
      // Chỉ lệnh connect hỏng mới chặn phiên; lệnh khác (cad, resize…) lỗi thì phiên vẫn chạy.
      return event.message.startsWith('connect:')
        ? {
            type: 'fatal',
            message: t('Could not start the connection: {reason}', {
              reason: event.message.slice('connect:'.length).trim()
            })
          }
        : null
    default:
      return null
  }
}

/**
 * Phiên RDP bằng control gốc của Windows: mỗi tab một tiến trình phụ. Main quyết định đích (host
 * đã lưu, cổng tunnel chỉ nhận khi host cấu hình tunnel), giữ mật khẩu, đổi toạ độ renderer gửi
 * sang pixel vật lý và chừa chỗ cho lớp phủ.
 */
export class RdpNativeController {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly deps: RdpNativeDeps) {}

  prepare(hostId: string): RdpNativePrepare {
    let host: ResolvedRdp
    try {
      host = this.deps.resolve(hostId, false)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
    return withHost(host, (h) => ({
      ok: true as const,
      label: h.label,
      address: hostPort(h.host, h.port),
      username: h.username,
      domain: h.settings.domain,
      hasPassword: h.password !== null,
      via: h.via,
      gateway: h.settings.gateway,
      target: { host: h.host, port: h.port }
    }))
  }

  async open(request: RdpNativeOpenRequest): Promise<RdpNativeOpenResult> {
    const parent = this.deps.parentHandle()
    if (!parent) return { ok: false, message: t('The window is not ready yet') }
    let plan: { connect: HelperConnect; settings: RdpSettings; label: string }
    try {
      const host = this.deps.resolve(request.hostId, true)
      plan = withHost(host, (h) => {
        const tunnel = request.tunnelPort
        if (h.via && tunnel === undefined)
          throw new Error(
            t('“{name}” connects through {via} — the SSH tunnel is not open', {
              name: h.label,
              via: h.via.label
            })
          )
        // Không nhận cổng tunnel cho host kết nối thẳng: mật khẩu đã lưu không bị gửi tới một cổng
        // local bất kỳ.
        if (!h.via && tunnel !== undefined)
          throw new Error(t('This host does not use an SSH tunnel'))
        const typed = request.username ? splitDomainUser(request.username) : null
        const username = typed?.username ?? h.username
        const domain = typed?.domain ?? request.domain ?? h.settings.domain
        const password = request.password ?? h.password?.revealString() ?? null
        if (!username) throw new Error(t('Enter a username'))
        if (password === null) throw new Error(t('Enter the password to connect'))
        const physical = this.physicalRect(request.viewport)
        return {
          label: h.label,
          settings: h.settings,
          connect: buildConnect({
            server: tunnel !== undefined ? '127.0.0.1' : h.host,
            port: tunnel ?? h.port,
            username,
            domain,
            password,
            settings: h.settings,
            physical,
            dpr: request.viewport.dpr
          })
        }
      })
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }

    const id = randomUUID()
    let helper: RdpHelper
    try {
      const child = this.deps.spawn([
        `--parent=${parent}`,
        ...(this.deps.selftest ? ['--selftest'] : [])
      ])
      helper = new RdpHelper(
        child,
        {
          event: (event) => {
            this.onHelperEvent(id, event)
          },
          exit: (code, message) => {
            this.onHelperExit(id, code, message)
          }
        },
        this.deps.log
      )
    } catch (error) {
      return {
        ok: false,
        message: t('Could not start the Remote Desktop helper: {reason}', {
          reason: errorMessage(error)
        })
      }
    }
    const session: Session = {
      id,
      hostId: request.hostId,
      helper,
      dynamic: plan.settings.dynamicResolution,
      hostScale: plan.settings.scale,
      viewport: request.viewport,
      rect: this.physicalRect(request.viewport),
      overlay: { mode: 'none' },
      connected: false,
      closing: false,
      desktop: {
        width: plan.connect.width,
        height: plan.connect.height,
        desktopScale: plan.connect.desktopScale
      },
      resizeTimer: null,
      lastBounds: '',
      lastRegion: ''
    }
    this.sessions.set(id, session)
    try {
      const ready = await helper.ready
      this.deps.log.info(
        `RDP native ${id}: ${plan.label} → ${plan.connect.server}:${plan.connect.port} (${ready.control})`
      )
    } catch (error) {
      this.sessions.delete(id)
      helper.kill()
      return {
        ok: false,
        message: t('Could not start the Remote Desktop helper: {reason}', {
          reason: errorMessage(error)
        })
      }
    }
    if (!this.sessions.has(id)) return { ok: false, message: t('Cancelled') }
    this.applyBounds(session)
    this.applyRegion(session)
    helper.send(plan.connect)
    return { ok: true, sessionId: id }
  }

  private physicalRect(viewport: RdpNativeViewport): RdpNativeRect {
    const rect = toPhysical(viewport, viewport.dpr)
    const area = this.deps.contentSize()
    return area ? clampRect(rect, area) : rect
  }

  private applyBounds(s: Session): void {
    const visible = s.viewport.visible && s.rect.width > 0 && s.rect.height > 0
    const key = `${s.rect.x},${s.rect.y},${s.rect.width},${s.rect.height},${visible}`
    if (key === s.lastBounds) return
    s.lastBounds = key
    s.helper.send({ type: 'bounds', ...s.rect, visible })
  }

  /** Vùng vẽ: chưa kết nối / lớp phủ che hẳn → không vẽ; có lỗ → khoét; còn lại → cả vùng. */
  private applyRegion(s: Session): void {
    const holes =
      s.overlay.mode === 'holes' ? physicalHoles(s.overlay.holes, s.viewport.dpr, s.rect) : []
    const mode =
      !s.connected || s.overlay.mode === 'hide' ? 'none' : holes.length > 0 ? 'holes' : 'full'
    const key = mode === 'holes' ? `holes:${JSON.stringify(holes)}` : mode
    if (key === s.lastRegion) return
    s.lastRegion = key
    if (mode === 'holes') s.helper.send({ type: 'region', mode, holes })
    else s.helper.send({ type: 'region', mode })
  }

  /** Đổi độ phân giải phiên theo vùng tab (đợi người dùng kéo xong). */
  private scheduleResize(s: Session): void {
    if (!s.dynamic || !s.connected || !s.viewport.visible) return
    if (s.rect.width < 50 || s.rect.height < 50) return
    if (s.resizeTimer) clearTimeout(s.resizeTimer)
    s.resizeTimer = setTimeout(() => {
      s.resizeTimer = null
      if (!this.sessions.has(s.id) || !s.connected) return
      const size = desktopSizeFor(s.rect.width, s.rect.height)
      const scale = scaleFactorsFor(s.viewport.dpr, s.hostScale)
      const d = s.desktop
      if (
        d &&
        d.width === size.width &&
        d.height === size.height &&
        d.desktopScale === scale.desktopScale
      )
        return
      s.desktop = { ...size, desktopScale: scale.desktopScale }
      s.helper.send({ type: 'resize', ...size, ...scale })
    }, this.deps.resizeDelayMs ?? 400)
    s.resizeTimer.unref()
  }

  bounds(sessionId: string, viewport: RdpNativeViewport): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.viewport = viewport
    s.rect = this.physicalRect(viewport)
    this.applyBounds(s)
    this.applyRegion(s)
    this.scheduleResize(s)
  }

  overlay(sessionId: string, overlay: RdpNativeOverlay): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.overlay = overlay
    this.applyRegion(s)
  }

  /** Ảnh chụp vùng RDP (data URL JPEG) để hiện thay khi lớp phủ che; null = không chụp được. */
  async snapshot(sessionId: string): Promise<string | null> {
    const s = this.sessions.get(sessionId)
    if (!s?.connected) return null
    const reply = await s.helper.request('snapshot')
    if (reply?.type !== 'snapshot' || !reply.ok || !reply.data) return null
    return `data:image/jpeg;base64,${reply.data}`
  }

  command(sessionId: string, command: RdpNativeCommand): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.helper.send({ type: command })
  }

  /** Đóng tab / kết nối lại: ngắt phiên, tiến trình phụ thoát. */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.closing = true
    if (s.resizeTimer) clearTimeout(s.resizeTimer)
    this.sessions.delete(sessionId)
    s.helper.close()
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /** Chỉ cho test: trạng thái thật của cửa sổ native từng phiên. */
  async inspect(): Promise<
    { sessionId: string; hostId: string; state: Extract<HelperEvent, { type: 'state' }> | null }[]
  > {
    return Promise.all(
      [...this.sessions.values()].map(async (s) => {
        const reply = await s.helper.request('query')
        return { sessionId: s.id, hostId: s.hostId, state: reply?.type === 'state' ? reply : null }
      })
    )
  }

  private onHelperEvent(id: string, event: HelperEvent): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (event.type === 'focusReleased') {
      this.deps.focusApp()
      return
    }
    if (event.type === 'error') this.deps.log.warn(`RDP native ${id}: ${event.message}`)
    if (event.type === 'connected') {
      s.connected = true
      this.applyRegion(s)
      // Vùng tab có thể đã đổi trong lúc kết nối.
      this.scheduleResize(s)
    } else if (event.type === 'disconnected') {
      s.connected = false
      this.applyRegion(s)
    }
    const out = sessionEventOf(event)
    if (out) this.deps.emit({ sessionId: id, event: out })
  }

  private onHelperExit(id: string, code: number | null, message: string | null): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    if (s.resizeTimer) clearTimeout(s.resizeTimer)
    if (s.closing) return
    this.deps.log.warn(`RDP native ${id}: helper exited (${code ?? 'signal'})`)
    this.deps.emit({
      sessionId: id,
      event: {
        type: 'fatal',
        message: message
          ? t('The Remote Desktop helper stopped: {reason}', { reason: message.slice(0, 300) })
          : t('The Remote Desktop helper stopped unexpectedly (code {code})', {
              code: code ?? -1
            })
      }
    })
  }
}
