import { t } from '@shared/i18n'
import type { RdpExperience } from '@shared/rdp'
import type { RdpTlsInfo, RdpViewPrepare, RdpViewProbeResult } from '@shared/rdp-viewer'
import type { ActivePrompt } from '../terminal/controller'
import type { IronRdpModule } from './ironrdp'
import { InputCoalescer } from './input'
import { SCANCODE, scancodeOf } from './keymap'
import { RdpPerfMeter, type RdpPerfSnapshot } from './perf'
import { SshTunnel } from './tunnel'

/**
 * Một phiên Remote Desktop trong tab: chuẩn bị (thông tin host) → tunnel SSH (nếu có) → kiểm chứng
 * chỉ TLS của server (TOFU) → thông tin đăng nhập (nếu chưa lưu) → IronRDP (WASM) vẽ lên canvas.
 * Không phụ thuộc React — RdpView chỉ đọc trạng thái và gọi các hàm ở đây.
 */

export type RdpPhase =
  | 'preparing'
  | 'tunnel'
  | 'certificate'
  | 'credentials'
  | 'connecting'
  | 'connected'
  | 'disconnected'

export type RdpScale = 'fit' | 'actual'

export interface RdpCredentialsRequest {
  username: string
  domain: string
  /** Host chưa có username → phải gõ. */
  askUsername: boolean
  /** Lỗi lần trước (sai mật khẩu…). */
  error: string | null
}

export interface RdpViewState {
  phase: RdpPhase
  label: string
  address: string
  via: string | null
  /** Tiến trình đang làm ("Checking the server certificate…"). */
  detail: string | null
  /** Prompt SSH của tunnel (host key, mật khẩu…). */
  prompt: ActivePrompt | null
  probe: RdpViewProbeResult | null
  /** Phiên TLS với server (từ lần dò gần nhất). */
  tls: RdpTlsInfo | null
  credentials: RdpCredentialsRequest | null
  /** Lý do ngắt (phase disconnected); `external` = nên mở bằng client RDP của hệ điều hành. */
  error: { message: string; external: boolean } | null
  /** Ngắt do người dùng (không phải lỗi). */
  userClosed: boolean
  desktop: { width: number; height: number } | null
  clipboard: boolean
  dynamic: boolean
  scale: RdpScale
  connectedAt: number | null
  /** Độ phân giải theo pixel vật lý (HiDPI) — tuỳ chọn của host. */
  hidpi: boolean
  experience: RdpExperience
  /** Bảng đo hiệu năng đang mở (Ctrl+Shift+Alt+P) và số đo gần nhất. */
  perfOpen: boolean
  perf: RdpPerfSnapshot | null
}

/** "TLS 1.3", "TLS 1.2", "TLS 1.2 (RSA)" — chưa rõ thì chỉ "TLS". */
export function tlsLabel(tls: RdpTlsInfo | null): string {
  if (!tls) return 'TLS'
  const version = /^TLSv(\d(?:\.\d)?)$/.exec(tls.protocol)?.[1]
  const base = version ? `TLS ${version}` : 'TLS'
  return tls.legacyRsa ? `${base} (RSA)` : base
}

export interface TypedCredentials {
  username: string
  domain: string
  password: string
  save: boolean
}

/** IronErrorKind của @devolutions/iron-remote-desktop. */
const ErrorKind = {
  General: 0,
  WrongPassword: 1,
  LogonFailure: 2,
  AccessDenied: 3,
  RDCleanPath: 4,
  ProxyConnect: 5,
  NegotiationFailure: 6
} as const

interface IronErrorLike {
  kind(): number
  backtrace(): string
  rdcleanpathDetails?: () =>
    { httpStatusCode?: number; wsaErrorCode?: number; tlsAlertCode?: number } | undefined
}

/** Chờ giữa các lần tự kết nối lại sau khi mất kết nối bất ngờ (hết dãy → báo lỗi). */
const RECONNECT_DELAYS_MS = [2000, 5000, 10000]
/** Phiên sống quá ngưỡng này rồi mới mất → được thử lại từ đầu. */
const RECONNECT_RESET_MS = 60_000

function isIronError(error: unknown): error is IronErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === 'function' &&
    typeof (error as { backtrace?: unknown }).backtrace === 'function'
  )
}

function plainMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export type ConnectFailure =
  { kind: 'auth'; message: string } | { kind: 'certificate' } | { kind: 'other'; message: string }

/** Lỗi của IronRDP → thông báo cho người dùng. */
export function describeConnectError(error: unknown): ConnectFailure {
  if (!isIronError(error)) return { kind: 'other', message: plainMessage(error) }
  const detail = error.backtrace().split('\n')[0]?.trim() ?? ''
  switch (error.kind()) {
    case ErrorKind.WrongPassword:
    case ErrorKind.LogonFailure:
      return { kind: 'auth', message: t('The username or password is incorrect') }
    case ErrorKind.AccessDenied:
      return {
        kind: 'other',
        message: t('Access denied — the account is not allowed to sign in remotely')
      }
    case ErrorKind.RDCleanPath: {
      const d = error.rdcleanpathDetails?.()
      if (d?.tlsAlertCode === 42) return { kind: 'certificate' }
      if (d?.httpStatusCode === 401)
        return { kind: 'other', message: t('The connection request expired — connect again') }
      if (d?.wsaErrorCode !== undefined)
        return {
          kind: 'other',
          message: t('Could not reach the server (socket error {code})', { code: d.wsaErrorCode })
        }
      if (d?.tlsAlertCode !== undefined)
        return {
          kind: 'other',
          message: t('The TLS handshake with the server failed (alert {code})', {
            code: d.tlsAlertCode
          })
        }
      return {
        kind: 'other',
        message: t('The Remote Desktop proxy could not connect: {detail}', { detail })
      }
    }
    case ErrorKind.ProxyConnect:
      return { kind: 'other', message: t('Could not reach the Remote Desktop proxy') }
    case ErrorKind.NegotiationFailure:
      return {
        kind: 'other',
        message: t('The server rejected the connection: {detail}', { detail })
      }
    default:
      return { kind: 'other', message: detail || t('The connection failed') }
  }
}

/**
 * Độ phân giải phiên cho khung tab `width`×`height` (pixel CSS). Mặc định theo pixel CSS: trên màn
 * hình HiDPI (DPR 1.25–2) hình được trình duyệt phóng lên, nhưng server chỉ phải mã hoá / gửi và
 * IronRDP chỉ phải giải mã 1/DPR² số pixel. `hidpi` = pixel vật lý + hệ số scale cho Windows (nét
 * như máy thật, chậm hơn).
 */
export function sessionResolution(
  width: number,
  height: number,
  dpr: number,
  hidpi: boolean
): { width: number; height: number; scale: number | null } {
  const k = hidpi ? Math.min(Math.max(dpr || 1, 1), 4) : 1
  const size = desktopSizeFor(width * k, height * k)
  return { ...size, scale: k > 1 ? Math.min(500, Math.max(100, Math.round(k * 100))) : null }
}

/**
 * Cách phóng canvas lên màn hình: đúng bội số nguyên (DPR 2, 100%) → giữ pixel sắc nét; tỉ lệ lẻ
 * (DPR 1.25 / 1.5, vừa khung) → nội suy mượt, chữ đều nét hơn lặp pixel không đều.
 */
export function imageRendering(
  state: Pick<RdpViewState, 'desktop'>,
  css: { width: number },
  dpr = window.devicePixelRatio || 1
): 'pixelated' | 'auto' {
  const d = state.desktop
  if (!d || d.width === 0) return 'auto'
  const ratio = (css.width * dpr) / d.width
  const whole = Math.round(ratio)
  return whole >= 2 && Math.abs(ratio - whole) < 0.02 ? 'pixelated' : 'auto'
}

/**
 * Kích thước desktop từ khung tab (pixel CSS) trong giới hạn của RDP: cao chẵn, rộng chia hết cho 4
 * — server đệm bitmap cho đủ bội số 4 pixel, ô ở mép phải khi đó rộng hơn khung đích và IronRDP vẽ
 * lệch (xem session-host/rdp/bitmap-fix.ts).
 */
export function desktopSizeFor(width: number, height: number): { width: number; height: number } {
  const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
  const even = (v: number): number => v - (v % 2)
  return {
    width: clamp(Math.floor(width), 640, 8192) & ~3,
    height: even(clamp(Math.floor(height), 480, 8192))
  }
}

type Listener = () => void

