import { t } from '@shared/i18n'
import type {
  RdpNativeEvent,
  RdpNativeOverlay,
  RdpNativePrepare,
  RdpNativeViewport
} from '@shared/rdp-native'
import { RdpTunnel } from '../lib/rdp-tunnel'
import type { ActivePrompt } from '../terminal/controller'

/**
 * Một phiên Remote Desktop bằng control gốc của Windows (tab RdpNativeView): chuẩn bị → tunnel SSH
 * (nếu có, dùng chung cơ chế với client RDP ngoài) → thông tin đăng nhập (nếu chưa lưu) → main chạy
 * tiến trình phụ, gắn cửa sổ control vào vùng tab. Không phụ thuộc React.
 *
 * Chứng chỉ server: hộp thoại xác minh của chính control (như mstsc), không phải TOFU của IronRDP.
 */

export type NativePhase =
  'preparing' | 'tunnel' | 'credentials' | 'connecting' | 'connected' | 'disconnected'

export interface NativeCredentialsRequest {
  username: string
  domain: string
  askUsername: boolean
}

export interface NativeRdpState {
  phase: NativePhase
  label: string
  address: string
  via: string | null
  gateway: string | null
  /** Tiến trình đang làm (kết nối SSH của tunnel…). */
  detail: string | null
  prompt: ActivePrompt | null
  credentials: NativeCredentialsRequest | null
  /** Lý do ngắt; `fallback` = control gốc hỏng → gợi ý mở bằng IronRDP. */
  error: { message: string; fallback: boolean } | null
  userClosed: boolean
  desktop: { width: number; height: number } | null
  connectedAt: number | null
  /** Bàn phím đang ở máy từ xa (control giữ focus) — phím tắt Shellhouse không nhận được. */
  keyboard: boolean
}

export interface NativeTypedCredentials {
  username: string
  domain: string
  password: string
  save: boolean
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

/** Phiên theo sessionId của main — một listener sự kiện cho mọi tab. */
const bySession = new Map<string, NativeRdpController>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  window.shellhouse.onRdpNativeEvent((event: RdpNativeEvent) => {
    bySession.get(event.sessionId)?.handle(event.event)
  })
}

export class NativeRdpController {
  private state: NativeRdpState
  private readonly listeners = new Set<() => void>()
  private sessionId: string | null = null
  private tunnel: RdpTunnel | null = null
  private tunnelPort: number | null = null
  private credentialWaiter: ((typed: NativeTypedCredentials | null) => void) | null = null
  private viewport: RdpNativeViewport | null = null
  private viewportWaiter: (() => void) | null = null
  private lastViewport = ''
  private lastOverlay = ''
  /** Tăng mỗi lần kết nối lại — bước async của lần cũ thấy khác thì dừng. */
  private generation = 0
  private disposed = false

  constructor(
    private readonly hostId: string,
    label: string
  ) {
    this.state = {
      phase: 'preparing',
      label,
      address: '',
      via: null,
      gateway: null,
      detail: null,
      prompt: null,
      credentials: null,
      error: null,
      userClosed: false,
      desktop: null,
      connectedAt: null,
      keyboard: false
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): NativeRdpState => this.state

  private set(change: Partial<NativeRdpState>): void {
    this.state = { ...this.state, ...change }
    for (const l of this.listeners) l()
  }

  get session(): string | null {
    return this.sessionId
  }

  start(): void {
    void this.run(++this.generation)
  }

  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }

  private async run(generation: number): Promise<void> {
    this.set({
      phase: 'preparing',
      detail: null,
      error: null,
      userClosed: false,
      desktop: null,
      connectedAt: null,
      credentials: null,
      keyboard: false
    })
    let prep: RdpNativePrepare
    try {
      prep = await window.shellhouse.rdpNativePrepare(this.hostId)
    } catch (error) {
      if (!this.stale(generation)) this.fail(errorText(error), false)
      return
    }
    if (this.stale(generation)) return
    if (!prep.ok) {
      this.fail(prep.message, false)
      return
    }
    this.set({
      label: prep.label,
      address: prep.address,
      via: prep.via?.label ?? null,
      gateway: prep.gateway
    })

    try {
      // Tunnel SSH: mở một lần, kết nối lại thì dùng lại nếu còn sống.
      let tunnelPort: number | undefined
      if (prep.via) {
        if (!this.tunnel || this.tunnelPort === null) {
          this.set({ phase: 'tunnel', detail: null })
          const via = prep.via
          const tunnel = new RdpTunnel({
            status: (detail) => {
              if (this.tunnel === tunnel && this.state.phase === 'tunnel') this.set({ detail })
            },
            prompt: (prompt) => {
              if (this.tunnel === tunnel) this.set({ prompt })
            },
            lost: (reason) => {
              if (this.tunnel !== tunnel) return
              this.tunnel = null
              this.tunnelPort = null
              this.closeSession()
              if (this.state.phase !== 'disconnected')
                this.fail(
                  t('The SSH tunnel through {via} closed: {reason}', { via: via.label, reason }),
                  false
                )
            }
          })
          this.tunnel = tunnel
          this.tunnelPort = await tunnel.open(via.id, prep.target)
          if (this.stale(generation)) return
          this.set({ prompt: null, detail: null })
        }
        tunnelPort = this.tunnelPort
      }

      let typed: NativeTypedCredentials | null = null
      if (!prep.hasPassword || !prep.username) {
        this.set({
          phase: 'credentials',
          credentials: {
            username: prep.username,
            domain: prep.domain,
            askUsername: !prep.username
          }
        })
        typed = await new Promise<NativeTypedCredentials | null>((resolve) => {
          this.credentialWaiter = resolve
        })
        this.credentialWaiter = null
        if (this.stale(generation)) return
        if (!typed) {
          this.closeTunnel()
          this.set({ phase: 'disconnected', credentials: null, userClosed: true, error: null })
          return
        }
        this.set({ credentials: null })
        if (typed.save)
          void window.shellhouse.setHostPassword(this.hostId, typed.password).catch(() => undefined)
      }

      this.set({ phase: 'connecting', detail: t('Starting the Remote Desktop control…') })
      const viewport = await this.measuredViewport()
      if (this.stale(generation)) return
      const result = await window.shellhouse.rdpNativeOpen({
        hostId: this.hostId,
        viewport,
        ...(tunnelPort !== undefined ? { tunnelPort } : {}),
        ...(typed
          ? {
              username: typed.username,
              domain: typed.domain,
              password: typed.password
            }
          : {})
      })
      typed = null
      if (!result.ok) {
        if (!this.stale(generation)) this.fail(result.message, true)
        return
      }
      if (this.stale(generation)) {
        void window.shellhouse.rdpNativeClose(result.sessionId).catch(() => undefined)
        return
      }
      this.sessionId = result.sessionId
      this.lastViewport = JSON.stringify(viewport)
      this.lastOverlay = ''
      listen()
      bySession.set(result.sessionId, this)
      this.set({ detail: t('Connecting to {address}…', { address: this.state.address }) })
    } catch (error) {
      if (!this.stale(generation)) this.fail(errorText(error), false)
    }
  }

  /** Đợi view đo được vùng tab lần đầu (thường đã có trước khi tới bước này). */
  private measuredViewport(): Promise<RdpNativeViewport> {
    const current = this.viewport
    if (current) return Promise.resolve(current)
    return new Promise((resolve) => {
      this.viewportWaiter = () => {
        if (this.viewport) resolve(this.viewport)
      }
    })
  }

  private fail(message: string, fallback: boolean): void {
    this.closeSession()
    this.set({
      phase: 'disconnected',
      error: { message, fallback },
      prompt: null,
      credentials: null,
      detail: null,
      connectedAt: null,
      keyboard: false
    })
  }

