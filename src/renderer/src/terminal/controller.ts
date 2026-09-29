import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type IDisposable } from '@xterm/xterm'
import type { SessionHostStatus } from '@shared/ipc'
import type { ExitReason, PromptRequest, SessionSpec } from '@shared/stream-protocol'
import type { ForwardSpec, ForwardStatus } from '@shared/forwards'
import type { SftpOp, TransferStatus } from '@shared/sftp'
import type { TabTarget } from '../stores/tabs'
import { openSession } from '../lib/sessions'
import type { AppSettings } from '@shared/settings'
import { resolveTheme } from '@shared/themes'
import { useSettings } from '../stores/settings'
import { useAppearance } from '../stores/appearance'
import { isMac, matchCommand } from '../lib/keybindings'
import type { ITerminalOptions } from '@xterm/xterm'
import { useHostStatus } from '../stores/host-status'
import { SessionClient } from './session-client'
import { broadcastInput } from './broadcast'
import { tabTitle } from '@shared/tab-title'
import { windowsPty } from '../lib/platform'

export interface ActivePrompt {
  id: number
  request: PromptRequest
}

export interface ControllerEvents {
  onTitle(title: string): void
  /** Prompt đang chờ người dùng trả lời (null = không có). */
  onPrompt(prompt: ActivePrompt | null): void
  /** Trạng thái các forward đang chạy trên kết nối này. */
  onForwards(list: ForwardStatus[]): void
  onTransfers(list: TransferStatus[]): void
  /** Đã/không còn kết nối SSH tích hợp (bật/tắt các tính năng cần SSH). */
  onConnectedChange(connected: boolean): void
  /** Trạng thái kết nối đổi (hiện chấm trạng thái trên tab / sidebar). */
  onStateChange?(state: TerminalState): void
  /** Chuột phải trong terminal (chế độ "menu") — mở menu tại vị trí chuột. */
  onContextMenu?(x: number, y: number): void
  /** Shell thoát bình thường (code 0) → tab nên đóng. */
  onCleanExit(): void
}

export type TerminalState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited'

/** Backoff tự kết nối lại khi mất mạng (KE-HOACH-MOI.md mục 4.4). */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** JetBrains Mono được nhúng sẵn (styles.css) → terminal trông giống nhau trên mọi OS. */
const DEFAULT_FONT =
  '"JetBrains Mono Variable", ui-monospace, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace'

/** Cài đặt của app → tuỳ chọn xterm.js. */
export function terminalOptions(settings: AppSettings, dark: boolean): ITerminalOptions {
  const t = settings.terminal
  const theme = resolveTheme(t, settings.customThemes, dark)
  return {
    fontFamily: t.fontFamily ? `${t.fontFamily}, ${DEFAULT_FONT}` : DEFAULT_FONT,
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    cursorStyle: t.cursorStyle,
    cursorBlink: t.cursorBlink,
    scrollback: t.scrollback,
    screenReaderMode: t.screenReaderMode,
    // Lệnh xoá màn hình (ED2) đẩy nội dung đang hiện lên scrollback thay vì xoá mất — như Windows
    // Terminal / GNOME. Quan trọng trên Windows: ConPTY xoá màn hình mỗi khi phiên mới bắt đầu.
    scrollOnEraseInDisplay: true,
    theme: theme.colors
  }
}

/** Một tab terminal: xterm.js + session tới Session Host, tự nối lại khi host khởi động lại. */
export class TerminalController {
  readonly term: Terminal
  private readonly fit = new FitAddon()
  readonly search = new SearchAddon()
  private client: SessionClient | null = null
  private state: TerminalState = 'idle'
  /** Tăng mỗi lần bắt đầu kết nối hoặc mất host; kết quả của lần kết nối cũ bị bỏ. */
  private generation = 0
  /** `restarts` của Session Host lúc session hiện tại được mở. */
  private hostEpoch: number | null = null
  private hadSession = false
  /** Đã từng kết nối thành công trong lần kết nối hiện tại → mất mạng thì tự nối lại. */
  private everConnected = false
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private rendererKind: 'webgl' | 'dom' = 'dom'
  private webgl: WebglAddon | null = null
  private webglUnavailable = false
  private visibleInPanel = true
  private inMultiExec = false
  private readonly disposables: IDisposable[] = []
  private resizeObserver: ResizeObserver | null = null
  /** Phần tử đang chứa terminal: container của tab, hoặc một ô của MultiExec. */
  private host: HTMLElement | null = null
  private resizeTimer: number | null = null
  private unsubscribeHost: (() => void) | null = null
  private unsubscribeSettings: (() => void) | null = null
  private echoWaiter: { byte: number; resolve: (t: number) => void } | null = null
  private disposed = false