interface WasmSession {
  run(): Promise<{ reason(): string }>
  desktopSize(): { width: number; height: number; free?: () => void }
  applyInputs(transaction: unknown): void
  releaseAllInputs(): void
  synchronizeLockKeys(scroll: boolean, num: boolean, caps: boolean, kana: boolean): void
  shutdown(): void
  onClipboardPaste(data: unknown): Promise<void>
  resize(
    width: number,
    height: number,
    scale?: number | null,
    physicalWidth?: number | null,
    physicalHeight?: number | null
  ): void
}

export class RdpController {
  private state: RdpViewState
  private readonly listeners = new Set<Listener>()
  private generation = 0
  private tunnel: SshTunnel | null = null
  private tunnelSession: string | null = null
  private typed: TypedCredentials | null = null
  private session: WasmSession | null = null
  private mod: IronRdpModule | null = null
  private canvas: HTMLCanvasElement | null = null
  private container: HTMLElement | null = null
  private detach: (() => void) | null = null
  private certAnswer: ((ok: boolean) => void) | null = null
  private credAnswer: ((value: TypedCredentials | null) => void) | null = null
  private lastClipboard: string | null = null
  private resizeTimer: number | null = null
  private readonly input = new InputCoalescer({
    move: (x, y) => {
      this.sendMove(x, y)
    },
    wheel: (vertical, amount, unit) => {
      this.sendWheel(vertical, amount, unit)
    }
  })
  private readonly perf = new RdpPerfMeter((perf) => {
    this.set({ perf })
  })
  private disposed = false
  private userClosing = false
  /** Số lần đã tự kết nối lại sau khi mất kết nối bất ngờ (về 0 khi người dùng chủ động kết nối). */
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null

  constructor(
    readonly hostId: string,
    label: string
  ) {
    this.state = {
      phase: 'preparing',
      label,
      address: '',
      via: null,
      detail: null,
      prompt: null,
      probe: null,
      tls: null,
      credentials: null,
      error: null,
      userClosed: false,
      desktop: null,
      clipboard: false,
      dynamic: true,
      scale: 'fit',
      connectedAt: null,
      hidpi: false,
      experience: 'balanced',
      perfOpen: false,
      perf: null
    }
  }

  // ---------- trạng thái ----------

  getState = (): RdpViewState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<RdpViewState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // ---------- DOM ----------