  /** Sự kiện từ main. */
  handle(event: RdpNativeEvent['event']): void {
    switch (event.type) {
      case 'connecting':
        this.set({ detail: t('Connecting to {address}…', { address: this.state.address }) })
        return
      case 'connected':
        this.set({ phase: 'connected', connectedAt: Date.now(), detail: null })
        return
      case 'loginComplete':
        return
      case 'desktopSize':
        this.set({ desktop: { width: event.width, height: event.height } })
        return
      case 'focus':
        this.set({ keyboard: event.focused })
        return
      case 'disconnected': {
        const userClosed = !event.error && this.state.phase === 'connected'
        this.closeSession()
        this.closeTunnel()
        const message = event.message.trim()
        this.set({
          phase: 'disconnected',
          userClosed,
          connectedAt: null,
          keyboard: false,
          error: event.error
            ? {
                message:
                  message || t('The connection failed (code {code})', { code: event.reason }),
                fallback: false
              }
            : // Server / người dùng ở máy từ xa ngắt: vẫn cho đọc lý do (nếu có).
              event.reason === 3 && message
              ? { message, fallback: false }
              : null
        })
        return
      }
      case 'fatal':
        this.fail(event.message, true)
        return
      case 'warning':
      case 'logonError':
        return
    }
  }

  /** View báo vùng tab (CSS px) — gửi main nếu khác lần trước. */
  setViewport(viewport: RdpNativeViewport): void {
    this.viewport = viewport
    this.viewportWaiter?.()
    this.viewportWaiter = null
    const id = this.sessionId
    if (!id) return
    const key = JSON.stringify(viewport)
    if (key === this.lastViewport) return
    this.lastViewport = key
    void window.shellhouse.rdpNativeBounds(id, viewport).catch(() => undefined)
  }

  setOverlay(overlay: RdpNativeOverlay): void {
    const id = this.sessionId
    if (!id) return
    const key = JSON.stringify(overlay)
    if (key === this.lastOverlay) return
    this.lastOverlay = key
    void window.shellhouse.rdpNativeOverlay(id, overlay).catch(() => undefined)
  }

  /** Ảnh chụp màn hình từ xa hiện tại (data URL) để hiện thay khi bị lớp phủ che. */
  async snapshot(): Promise<string | null> {
    const id = this.sessionId
    if (!id || this.state.phase !== 'connected') return null
    try {
      return await window.shellhouse.rdpNativeSnapshot(id)
    } catch {
      return null
    }
  }

  /** Đưa bàn phím vào máy từ xa. */
  focus(): void {
    const id = this.sessionId
    if (id && this.state.phase === 'connected')
      void window.shellhouse.rdpNativeCommand(id, 'focus').catch(() => undefined)
  }

  sendCtrlAltDel(): void {
    const id = this.sessionId
    if (id && this.state.phase === 'connected')
      void window.shellhouse.rdpNativeCommand(id, 'cad').catch(() => undefined)
  }

  submitCredentials(typed: NativeTypedCredentials | null): void {
    this.credentialWaiter?.(typed)
  }

  answerPrompt(id: number, ok: boolean, answers: string[]): void {
    this.tunnel?.answer(id, ok, answers)
  }

  /** Disconnect / Cancel. Đang kết nối: huỷ luôn; đã kết nối: control ngắt rồi báo về. */
  disconnect(): void {
    const id = this.sessionId
    if (id && this.state.phase === 'connected') {
      void window.shellhouse.rdpNativeCommand(id, 'disconnect').catch(() => undefined)
      return
    }
    this.generation++
    this.credentialWaiter?.(null)
    this.closeSession()
    this.closeTunnel()
    this.set({
      phase: 'disconnected',
      userClosed: true,
      error: null,
      prompt: null,
      credentials: null,
      detail: null,
      connectedAt: null,
      keyboard: false
    })
  }

  reconnect(): void {
    this.credentialWaiter?.(null)
    this.closeSession()
    this.start()
  }

  private closeSession(): void {
    const id = this.sessionId
    if (!id) return
    this.sessionId = null
    bySession.delete(id)
    void window.shellhouse.rdpNativeClose(id).catch(() => undefined)
  }

  private closeTunnel(): void {
    const tunnel = this.tunnel
    this.tunnel = null
    this.tunnelPort = null
    tunnel?.close()
  }

  /** Đóng tab: ngắt phiên, tiến trình phụ thoát, đóng tunnel. */
  dispose(): void {
    this.disposed = true
    this.generation++
    this.credentialWaiter?.(null)
    this.closeSession()
    this.closeTunnel()
    this.listeners.clear()
  }
}