  private promptQueue: ActivePrompt[] = []

  constructor(
    readonly tabId: string,
    private readonly target: TabTarget,
    private readonly container: HTMLElement,
    private readonly events: ControllerEvents
  ) {
    const conpty = target.kind === 'local' ? windowsPty() : undefined
    this.term = new Terminal({
      allowProposedApi: true, // cần cho unicode11
      ...terminalOptions(useSettings.getState().settings, useAppearance.getState().dark),
      ...(conpty ? { windowsPty: conpty } : {})
    })
  }

  get renderer(): 'webgl' | 'dom' {
    return this.rendererKind
  }

  private setState(state: TerminalState): void {
    if (this.state === state) return
    this.state = state
    this.events.onStateChange?.(state)
  }

  get connectionState(): TerminalState {
    return this.state
  }

  start(): void {
    const term = this.term
    term.loadAddon(this.fit)
    term.loadAddon(this.search)
    // Handler mặc định mở cửa sổ trống rồi mới gán URL — bị main chặn. Gửi thẳng URL để main
    // hỏi xác nhận và mở bằng trình duyệt hệ thống.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener')
      })
    )
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(this.container)
    this.updateRenderer()
    // Gắn vào phần tử của xterm (không phải container) để vẫn chạy khi terminal được chuyển sang
    // ô MultiExec. preventDefault → Electron không hiện menu chỉnh sửa mặc định chồng lên.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (useSettings.getState().settings.terminal.rightClick === 'paste') {
        // Như PuTTY / MobaXterm: có vùng chọn thì copy, không thì dán.
        if (this.term.hasSelection()) this.copySelection()
        else this.pasteFromClipboard()
      } else this.events.onContextMenu?.(e.clientX, e.clientY)
    }
    term.element?.addEventListener('contextmenu', onContextMenu)
    this.disposables.push({
      dispose: () => term.element?.removeEventListener('contextmenu', onContextMenu)
    })

    term.attachCustomKeyEventHandler((event) => this.handleKey(event))
    this.disposables.push(
      term.onData((data) => {
        this.handleInput(data)
      }),
      term.onResize(({ cols, rows }) => {
        this.client?.resize(cols, rows)
      }),
      term.onTitleChange((raw) => {
        const title = tabTitle(raw)
        if (title) this.events.onTitle(title)
      })
    )

    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleFit()
    })
    this.host = this.container
    this.resizeObserver.observe(this.container)
    this.safeFit()

    this.unsubscribeHost = useHostStatus.subscribe((s) => {
      this.handleHostStatus(s.status)
    })
    // Đổi cài đặt / chế độ sáng-tối của hệ thống → áp dụng ngay.
    const apply = (): void => {
      const before = { cols: this.term.cols, rows: this.term.rows }
      Object.assign(
        this.term.options,
        terminalOptions(useSettings.getState().settings, useAppearance.getState().dark)
      )
      this.safeFit()
      if (this.term.cols !== before.cols || this.term.rows !== before.rows)
        this.client?.resize(this.term.cols, this.term.rows)
    }
    this.unsubscribeSettings = useSettings.subscribe(apply)
    this.disposables.push({ dispose: useAppearance.subscribe(apply) })
    this.disposables.push(
      this.term.onSelectionChange(() => {
        if (!useSettings.getState().settings.terminal.copyOnSelect) return
        const text = this.term.getSelection()
        if (text) void window.shellhouse.writeClipboard(text)
      })
    )
    void this.connect()
  }

  activate(): void {
    this.safeFit()
    this.term.focus()
  }

  /**
   * Chuyển terminal sang phần tử khác (ô của MultiExec); null = trả về tab của nó. Chỉ di chuyển
   * DOM của xterm — phiên, scrollback và trạng thái giữ nguyên, không kết nối lại.
   */
  mountIn(target: HTMLElement | null): void {
    const element = this.term.element
    const next = target ?? this.container
    if (this.disposed || !element || this.host === next) return
    next.appendChild(element)
    this.resizeObserver?.disconnect()
    this.resizeObserver?.observe(next)
    this.host = next
    this.inMultiExec = target !== null
    this.updateRenderer()
    this.scheduleFit()
  }

  focus(): void {
    this.term.focus()
  }

  hasSelection(): boolean {
    return this.term.hasSelection()
  }

  /** Copy vùng chọn vào clipboard (qua main — renderer không có quyền clipboard). */
  copySelection(): void {
    const text = this.term.getSelection()
    if (text) void window.shellhouse.writeClipboard(text)
    this.term.focus()
  }

  /** Dán như gõ phím (bracketed paste nếu shell bật) — cũng đi qua MultiExec nếu đang bật. */
  pasteFromClipboard(): void {
    void window.shellhouse.readClipboard().then((text) => {
      if (text) this.term.paste(text)
      this.term.focus()
    })
  }

  selectAll(): void {
    this.term.selectAll()
    this.term.focus()
  }

  /** Xoá màn hình và scrollback (dòng đang gõ giữ lại). */
  clear(): void {
    this.term.clear()
    this.term.focus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeHost?.()
    this.unsubscribeSettings?.()
    this.cancelReconnect()
    this.resizeObserver?.disconnect()
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    for (const d of this.disposables) d.dispose()
    this.client?.close()
    this.client = null
    this.term.dispose()
  }

  startForward(spec: ForwardSpec): void {
    this.client?.startForward(spec)
  }

  /**
   * Chèn văn bản như dán (bracketed paste nếu shell bật): nhiều dòng không bị chạy từng dòng.
   * `run` = gửi thêm Enter.
   */
  insertText(text: string, run: boolean): void {
    if (!this.client) return
    this.term.paste(text)
    if (run) this.client.input('\r')
    this.term.focus()
  }

  deployKey(
    publicKey: string
  ): Promise<{ status: 'added' | 'exists' | 'error'; message: string | null }> {
    if (!this.client) return Promise.resolve({ status: 'error', message: 'Not connected' })
    return this.client.deployKey(publicKey)
  }

  sftp(op: SftpOp): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error('Not connected'))
    return this.client.sftp(op)
  }

  stopForward(id: string): void {
    this.client?.stopForward(id)
  }

  removeForward(id: string): void {
    this.client?.removeForward(id)
  }

  /** Trả lời prompt đang hiển thị. */
  answerPrompt(id: number, ok: boolean, answers: string[]): void {
    this.client?.reply(id, ok, answers)
    this.promptQueue = this.promptQueue.filter((p) => p.id !== id)
    this.emitPrompt()
    if (this.promptQueue.length === 0) this.term.focus()
  }

  // ---------- Test hooks ----------

  sendInput(data: string): void {
    this.client?.input(data)
  }

  async measureEchoLatency(samples: number): Promise<number[]> {
    const results: number[] = []
    for (let i = 0; i < samples; i++) {
      const char = 'x'
      const start = performance.now()
      const drawn = new Promise<number>((resolve) => {
        this.echoWaiter = { byte: char.charCodeAt(0), resolve }
      })
      this.client?.input(char)
      results.push((await drawn) - start)
      this.client?.input('\x7f') // xoá ký tự vừa gõ
      await new Promise((r) => setTimeout(r, 15))
    }
    return results
  }

  // ---------- Nội bộ ----------

  /** Tách thành hàm để TS không thu hẹp kiểu qua `await` (dispose có thể xảy ra trong lúc chờ). */
  private isDisposed(): boolean {
    return this.disposed
  }

  /**
   * WebGL chỉ cho terminal ĐANG HIỂN THỊ. Mỗi WebGL context giữ texture atlas riêng trong tiến trình
   * GPU (~80–90 MB): 10 tab đều giữ context thì GPU process lên ~900 MB (đo trên Windows). Tab ẩn
   * dùng DOM renderer — không vẽ gì khi ẩn nên gần như không tốn; hiện lại thì tạo lại context.
   */
  private updateRenderer(): void {
    if (this.disposed) return
    const wanted = this.visibleInPanel || this.inMultiExec
    if (wanted && !this.webgl && !this.webglUnavailable) this.loadWebgl()
    else if (!wanted && this.webgl) {
      this.webgl.dispose()
      this.webgl = null
      this.rendererKind = 'dom'
    }
  }

  /** Panel của tab có đang hiện trong bố cục không (tab khác cùng nhóm đang được chọn → ẩn). */
  setVisible(visible: boolean): void {
    this.visibleInPanel = visible
    this.updateRenderer()
  }

  private loadWebgl(): void {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        // Mất context (driver, quá nhiều context...) → quay về DOM renderer; hiện lại sẽ thử lại.
        webgl.dispose()
        if (this.webgl === webgl) this.webgl = null
        this.rendererKind = 'dom'
      })
      this.term.loadAddon(webgl)
      this.webgl = webgl
      this.rendererKind = 'webgl'
    } catch {
      // Máy không có WebGL → không thử lại nữa.
      this.webglUnavailable = true
      this.rendererKind = 'dom'
    }
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.state === 'connecting' || this.state === 'connected') return
    this.cancelReconnect()
    const host = useHostStatus.getState().status
    if (host?.state !== 'running') {
      this.setState('disconnected')
      return
    }
    const generation = ++this.generation
    this.setState('connecting')
    try {
      const { sessionId, port } = await openSession(this.specFor())
      if (this.isDisposed() || generation !== this.generation) {
        // Tab đã đóng hoặc host đã khởi động lại trong lúc chờ → bỏ phiên này.
        port.close()
        void window.shellhouse.closeSession(sessionId).catch(() => undefined)
        return
      }
      if (this.hadSession) this.term.write(`${DIM}— new session —${RESET}\r\n`)
      this.hadSession = true
      this.hostEpoch = host.restarts
      this.client = new SessionClient(sessionId, port, {
        write: (data, done) => {
          this.term.write(data, () => {
            done()
            this.resolveEcho(data)
          })
        },
        exit: (code, reason) => {
          this.handleExit(code, reason)
        },
        error: (message) => {
          this.term.write(`\r\n${YELLOW}Error: ${message}${RESET}\r\n`)
        },
        status: (phase, detail) => {
          this.term.write(`${DIM}${detail}${RESET}\r\n`)
          if (phase === 'connected') {
            this.everConnected = true
            this.reconnectAttempt = 0
            if (this.state === 'connecting') this.setState('connected')
            this.events.onConnectedChange(true)
          }
        },
        prompt: (id, request) => {
          this.promptQueue.push({ id, request })
          this.emitPrompt()
        },
        promptCancelled: (id) => {
          this.promptQueue = this.promptQueue.filter((p) => p.id !== id)
          this.emitPrompt()
        },
        forwards: (list) => {
          this.events.onForwards(list)
        },
        transfers: (list) => {
          this.events.onTransfers(list)
        }
      })
      // Local: có shell ngay. SSH: chờ status 'connected' (đã xác thực) mới coi là kết nối.
      if (this.target.kind === 'local') this.setState('connected')
    } catch (error) {
      if (this.isDisposed() || generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      this.term.write(`\r\n${YELLOW}Could not open the session: ${message}${RESET}\r\n`)
      this.setState('disconnected')
    }
  }

  private specFor(): SessionSpec {
    const size = { cols: this.term.cols, rows: this.term.rows }
    if (this.target.kind === 'local')
      return {
        kind: 'local',
        ...size,
        ...(this.target.shellId ? { shellId: this.target.shellId } : {})
      }
    if (this.target.kind === 'host') return { kind: 'host', ...size, hostId: this.target.hostId }
    const { host, port, username } = this.target
    return { kind: 'ssh', ...size, target: { host, port, username } }
  }

  private emitPrompt(): void {
    this.events.onPrompt(this.promptQueue[0] ?? null)
  }

  private clearPrompts(): void {
    if (this.promptQueue.length === 0) return
    this.promptQueue = []
    this.emitPrompt()
  }

  private handleExit(code: number | null, reason: ExitReason): void {
    this.clearPrompts()
    this.events.onConnectedChange(false)
    this.events.onForwards([])
    this.client?.close()
    this.client = null
    if (reason === 'normal' && code === 0) {
      this.setState('exited')
      this.events.onCleanExit()
      return
    }
    // Local: không có "mất mạng"; SSH: chỉ tự nối lại khi đã từng vào được rồi mới rớt.
    if (this.target.kind !== 'local' && reason === 'network' && this.everConnected) {
      this.scheduleReconnect()
      return
    }
    this.everConnected = false
    this.setState('exited')
    this.term.write(
      this.target.kind !== 'local'
        ? `\r\n${YELLOW}[Disconnected — press Enter to reconnect]${RESET}\r\n`
        : `\r\n${YELLOW}[Process exited (code ${code ?? '?'}) — press Enter to restart]${RESET}\r\n`
    )
  }

  private handleHostStatus(host: SessionHostStatus | null): void {
    if (this.disposed || !host) return
    const hostLost =
      host.state !== 'running' || (this.hostEpoch !== null && host.restarts !== this.hostEpoch)
    if (hostLost && (this.state === 'connected' || this.state === 'connecting')) {
      // Port đã chết theo Session Host cũ; bỏ client, giữ scrollback.
      this.generation++
      this.client = null
      this.clearPrompts()
      this.events.onConnectedChange(false)
      this.events.onForwards([])
      this.hostEpoch = null
      this.setState('disconnected')
      this.term.write(`\r\n${YELLOW}— session host is restarting —${RESET}\r\n`)
    }
    if (host.state === 'running' && this.state === 'disconnected') void this.connect()
  }

  private scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
    this.reconnectAttempt++
    this.setState('reconnecting')
    this.term.write(
      `\r\n${YELLOW}[Connection lost — reconnecting in ${Math.round(delay / 1000)} s ` +
        `(attempt ${this.reconnectAttempt}); press Enter to retry now]${RESET}\r\n`
    )
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (this.state === 'reconnecting') {
        this.setState('exited')
        void this.connect()
      }
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private handleInput(data: string): void {
    if ((this.state === 'exited' || this.state === 'reconnecting') && data === '\r') {
      this.setState('exited')
      void this.connect()
      return
    }
    if (broadcastInput(this.tabId, data)) return
    this.client?.input(data)
  }

  /** Trả false để xterm bỏ qua phím (phím tắt của app hoặc copy/paste). */
  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true
    if (matchCommand(event)) return false
    // Ctrl+Insert / Shift+Insert: copy / dán kiểu Windows (PuTTY, MobaXterm, cmd).
    if (event.code === 'Insert' && event.ctrlKey && !event.shiftKey && this.term.hasSelection()) {
      this.copySelection()
      return false
    }
    if (event.code === 'Insert' && event.shiftKey && !event.ctrlKey) {
      this.pasteFromClipboard()
      return false
    }
    const copyPaste = isMac ? event.metaKey && !event.shiftKey : event.ctrlKey && event.shiftKey
    if (!copyPaste) return true
    if (event.code === 'KeyC' && this.term.hasSelection()) {
      this.copySelection()
      return false
    }
    if (event.code === 'KeyV') {
      this.pasteFromClipboard()
      return false
    }
    return true
  }

  private resolveEcho(data: Uint8Array): void {
    const waiter = this.echoWaiter
    if (!waiter || !data.includes(waiter.byte)) return
    this.echoWaiter = null
    requestAnimationFrame(() => {
      waiter.resolve(performance.now())
    })
  }

  private scheduleFit(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null
      this.safeFit()
    }, 30)
  }

  private safeFit(): void {
    if (this.disposed) return
    const { clientWidth, clientHeight } = this.host ?? this.container
    if (clientWidth === 0 || clientHeight === 0) return
    try {
      this.fit.fit()
    } catch {
      // Chưa đo được kích thước ký tự (terminal đang ẩn).
    }
  }
}