  /** Gắn canvas + khung chứa (khung đổi kích thước → đổi độ phân giải phiên). */
  attach(canvas: HTMLCanvasElement, container: HTMLElement): void {
    this.detach?.()
    this.canvas = canvas
    this.container = container
    // Màn hình từ xa luôn đục: compositor khỏi trộn alpha. Context tạo trước nên IronRDP dùng lại
    // đúng context này (getContext trả context đã có).
    canvas.getContext('2d', { alpha: false })
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void
    ): (() => void) => {
      target.addEventListener(type, fn as EventListener)
      return () => {
        target.removeEventListener(type, fn as EventListener)
      }
    }
    const offs = [
      on(canvas, 'mousemove', (e) => {
        if (this.session) this.input.pointer(e.clientX, e.clientY)
      }),
      on(canvas, 'mousedown', (e) => {
        e.preventDefault()
        canvas.focus({ preventScroll: true })
        this.mouseButton(e.button, true)
      }),
      on(canvas, 'mouseup', (e) => {
        e.preventDefault()
        this.mouseButton(e.button, false)
      }),
      on(canvas, 'contextmenu', (e) => {
        e.preventDefault()
      }),
      on(canvas, 'wheel', (e) => {
        e.preventDefault()
        this.wheel(e)
      }),
      on(canvas, 'keydown', (e) => {
        this.key(e, true)
      }),
      on(canvas, 'keyup', (e) => {
        this.key(e, false)
      }),
      on(canvas, 'focus', () => {
        void this.pushClipboard(false)
      }),
      on(canvas, 'blur', () => {
        this.input.flush()
        this.session?.releaseAllInputs()
      }),
      on(canvas, 'mouseleave', () => {
        // Nút chuột thả ngoài canvas không đến được server → nhả mọi phím / nút.
        if (document.activeElement !== canvas) this.session?.releaseAllInputs()
      })
    ]
    const onWindowBlur = (): void => {
      this.input.flush()
      this.session?.releaseAllInputs()
    }
    window.addEventListener('blur', onWindowBlur)
    const observer = new ResizeObserver(() => {
      this.scheduleResize()
    })
    observer.observe(container)
    // IronRDP tự đặt canvas.width/height khi server đổi độ phân giải (sau Display Control) — theo dõi
    // thuộc tính để cập nhật trạng thái (thanh trạng thái, tỉ lệ vẽ).
    const sizeWatch =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            this.syncCanvasSize()
          })
    sizeWatch?.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] })
    this.detach = () => {
      for (const off of offs) off()
      window.removeEventListener('blur', onWindowBlur)
      observer.disconnect()
      sizeWatch?.disconnect()
      this.detach = null
    }
  }

  // ---------- luồng kết nối ----------

  private stale(gen: number): boolean {
    return this.disposed || gen !== this.generation
  }

  /** Kết nối (hoặc kết nối lại). */
  start(): void {
    this.reconnectAttempts = 0
    this.clearReconnect()
    // Mount lại sau dispose (React StrictMode chạy effect hai lần ở bản dev).
    this.disposed = false
    void this.flow()
  }

  private async flow(): Promise<void> {
    const gen = ++this.generation
    this.stopSession()
    this.userClosing = false
    this.set({
      phase: 'preparing',
      detail: null,
      error: null,
      userClosed: false,
      probe: null,
      tls: null,
      credentials: null,
      desktop: null,
      connectedAt: null
    })
    try {
      const prep: RdpViewPrepare = await window.shellhouse.rdpViewPrepare(this.hostId)
      if (this.stale(gen)) return
      if (!prep.ok) {
        this.fail(prep.message, prep.external)
        return
      }
      this.set({
        label: prep.label,
        address: prep.address,
        via: prep.via?.label ?? null,
        clipboard: prep.clipboard,
        dynamic: prep.dynamicResolution,
        hidpi: prep.hidpi,
        experience: prep.experience
      })

      let viaSessionId: string | undefined
      if (prep.via) {
        if (!this.tunnel?.isOpen || !this.tunnelSession) {
          this.closeTunnel()
          this.set({
            phase: 'tunnel',
            detail: t('Connecting to {via}…', { via: prep.via.label })
          })
          const tunnel = new SshTunnel({
            status: (detail) => {
              if (this.tunnel === tunnel && this.state.phase === 'tunnel') this.set({ detail })
            },
            prompt: (prompt) => {
              if (this.tunnel === tunnel) this.set({ prompt })
            },
            lost: (reason) => {
              if (this.tunnel !== tunnel) return
              this.tunnel = null
              this.tunnelSession = null
              if (this.state.phase !== 'disconnected')
                this.fail(
                  t('The SSH tunnel through {via} closed: {reason}', {
                    via: prep.via?.label ?? '?',
                    reason
                  })
                )
            }
          })
          this.tunnel = tunnel
          this.tunnelSession = await tunnel.open(prep.via.id)
          if (this.stale(gen)) return
        }
        viaSessionId = this.tunnelSession
      }

      this.set({ phase: 'connecting', prompt: null, detail: t('Checking the server certificate…') })
      const probeRequest = { hostId: this.hostId, ...(viaSessionId ? { viaSessionId } : {}) }
      const probe = await window.shellhouse.rdpViewProbe(probeRequest)
      if (this.stale(gen)) return
      this.set({ tls: probe.tls })
      if (probe.status !== 'trusted') {
        this.set({ phase: 'certificate', probe })
        const ok = await new Promise<boolean>((resolve) => {
          this.certAnswer = resolve
        })
        this.certAnswer = null
        if (this.stale(gen)) return
        if (!ok) {
          this.close(t('You did not trust the server certificate'))
          return
        }
        await window.shellhouse.rdpViewTrust(this.hostId, probe.cert.fingerprint)
        if (this.stale(gen)) return
      }

      if (!this.typed && (!prep.username || !prep.hasPassword)) {
        const typed = await this.askCredentials({
          username: prep.username,
          domain: prep.domain,
          askUsername: !prep.username,
          error: null
        })
        if (this.stale(gen)) return
        if (!typed) {
          this.close(t('Connection cancelled'))
          return
        }
        this.typed = typed
      }

      await this.connectDesktop(gen, viaSessionId, prep)
    } catch (error) {
      if (this.stale(gen)) return
      this.failOrRetry(plainMessage(error))
    }
  }

  /** Đang trong chuỗi tự kết nối lại → thử tiếp theo lịch; hết lượt (hoặc kết nối lần đầu) → báo lỗi. */
  private failOrRetry(message: string): void {
    if (this.reconnectAttempts > 0 && this.scheduleReconnect()) return
    this.fail(message)
  }

  private askCredentials(request: RdpCredentialsRequest): Promise<TypedCredentials | null> {
    this.set({ phase: 'credentials', credentials: request, detail: null })
    return new Promise((resolve) => {
      this.credAnswer = resolve
    }).finally(() => {
      this.credAnswer = null
    }) as Promise<TypedCredentials | null>
  }

  private async connectDesktop(
    gen: number,
    viaSessionId: string | undefined,
    prep: Extract<RdpViewPrepare, { ok: true }>
  ): Promise<void> {
    for (;;) {
      this.set({ phase: 'connecting', credentials: null, detail: t('Signing in…') })
      const typed = this.typed
      const opened = await window.shellhouse.rdpViewOpen({
        hostId: this.hostId,
        ...(viaSessionId ? { viaSessionId } : {}),
        ...(typed
          ? {
              ...(typed.username ? { username: typed.username } : {}),
              domain: typed.domain,
              password: typed.password
            }
          : {})
      })
      if (this.stale(gen)) return
      this.set({ detail: t('Starting the Remote Desktop client…') })
      const { loadIronRdp, onIronRdpPanic } = await import('./ironrdp')
      const mod = await loadIronRdp()
      if (this.stale(gen)) return
      this.mod = mod
      const canvas = this.canvas
      if (!canvas) throw new Error('canvas not attached')
      const size = this.initialSize(prep)
      canvas.width = size.width
      canvas.height = size.height
      this.set({ detail: t('Signing in as {user}…', { user: opened.username }) })
      const builder = new mod.Backend.SessionBuilder()
        .username(opened.username)
        .password(opened.password)
        .destination(opened.destination)
        .serverDomain(opened.domain)
        .proxyAddress(opened.proxyAddress)
        .authToken(opened.authToken)
        .desktopSize(new mod.Backend.DesktopSize(size.width, size.height))
        .renderCanvas(canvas)
        .setCursorStyleCallbackContext(this)
        .setCursorStyleCallback(this.onCursor)
        .canvasResizedCallback(() => {
          this.syncDesktopSize()
        })
        .extension(mod.displayControl(true))
      if (this.state.clipboard)
        builder
          .remoteClipboardChangedCallback(this.onRemoteClipboard)
          .forceClipboardUpdateCallback(() => {
            void this.pushClipboard(true)
          })
      let session: WasmSession
      try {
        // Bộ đo hiệu năng đếm byte trên WebSocket IronRDP mở tới proxy.
        session = await this.perf.track(opened.proxyAddress, () => builder.connect())
      } catch (error) {
        if (this.stale(gen)) return
        const failure = describeConnectError(error)
        if (failure.kind === 'certificate') {
          // Chứng chỉ đổi giữa lúc dò và lúc kết nối → dò lại, hỏi lại.
          void this.flow()
          return
        }
        if (failure.kind === 'auth') {
          const again = await this.askCredentials({
            username: typed?.username ?? prep.username,
            domain: typed?.domain ?? prep.domain,
            askUsername: true,
            error: failure.message
          })
          if (this.stale(gen)) return
          if (!again) {
            this.close(t('Connection cancelled'))
            return
          }
          this.typed = again
          continue
        }
        this.failOrRetry(failure.message)
        return
      }
      if (this.stale(gen)) {
        session.shutdown()
        return
      }
      this.session = session
      // Panic của WASM: phiên đứng im mà không báo lỗi → ngắt hẳn, cho kết nối lại.
      const offPanic = onIronRdpPanic((message) => {
        if (this.session !== session) return
        offPanic()
        this.fail(
          t(
            'The Remote Desktop client stopped on an internal error ({detail}). Reconnect to continue.',
            {
              detail: message.replace(/^panicked at /, '')
            }
          )
        )
      })
      this.offPanic = offPanic
      this.syncDesktopSize()
      this.set({ phase: 'connected', detail: null, connectedAt: Date.now(), error: null })
      if (typed?.save && typed.password) {
        void window.shellhouse.setHostPassword(this.hostId, typed.password).catch(() => undefined)
        this.typed = { ...typed, save: false }
      }
      canvas.focus({ preventScroll: true })
      // Kênh Display Control mở sau khi đăng nhập xong — đổi độ phân giải theo khung (HiDPI: kèm
      // hệ số scale).
      window.setTimeout(() => {
        if (this.session === session) this.applyResize()
      }, 1500)
      this.watch(gen, session)
      return
    }
  }

  private watch(gen: number, session: WasmSession): void {
    session.run().then(
      (info) => {
        if (this.session !== session) return
        this.session = null
        const reason = info.reason()
        if (this.userClosing || this.stale(gen)) return
        this.close(reason ? t('The session ended: {reason}', { reason }) : t('The session ended'))
      },
      () => {
        if (this.session !== session) return
        this.session = null
        if (this.userClosing || this.stale(gen)) return
        // Phiên đã sống đủ lâu → lần mất kết nối này không tính vào hạn mức thử lại.
        const since = this.state.connectedAt
        if (since !== null && Date.now() - since > RECONNECT_RESET_MS) this.reconnectAttempts = 0
        if (this.scheduleReconnect()) return
        this.fail(
          this.reconnectAttempts > 0
            ? t(
                'The connection to the server was lost and could not be restored — check the network or the server, then reconnect.'
              )
            : t(
                'The connection to the server was lost — check the network or the server, then reconnect.'
              )
        )
      }
    )
  }

  /** Chờ rồi tự kết nối lại (mất mạng thoáng qua, server khởi động lại). false = hết lượt. */
  private scheduleReconnect(): boolean {
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempts]
    if (delay === undefined) return false
    const attempt = ++this.reconnectAttempts
    const gen = ++this.generation
    this.stopSession()
    this.set({
      phase: 'connecting',
      credentials: null,
      probe: null,
      error: null,
      connectedAt: null,
      detail: t('Connection lost — reconnecting in {seconds}s (attempt {n}/{max})…', {
        seconds: Math.round(delay / 1000),
        n: attempt,
        max: RECONNECT_DELAYS_MS.length
      })
    })
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stale(gen)) void this.flow()
    }, delay)
    return true
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private initialSize(prep: Extract<RdpViewPrepare, { ok: true }>): {
    width: number
    height: number
  } {
    const rect = this.container?.getBoundingClientRect()
    if (!prep.dynamicResolution || !rect || rect.width < 50 || rect.height < 50)
      return desktopSizeFor(prep.width, prep.height)
    // Pixel CSS kể cả khi bật HiDPI: hệ số scale chỉ gửi được qua Display Control (applyResize).
    return desktopSizeFor(rect.width, rect.height)
  }

  /** Canvas theo đúng độ phân giải hiện tại của phiên. */
  private syncDesktopSize(): void {
    const session = this.session
    const canvas = this.canvas
    if (!session || !canvas) return
    const size = session.desktopSize()
    const desktop = { width: size.width, height: size.height }
    size.free?.()
    if (canvas.width !== desktop.width) canvas.width = desktop.width
    if (canvas.height !== desktop.height) canvas.height = desktop.height
    const prev = this.state.desktop
    if (!prev || prev.width !== desktop.width || prev.height !== desktop.height)
      this.set({ desktop })
  }

  private syncCanvasSize(): void {
    const canvas = this.canvas
    if (!canvas || !this.session) return
    const prev = this.state.desktop
    if (prev && prev.width === canvas.width && prev.height === canvas.height) return
    this.set({ desktop: { width: canvas.width, height: canvas.height } })
  }

  private scheduleResize(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null
      this.applyResize()
    }, 400)
  }

  /** Độ phân giải phiên = kích thước khung (pixel CSS; HiDPI: pixel vật lý kèm hệ số scale). */
  private applyResize(): void {
    const session = this.session
    const rect = this.container?.getBoundingClientRect()
    if (!session || !rect || !this.state.dynamic || this.state.scale !== 'fit') return
    if (rect.width < 50 || rect.height < 50) return // tab đang ẩn
    const target = sessionResolution(
      rect.width,
      rect.height,
      window.devicePixelRatio,
      this.state.hidpi
    )
    const current = this.state.desktop
    if (current && current.width === target.width && current.height === target.height) return
    try {
      // Kích thước vật lý của màn hình (mm) không biết → để server tự tính từ hệ số scale.
      if (target.scale !== null) session.resize(target.width, target.height, target.scale)
      else session.resize(target.width, target.height)
    } catch {
      // Server không có Display Control (máy cũ / xrdp) — giữ nguyên, canvas tự co giãn.
    }
  }

  // ---------- người dùng trả lời ----------

  answerCertificate(ok: boolean): void {
    this.certAnswer?.(ok)
  }

  submitCredentials(value: TypedCredentials | null): void {
    this.credAnswer?.(value)
  }

  answerPrompt(id: number, ok: boolean, answers: string[]): void {
    this.tunnel?.answer(id, ok, answers)
  }

  setScale(scale: RdpScale): void {
    this.set({ scale })
    if (scale === 'fit') this.scheduleResize()
  }

  /** Ngắt kết nối (giữ tab, có Reconnect). */
  disconnect(): void {
    this.close(null)
  }

  reconnect(): void {
    this.start()
  }

  private close(message: string | null): void {
    this.clearReconnect()
    this.generation++
    this.certAnswer?.(false)
    this.credAnswer?.(null)
    this.userClosing = true
    this.stopSession()
    this.closeTunnel()
    this.set({
      phase: 'disconnected',
      detail: null,
      prompt: null,
      credentials: null,
      probe: null,
      userClosed: true,
      error: message ? { message, external: false } : null,
      connectedAt: null
    })
  }

  private fail(message: string, external = false): void {
    this.clearReconnect()
    this.generation++
    this.certAnswer?.(false)
    this.credAnswer?.(null)
    this.stopSession()
    this.closeTunnel()
    this.set({
      phase: 'disconnected',
      detail: null,
      prompt: null,
      credentials: null,
      probe: null,
      userClosed: false,
      error: { message, external },
      connectedAt: null
    })
  }

  private offPanic: (() => void) | null = null

  private stopSession(): void {
    const session = this.session
    this.session = null
    this.offPanic?.()
    this.offPanic = null
    this.input.reset()
    if (session) {
      try {
        session.shutdown()
      } catch {
        // đã đóng
      }
    }
    if (this.canvas) this.canvas.style.cursor = 'default'
  }

  private closeTunnel(): void {
    this.tunnel?.close()
    this.tunnel = null
    this.tunnelSession = null
  }

  /** Đóng tab: ngắt phiên, đóng tunnel, quên mật khẩu đã gõ. */
  dispose(): void {
    if (this.disposed) return
    this.userClosing = true
    this.close(null)
    this.disposed = true
    this.typed = null
    this.perf.dispose()
    this.detach?.()
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
  }

  // ---------- input ----------

  private transaction(events: unknown[]): void {
    const session = this.session
    const mod = this.mod
    if (!session || !mod) return
    const tx = new mod.Backend.InputTransaction()
    for (const e of events) tx.addEvent(e as never)
    session.applyInputs(tx)
  }

  /** Vị trí chuột (đã gom theo khung hình) → toạ độ desktop. Một lần đọc layout mỗi khung hình. */
  private sendMove(clientX: number, clientY: number): void {
    const canvas = this.canvas
    const mod = this.mod
    if (!canvas || !mod || !this.session) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = Math.round(((clientX - rect.left) * canvas.width) / rect.width)
    const y = Math.round(((clientY - rect.top) * canvas.height) / rect.height)
    this.transaction([
      mod.Backend.DeviceEvent.mouseMove(
        Math.max(0, Math.min(canvas.width - 1, x)),
        Math.max(0, Math.min(canvas.height - 1, y))
      )
    ])
  }

  private mouseButton(button: number, pressed: boolean): void {
    const mod = this.mod
    if (!mod || button > 4) return
    // Vị trí đang chờ đi trước — server bấm đúng chỗ con trỏ.
    this.input.flush()
    if (pressed) this.perf.noteInput()
    this.transaction([
      pressed
        ? mod.Backend.DeviceEvent.mouseButtonPressed(button)
        : mod.Backend.DeviceEvent.mouseButtonReleased(button)
    ])
  }

  private wheel(e: WheelEvent): void {
    if (!this.session || (e.deltaX === 0 && e.deltaY === 0)) return
    this.perf.noteInput()
    this.input.wheel(e.deltaX, e.deltaY, e.deltaMode)
  }

  private sendWheel(vertical: boolean, amount: number, unit: number): void {
    const mod = this.mod
    if (!mod) return
    // RotationUnit: 0 pixel, 1 line, 2 page — trùng WheelEvent.deltaMode.
    this.transaction([mod.Backend.DeviceEvent.wheelRotations(vertical, -amount, unit)])
  }

  private key(e: KeyboardEvent, pressed: boolean): void {
    // Phím tắt của app đã xử lý (chế độ "giữ phím tắt của Shellhouse") → không gửi.
    if (e.defaultPrevented || !this.session) return
    const code = scancodeOf(e.code)
    e.preventDefault()
    e.stopPropagation()
    if (code === null) return
    const mod = this.mod
    if (!mod) return
    this.input.flush()
    if (pressed) this.perf.noteInput()
    if (pressed && (e.code === 'CapsLock' || e.code === 'NumLock' || e.code === 'ScrollLock'))
      this.session.synchronizeLockKeys(
        e.getModifierState('ScrollLock'),
        e.getModifierState('NumLock'),
        e.getModifierState('CapsLock'),
        false
      )
    this.transaction([
      pressed ? mod.Backend.DeviceEvent.keyPressed(code) : mod.Backend.DeviceEvent.keyReleased(code)
    ])
  }

  private sendCombo(codes: readonly number[]): void {
    const mod = this.mod
    if (!mod || !this.session) return
    this.transaction([
      ...codes.map((c) => mod.Backend.DeviceEvent.keyPressed(c)),
      ...[...codes].reverse().map((c) => mod.Backend.DeviceEvent.keyReleased(c))
    ])
    this.canvas?.focus({ preventScroll: true })
  }

  sendCtrlAltDel(): void {
    this.sendCombo([SCANCODE.ctrl, SCANCODE.alt, SCANCODE.del])
  }

  sendWindowsKey(): void {
    this.sendCombo([SCANCODE.meta])
  }

  sendAltTab(): void {
    this.sendCombo([SCANCODE.alt, SCANCODE.tab])
  }

  focus(): void {
    this.canvas?.focus({ preventScroll: true })
  }

  /** Bật / tắt bảng đo hiệu năng (fps, băng thông, độ trễ…). */
  togglePerf(open = !this.state.perfOpen): void {
    if (open && this.canvas) this.perf.start(this.canvas)
    else this.perf.stop()
    this.set({ perfOpen: open, perf: open ? this.state.perf : null })
  }

  /** Tab bị ẩn / mất focus: nhả mọi phím, nút đang giữ. */
  releaseInputs(): void {
    this.input.flush()
    this.session?.releaseAllInputs()
  }

  // ---------- con trỏ, clipboard ----------

  private readonly onCursor = (
    kind: string,
    data: string | undefined,
    hotspotX: number | undefined,
    hotspotY: number | undefined
  ): void => {
    const canvas = this.canvas
    if (!canvas) return
    if (kind === 'hidden' || kind === 'none') canvas.style.cursor = 'none'
    else if (kind === 'url' && data?.startsWith('data:image/'))
      canvas.style.cursor = `url(${data}) ${Math.round(hotspotX ?? 0)} ${Math.round(hotspotY ?? 0)}, default`
    else canvas.style.cursor = 'default'
  }

  private readonly onRemoteClipboard = (data: {
    items(): { mimeType(): string; value(): unknown }[]
  }): void => {
    if (!this.state.clipboard) return
    for (const item of data.items()) {
      const value = item.value()
      if (item.mimeType().startsWith('text/') && typeof value === 'string') {
        this.lastClipboard = value
        void window.shellhouse.writeClipboard(value).catch(() => undefined)
        return
      }
    }
  }

  /** Gửi clipboard của máy sang server (khi canvas nhận focus / server yêu cầu / bấm nút). */
  async pushClipboard(force: boolean): Promise<boolean> {
    const mod = this.mod
    const session = this.session
    if (!mod || !session || (!this.state.clipboard && !force)) return false
    let text: string
    try {
      text = await window.shellhouse.readClipboard()
    } catch {
      return false
    }
    if (!force && text === this.lastClipboard) return false
    this.lastClipboard = text
    const data = new mod.Backend.ClipboardData()
    if (text) data.addText('text/plain', text)
    await session.onClipboardPaste(data).catch(() => undefined)
    return true
  }
}
