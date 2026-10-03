import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type IDisposable } from '@xterm/xterm'
import type { SessionHostStatus } from '@shared/ipc'
import type { ExitReason, PromptRequest, SessionSpec } from '@shared/stream-protocol'
import type { ForwardSpec, ForwardStatus } from '@shared/forwards'
import type { ServerStats } from '@shared/server-stats'
import type { SftpOp, TransferStatus } from '@shared/sftp'
import { useTabs, type TerminalTarget } from '../stores/tabs'
import { openSession } from '../lib/sessions'
import type { AppSettings } from '@shared/settings'
import { resolveTheme } from '@shared/themes'
import { useSettings } from '../stores/settings'
import { useAppearance } from '../stores/appearance'
import { isMac, matchCommand } from '../lib/keybindings'
import type { ITerminalOptions } from '@xterm/xterm'
import { useHostStatus } from '../stores/host-status'
import { useHosts } from '../stores/hosts'
import { useVault } from '../stores/vault'
import { SessionClient } from './session-client'
import { broadcastInput } from './broadcast'
import { tabTitle } from '@shared/tab-title'
import { looksLikePrompt, MACRO_STEP_TIMEOUT_MS, type MacroStep } from '@shared/macro'
import { loadHistory, recordCommand, suggestRest } from './suggestions'
import { windowsPty } from '../lib/platform'
import { shouldProbe } from '../stores/module-ui'
import { choose } from '../stores/confirm'
import { t, tn } from '@shared/i18n'
import { isMultiline, joinPasteLines, pasteLines } from './paste'
import { createElement } from 'react'

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
  /** Thanh theo dõi server: số liệu mới; null = server không hỗ trợ; undefined = chưa có / tắt. */
  onStats?(stats: ServerStats | null | undefined): void
  onLatency?(ms: number | null | undefined): void
  /** Đã/không còn kết nối SSH tích hợp (bật/tắt các tính năng cần SSH). */
  onConnectedChange(connected: boolean): void
  /** Trạng thái kết nối đổi (hiện chấm trạng thái trên tab / sidebar). */
  onStateChange?(state: TerminalState): void
  /** Chuột phải trong terminal (chế độ "menu") — mở menu tại vị trí chuột. */
  onContextMenu?(x: number, y: number): void
  /** Shell thoát bình thường (code 0) → tab nên đóng. */
  onCleanExit(): void
  /** Module đang tắt có dấu hiệu trên server này (Docker…) — gợi ý bật. */
  onModuleSuggest?(modules: string[]): void
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

const PASTE_PREVIEW_LINES = 8

/**
 * Hỏi trước khi dán văn bản có xuống dòng (chỉ gọi khi chương trình không bật bracketed paste —
 * mỗi \n sẽ chạy lệnh). Một dòng có \n ở cuối vẫn hỏi: nó cũng chạy lệnh ngay, đó chính là rủi ro
 * (copy cả dòng từ trang web) — chỉ đổi lời cho đúng. Focus mặc định ở Cancel: thói quen bấm Enter
 * không được vô hiệu hoá lời cảnh báo.
 */
async function askMultilinePaste(text: string): Promise<string | null> {
  const lines = pasteLines(text)
  const single = lines.length === 1
  const preview = lines.slice(0, PASTE_PREVIEW_LINES)
  const more = lines.length - preview.length
  const choice = await choose({
    title: single
      ? t('Paste and run this command?')
      : tn(lines.length, 'Paste {n} line?', 'Paste {n} lines?'),
    message: single
      ? t('The text ends with a line break, so the command will run immediately when pasted.')
      : t('The text contains line breaks. Each line may run as a command as soon as it is pasted.'),
    details: createElement(
      'pre',
      {
        className:
          'sh-selectable max-h-48 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-fg',
        'data-testid': 'paste-preview'
      },
      preview.map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)).join('\n') +
        (more > 0 ? `\n… ${tn(more, '{n} more line', '{n} more lines')}` : '')
    ),
    testId: 'paste-confirm',
    width: 'max-w-lg',
    choices: [
      { value: 'cancel', label: t('Cancel'), autoFocus: true, testId: 'paste-cancel' },
      {
        value: 'join',
        label: single ? t('Paste without running') : t('Paste as one line'),
        testId: 'paste-join'
      },
      {
        value: 'paste',
        label: single ? t('Paste and run') : t('Paste'),
        variant: 'primary',
        testId: 'paste-ok'
      }
    ]
  })
  if (choice === 'paste') return text
  if (choice === 'join') return joinPasteLines(text)
  return null
}

/** Một tab terminal: xterm.js + session tới Session Host, tự nối lại khi host khởi động lại. */
export class TerminalController {
  readonly term: Terminal
  private readonly fit = new FitAddon()
  readonly search = new SearchAddon()
  /** Giải mã output khi host dùng bảng mã khác UTF-8 (stream: ký tự nhiều byte bị cắt vẫn ghép đúng). */
  private decoder: TextDecoder | null = null
  private client: SessionClient | null = null
  /** Phím gõ khi phiên đang mở (tab vừa tạo) — gửi ngay khi có phiên, không để mất. */
  private pendingInput = ''
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
  /** Lần cuối nhận output (performance.now) — macro chờ output ngừng mới gửi dòng tiếp. */
  private lastOutputAt = 0
  /** Đã từng xem terminal → mọi phiên sau đều mở shell. */
  private shellWanted = false
  /** Phiên hiện tại được mở không kèm shell (tab "Open SFTP") — chỉ khi đó mới cần kết nối lại. */
  private openedWithoutShell = false
  /** Đã yêu cầu session đo số liệu server. */
  private statsOn = false
  private readonly disposables: IDisposable[] = []
  private resizeObserver: ResizeObserver | null = null
  /** Phần tử đang chứa terminal: container của tab, hoặc một ô của MultiExec. */
  private host: HTMLElement | null = null
  private resizeTimer: number | null = null
  private unsubscribeHost: (() => void) | null = null
  private unsubscribeSettings: (() => void) | null = null
  /** Đang chờ vault mở khoá để kết nối lại. */
  private unsubscribeVault: (() => void) | null = null
  private echoWaiter: { byte: number; resolve: (t: number) => void } | null = null
  private disposed = false

  private promptQueue: ActivePrompt[] = []

  constructor(
    readonly tabId: string,
    private readonly target: TerminalTarget,
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
        this.scheduleGhost()
      }),
      term.onScroll(() => {
        this.scheduleGhost()
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
    // Chỉ gán tuỳ chọn THỰC SỰ đổi: mọi thay đổi cài đặt (ẩn thanh bên, phím tắt…) đều gọi tới
    // đây; gán lại `theme` (object mới sau mỗi lần nạp cài đặt) làm xterm dựng lại bảng màu và
    // texture atlas WebGL của MỌI terminal.
    const apply = (): void => {
      const before = { cols: this.term.cols, rows: this.term.rows }
      const next = terminalOptions(useSettings.getState().settings, useAppearance.getState().dark)
      const current = this.term.options as Record<string, unknown>
      let changed = false
      for (const [key, value] of Object.entries(next) as [string, unknown][]) {
        const old = current[key]
        const same =
          key === 'theme' ? JSON.stringify(old ?? {}) === JSON.stringify(value) : old === value
        if (same) continue
        current[key] = value
        changed = true
      }
      if (changed) this.safeFit()
      if (this.term.cols !== before.cols || this.term.rows !== before.rows)
        this.client?.resize(this.term.cols, this.term.rows)
      this.syncStats()
    }
    this.unsubscribeSettings = useSettings.subscribe(apply)
    this.disposables.push({ dispose: useAppearance.subscribe(apply) })
    // Copy khi chọn: selection đổi liên tục lúc kéo chuột → chỉ ghi clipboard (IPC) khi đã ngừng chọn.
    let copyTimer: number | null = null
    this.disposables.push(
      this.term.onSelectionChange(() => {
        if (!useSettings.getState().settings.terminal.copyOnSelect) return
        if (copyTimer !== null) window.clearTimeout(copyTimer)
        copyTimer = window.setTimeout(() => {
          copyTimer = null
          if (this.disposed) return
          const text = this.term.getSelection()
          if (text) void window.shellhouse.writeClipboard(text)
        }, 150)
      }),
      {
        dispose: () => {
          if (copyTimer !== null) window.clearTimeout(copyTimer)
        }
      }
    )
    // Dán từ menu Edit của hệ thống / sự kiện paste của trình duyệt cũng đi qua bước hỏi nhiều dòng.
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void this.pasteText(text)
    }
    term.element?.addEventListener('paste', onPaste, { capture: true })
    this.disposables.push({
      dispose: () => term.element?.removeEventListener('paste', onPaste, { capture: true })
    })
    void this.connect()
  }

  /** Đo lại kích thước; `focus` = false khi terminal đang bị che (tab ở chế độ File manager). */
  activate(focus = true): void {
    this.safeFit()
    if (focus) this.term.focus()
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
    this.syncStats()
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
      if (text) void this.pasteText(text)
      else this.term.focus()
    })
  }

  /**
   * Dán văn bản; nhiều dòng mà chương trình không bật bracketed paste (mỗi dòng sẽ chạy như một
   * lệnh) → hỏi trước (cài đặt "Warn before pasting multiple lines").
   */
  private async pasteText(text: string): Promise<void> {
    let data: string | null = text
    if (
      isMultiline(text) &&
      !this.term.modes.bracketedPasteMode &&
      useSettings.getState().settings.terminal.warnMultilinePaste
    )
      data = await askMultilinePaste(text)
    if (this.disposed) return
    if (data) this.term.paste(data)
    this.term.focus()
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
    this.stopWaitingForUnlock()
    this.cancelReconnect()
    if (this.ghostFrame) cancelAnimationFrame(this.ghostFrame)
    this.hideGhost()
    this.resizeObserver?.disconnect()
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    for (const d of this.disposables) d.dispose()
    this.client?.close()
    this.client = null
    this.releaseWebgl()
    this.term.dispose()
  }

  startForward(spec: ForwardSpec): void {
    this.client?.startForward(spec)
  }

  /**
   * Chèn văn bản như dán (bracketed paste nếu shell bật): nhiều dòng không bị chạy từng dòng.
   * `run` = gửi thêm Enter.
   */
  // ---------- Gợi ý lệnh từ lịch sử (chữ mờ sau con trỏ, → để nhận) ----------

  /** Khoá lịch sử của đích: id host đã lưu, ssh:user@host:port, local:<shell>. */
  private get historyTarget(): string {
    const t = this.target
    if (t.kind === 'host') return t.hostId
    if (t.kind === 'ssh') return `ssh:${t.username}@${t.host}:${t.port}`
    if (t.kind === 'module-terminal') return `module:${t.module}`
    return `local:${t.shellId ?? 'default'}`
  }

  /** Vị trí (tuyệt đối trong buffer) nơi lệnh đang gõ bắt đầu — ngay sau dấu nhắc. */
  private inputStart: { row: number; col: number } | null = null
  /** Chờ phím in được đầu tiên sau Enter / Ctrl+C để ghi nhận vị trí bắt đầu. */
  private awaitingStart = true
  private ghost: HTMLSpanElement | null = null
  private ghostRest: string | null = null
  private ghostFrame = 0

  /** Chỉ cho test: trạng thái gợi ý lệnh hiện tại. */
  suggestionDebug(): unknown {
    const b = this.term.buffer.active
    const row = b.baseY + b.cursorY
    return {
      start: this.inputStart,
      awaitingStart: this.awaitingStart,
      lineBuf: this.lineBuf,
      dirty: this.lineDirty,
      cursor: { row, col: b.cursorX },
      beforeCursor: b.getLine(row)?.translateToString(false, 0, b.cursorX),
      afterCursor: b.getLine(row)?.translateToString(true, b.cursorX),
      typed: this.typedText(true),
      ghost: this.ghostRest,
      on: this.suggestionsOn()
    }
  }

  private suggestionsOn(): boolean {
    return (
      useSettings.getState().settings.terminal.commandSuggestions &&
      !this.inMultiExec &&
      this.term.buffer.active.type === 'normal'
    )
  }

  /** Chữ từ vị trí bắt đầu tới `endCol` của dòng con trỏ (gộp các dòng bị ngắt do quá dài). */
  private typedText(toCursor: boolean): string | null {
    const start = this.inputStart
    if (!start) return null
    const b = this.term.buffer.active
    const cursorRow = b.baseY + b.cursorY
    if (cursorRow < start.row || cursorRow - start.row > 20) return null
    let text = ''
    for (let r = start.row; r <= cursorRow; r++) {
      const line = b.getLine(r)
      if (!line) return null
      if (r > start.row && !line.isWrapped) return null // con trỏ đã sang dòng lệnh khác
      const from = r === start.row ? start.col : 0
      const to = toCursor && r === cursorRow ? b.cursorX : undefined
      text += line.translateToString(!(r < cursorRow), from, to)
    }
    return text
  }

  /** Phím chữ đã gõ từ đầu lệnh (chính xác khi chỉ gõ chữ thường). */
  private lineBuf = ''
  /** Đã dùng Tab / mũi tên / dán… → phải đọc lệnh từ màn hình. */
  private lineDirty = false

  private resetLine(): void {
    this.inputStart = null
    this.awaitingStart = true
    this.lineBuf = ''
    this.lineDirty = false
    this.hideGhost()
  }

  private trackTyping(data: string): void {
    if (data === '\r') {
      this.resolveStart()
      const known = this.inputStart
      const typed = this.lineBuf
      const dirty = this.lineDirty
      const fromRow = this.term.buffer.active.baseY + this.term.buffer.active.cursorY
      this.resetLine()
      if (this.term.buffer.active.type !== 'normal' || (!known && (dirty || !typed))) return
      // Đọc màn hình SAU khi echo về (gõ nhanh / SSH chậm: lúc nhấn Enter phần cuối chưa hiện).
      // Chỉ lưu thứ đã hiện trên màn hình → mật khẩu (không echo) không bao giờ vào lịch sử.
      const target = this.historyTarget
      // Echo có thể tới chậm (SSH xa, zsh / PSReadLine vẽ lại cả dòng, máy bận) → thử lại tới 3 s.
      // Mật khẩu không bao giờ hiện nên sau 3 s bỏ qua — không lưu.
      const attempt = (left: number): void => {
        if (this.disposed) return
        const start = known ?? this.findEchoed(typed, fromRow)
        const shown = start ? this.textFrom(start) : null
        const command = dirty ? shown : typed
        if (shown !== null && command?.trim() && shown.trimEnd().startsWith(command.trimEnd())) {
          recordCommand(target, command)
          // Người dùng có thể đã gõ tiếp trong lúc chờ → tính lại gợi ý.
          this.scheduleGhost()
          return
        }
        if (left > 0)
          window.setTimeout(() => {
            attempt(left - 1)
          }, 150)
      }
      window.setTimeout(() => {
        attempt(20)
      }, 150)
      return
    }
    if (data === '\x03' || data === '\x04' || data === '\x15') {
      if (data === '\x15') {
        this.lineBuf = ''
        return
      }
      this.resetLine()
      return
    }
    const code = data.charCodeAt(0)
    const startsLine = this.awaitingStart && code >= 0x20 && code !== 0x7f
    if (data === '\x7f' || data === '\b') this.lineBuf = this.lineBuf.slice(0, -1)
    else if (!/\p{Cc}/u.test(data)) this.lineBuf += data
    else this.lineDirty = true
    if (startsLine) {
      // Vị trí bắt đầu lệnh được xác định khi chữ đã hiện (resolveStart): gõ nhanh ngay sau Enter
      // thì lúc bấm phím, dấu nhắc mới có thể chưa in ra.
      this.awaitingStart = false
      void loadHistory(this.historyTarget)
    }
  }

  /** Tìm chỗ bắt đầu lệnh: phần đã gõ nằm ở cuối dòng con trỏ (sau dấu nhắc). */
  private resolveStart(): void {
    if (this.inputStart || this.awaitingStart || !this.lineBuf || this.lineDirty) return
    const b = this.term.buffer.active
    const row = b.baseY + b.cursorY
    const line = this.logicalLine(row)
    if (!line) return
    // Lệnh dài / dấu nhắc dài: dòng bị ngắt thành nhiều dòng hiển thị → xét cả dòng logic.
    const offset = (row - line.firstRow) * this.term.cols + b.cursorX
    if (line.text.slice(0, offset).endsWith(this.lineBuf))
      this.inputStart = this.positionAt(line.firstRow, offset - this.lineBuf.length)
  }

  /** Dòng (từ `fromRow` trở xuống vài dòng) kết thúc bằng `typed` → vị trí bắt đầu của nó. */
  private findEchoed(typed: string, fromRow: number): { row: number; col: number } | null {
    const b = this.term.buffer.active
    for (let row = fromRow; row <= Math.min(b.length - 1, fromRow + 3); row++) {
      const line = this.logicalLine(row)
      const text = line?.text.trimEnd() ?? ''
      if (line && text.endsWith(typed))
        return this.positionAt(line.firstRow, text.length - typed.length)
    }
    return null
  }

  /** Dòng logic chứa `row` (gộp các dòng hiển thị bị ngắt do quá dài), mỗi dòng đủ `cols` ô. */
  private logicalLine(row: number): { firstRow: number; text: string } | null {
    const b = this.term.buffer.active
    let first = row
    while (first > 0 && b.getLine(first)?.isWrapped && row - first < 20) first--
    let text = ''
    for (let r = first; r < b.length && r - first <= 20; r++) {
      const line = b.getLine(r)
      if (!line) return null
      if (r > first && !line.isWrapped) break
      text += line.translateToString(false).padEnd(this.term.cols, ' ')
    }
    return { firstRow: first, text }
  }

  private positionAt(firstRow: number, offset: number): { row: number; col: number } {
    const cols = this.term.cols
    return { row: firstRow + Math.floor(offset / cols), col: offset % cols }
  }

  /** Dòng lệnh (logic, gộp dòng bị ngắt) bắt đầu từ `start`, hết dòng. */
  private textFrom(start: { row: number; col: number }): string | null {
    const b = this.term.buffer.active
    let text = ''
    for (let r = start.row; r < b.length && r - start.row <= 20; r++) {
      const line = b.getLine(r)
      if (!line) return null
      if (r > start.row && !line.isWrapped) break
      const next = b.getLine(r + 1)
      text += line.translateToString(!next?.isWrapped, r === start.row ? start.col : 0)
    }
    return text
  }

  private scheduleGhost(): void {
    if (this.ghostFrame) return
    this.ghostFrame = requestAnimationFrame(() => {
      this.ghostFrame = 0
      this.updateGhost()
    })
  }

  private updateGhost(): void {
    this.resolveStart()
    if (this.disposed || !this.suggestionsOn()) {
      this.hideGhost()
      return
    }
    const b = this.term.buffer.active
    // Chỉ khi con trỏ ở cuối phần đã gõ và đang xem đáy màn hình. Chỉ có khoảng trắng sau con trỏ
    // vẫn tính là cuối dòng: readline (bash) in một dấu cách để ép xuống dòng khi dòng vừa đầy.
    const line = b.getLine(b.baseY + b.cursorY)
    const afterCursor = line?.translateToString(true, b.cursorX) ?? ''
    const typed = this.typedText(true)
    const rest =
      typed !== null && afterCursor.trim() === '' && b.viewportY === b.baseY
        ? suggestRest(this.historyTarget, typed)
        : null
    if (!rest) {
      this.hideGhost()
      return
    }
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen || !this.term.element) return
    const cellW = screen.clientWidth / this.term.cols
    const cellH = screen.clientHeight / this.term.rows
    // Chỗ còn lại tới đáy màn hình (gợi ý dài / con trỏ ở mép phải thì tràn sang dòng dưới).
    const room = (this.term.rows - b.cursorY) * this.term.cols - b.cursorX
    if (!this.ghost) {
      this.ghost = document.createElement('span')
      this.ghost.className = 'sh-ghost'
      this.ghost.setAttribute('aria-hidden', 'true')
      this.ghost.dataset['testid'] = 'command-suggestion'
      this.term.element.appendChild(this.ghost)
    }
    const g = this.ghost
    const o = this.term.options
    g.textContent = rest.slice(0, Math.max(0, room))
    // Khối rộng bằng cả dòng terminal, thụt đầu dòng tới con trỏ: chữ tự xuống dòng đúng cột như
    // chữ gõ trong terminal (font đơn cách).
    g.style.left = `${screen.offsetLeft}px`
    g.style.top = `${screen.offsetTop + b.cursorY * cellH}px`
    g.style.width = `${this.term.cols * cellW}px`
    g.style.textIndent = `${b.cursorX * cellW}px`
    g.style.maxHeight = `${(this.term.rows - b.cursorY) * cellH}px`
    g.style.lineHeight = `${cellH}px`
    g.style.fontFamily = o.fontFamily ?? 'monospace'
    g.style.fontSize = `${o.fontSize ?? 14}px`
    g.style.letterSpacing = `${Math.max(0, cellW - this.measureChar(g))}px`
    this.ghostRest = rest
  }

  /** Bề rộng thật của một ký tự trong font terminal (để chữ gợi ý thẳng cột với terminal). */
  private charWidth: { font: string; width: number } | null = null
  private measureChar(g: HTMLElement): number {
    const font = `${g.style.fontSize} ${g.style.fontFamily}`
    if (this.charWidth?.font !== font) {
      const canvas = document.createElement('canvas').getContext('2d')
      let width = 0
      if (canvas) {
        canvas.font = font
        width = canvas.measureText('W'.repeat(20)).width / 20
      }
      this.charWidth = { font, width }
    }
    return this.charWidth.width
  }

  private hideGhost(): void {
    this.ghostRest = null
    this.ghost?.remove()
    this.ghost = null
  }

  /** Đang chạy macro (Ctrl+C trong tab thì dừng). */
  private macro: { cancelled: boolean } | null = null

  get macroRunning(): boolean {
    return this.macro !== null
  }

  /** Dòng đang có con trỏ (đã bỏ khoảng trắng cuối). */
  private cursorLineText(): string {
    const b = this.term.buffer.active
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? ''
  }

  /** Vài dòng cuối màn hình (để `# expect`). */
  private screenTail(lines = 8): string {
    const b = this.term.buffer.active
    const out: string[] = []
    for (let i = Math.max(0, b.baseY + b.cursorY - lines + 1); i <= b.baseY + b.cursorY; i++)
      out.push(b.getLine(i)?.translateToString(true) ?? '')
    return out.join('\n')
  }

  /**
   * Chạy macro: gửi từng dòng, chờ dấu nhắc lệnh (output ngừng + dòng cuối giống dấu nhắc) rồi mới
   * gửi dòng tiếp. Dừng khi Ctrl+C, mất kết nối, hoặc quá thời gian chờ một bước.
   */
  async runMacro(steps: readonly MacroStep[]): Promise<void> {
    if (this.macro) throw new Error(t('A macro is already running in this tab'))
    const run = { cancelled: false }
    this.macro = run
    // Đọc qua hàm: `cancelled` đổi từ nơi khác (Ctrl+C) trong lúc chờ — TS không được thu hẹp kiểu.
    const cancelled = (): boolean => run.cancelled
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const stop = (why: string): void => {
      this.term.write(`\r\n${YELLOW}[${t('Macro stopped: {reason}', { reason: why })}]${RESET}\r\n`)
    }
    const waitFor = async (done: () => boolean, what: string): Promise<boolean> => {
      const deadline = Date.now() + MACRO_STEP_TIMEOUT_MS
      for (;;) {
        if (cancelled() || !this.client) return false
        if (done()) return true
        if (Date.now() > deadline) {
          stop(
            t('no {what} after {seconds} s', {
              what,
              seconds: String(MACRO_STEP_TIMEOUT_MS / 1000)
            })
          )
          return false
        }
        await sleep(100)
      }
    }
    try {
      for (const [i, step] of steps.entries()) {
        if (cancelled() || !this.client) return
        if (step.kind === 'wait') {
          const until = Date.now() + step.ms
          while (Date.now() < until && !cancelled()) await sleep(Math.min(100, until - Date.now()))
          continue
        }
        if (step.kind === 'expect') {
          if (!(await waitFor(() => this.screenTail().includes(step.text), `“${step.text}”`)))
            return
          continue
        }
        // Chờ dấu nhắc TRƯỚC khi gửi (bước đầu: phiên có thể còn đang in banner).
        const quiet = (): boolean => performance.now() - this.lastOutputAt > 300
        if (!(await waitFor(() => quiet() && looksLikePrompt(this.cursorLineText()), t('prompt'))))
          return
        this.client.input(`${step.line}\r`)
        // Chờ lệnh bắt đầu in (echo) trước khi xét dấu nhắc lần sau.
        await sleep(i === steps.length - 1 ? 0 : 150)
      }
    } finally {
      if (cancelled()) stop(t('cancelled'))
      this.macro = null
    }
  }

  cancelMacro(): void {
    if (this.macro) this.macro.cancelled = true
  }

  insertText(text: string, run: boolean): void {
    if (!this.client) return
    this.term.paste(text)
    if (run) this.client.input('\r')
    this.term.focus()
  }

  deployKey(
    publicKey: string
  ): Promise<{ status: 'added' | 'exists' | 'error'; message: string | null }> {
    if (!this.client) return Promise.resolve({ status: 'error', message: t('Not connected') })
    return this.client.deployKey(publicKey)
  }

  sftp(op: SftpOp): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error(t('Not connected')))
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
    if (this.client) this.client.input(data)
    else if (this.state === 'idle' || this.state === 'connecting')
      this.pendingInput = (this.pendingInput + data).slice(-64 * 1024)
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
  /**
   * Thanh theo dõi server chỉ đo khi tab SSH đang hiện (không phải ô MultiExec) và cài đặt bật —
   * tab ẩn không chạy vòng lặp trên server.
   */
  private syncStats(): void {
    const on =
      this.target.kind !== 'local' &&
      this.target.kind !== 'module-terminal' &&
      this.visibleInPanel &&
      !this.inMultiExec &&
      useSettings.getState().settings.terminal.serverStats
    if (on === this.statsOn || !this.client) return
    this.statsOn = on
    this.client.setStats(on)
    if (!on) {
      this.events.onStats?.(undefined)
      this.events.onLatency?.(undefined)
    }
  }

  private updateRenderer(): void {
    if (this.disposed) return
    const wanted = this.visibleInPanel || this.inMultiExec
    if (wanted && !this.webgl && !this.webglUnavailable) this.loadWebgl()
    else if (!wanted) this.releaseWebgl()
  }

  /**
   * xterm không tự giải phóng WebGL context khi dispose → GPU giữ bộ nhớ tới lúc GC dọn canvas.
   * Chủ động "lose context" để trả bộ nhớ GPU ngay (ẩn tab và đóng tab).
   */
  private releaseWebgl(): void {
    if (!this.webgl) return
    const canvases = [...(this.term.element?.querySelectorAll('canvas') ?? [])]
    this.webgl.dispose()
    this.webgl = null
    this.rendererKind = 'dom'
    for (const canvas of canvases) {
      const gl = canvas.getContext('webgl2')
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }

  /** Panel của tab có đang hiện trong bố cục không (tab khác cùng nhóm đang được chọn → ẩn). */
  setVisible(visible: boolean): void {
    this.visibleInPanel = visible
    this.updateRenderer()
    this.syncStats()
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
      if (this.hadSession) this.term.write(`${DIM}— ${t('new session')} —${RESET}\r\n`)
      this.hadSession = true
      this.hostEpoch = host.restarts
      this.client = new SessionClient(sessionId, port, {
        write: (data, done) => {
          this.lastOutputAt = performance.now()
          const decoder = this.outputDecoder()
          this.term.write(decoder ? decoder.decode(data, { stream: true }) : data, () => {
            done()
            this.resolveEcho(data)
            this.scheduleGhost()
          })
        },
        exit: (code, reason) => {
          this.handleExit(code, reason)
        },
        error: (message) => {
          this.term.write(`\r\n${YELLOW}${t('Error: {message}', { message })}${RESET}\r\n`)
        },
        status: (phase, detail) => {
          this.term.write(`${DIM}${detail}${RESET}\r\n`)
          if (phase === 'connected') {
            this.everConnected = true
            this.reconnectAttempt = 0
            if (this.state === 'connecting') this.setState('connected')
            this.events.onConnectedChange(true)
            // SSH tích hợp tới host thật: dò nhẹ dấu hiệu module (Docker…) — mỗi host 7 ngày một lần.
            if (
              (this.target.kind === 'host' || this.target.kind === 'ssh') &&
              shouldProbe(this.historyTarget)
            )
              this.client?.probeModules()
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
        },
        moduleSuggest: (modules) => {
          this.events.onModuleSuggest?.(modules)
        },
        stats: (stats) => {
          this.events.onStats?.(stats)
        },
        latency: (ms) => {
          this.events.onLatency?.(ms)
        }
      })
      // Local: có shell ngay. SSH: chờ status 'connected' (đã xác thực) mới coi là kết nối.
      if (this.target.kind === 'local') this.setState('connected')
      this.statsOn = false
      this.syncStats()
      if (this.pendingInput) {
        this.client.input(this.pendingInput)
        this.pendingInput = ''
      }
    } catch (error) {
      this.pendingInput = ''
      if (this.isDisposed() || generation !== this.generation) return
      const message = (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+': (\w*Error: )?/,
        ''
      )
      this.setState('disconnected')
      // Vault khoá (tự khoá khi máy rảnh) → không lấy được mật khẩu đã lưu. Chờ mở khoá rồi tự nối.
      if (/vault is locked/i.test(message)) {
        this.term.write(
          `\r\n${YELLOW}[${t('The vault is locked — unlock it and this tab reconnects')}]${RESET}\r\n`
        )
        this.waitForUnlock()
        return
      }
      this.term.write(
        `\r\n${YELLOW}${t('Could not open the session: {message}', { message })}${RESET}\r\n`
      )
      // Đang tự nối lại sau khi mất mạng mà mở phiên cũng hỏng → tiếp tục backoff, không dừng ở
      // lần thử đầu tiên.
      if (this.target.kind !== 'local' && this.everConnected) this.scheduleReconnect()
    }
  }

  private waitForUnlock(): void {
    this.stopWaitingForUnlock()
    this.unsubscribeVault = useVault.subscribe((s) => {
      if (s.state !== 'unlocked') return
      this.stopWaitingForUnlock()
      if (this.state === 'disconnected' || this.state === 'exited') void this.connect()
    })
  }

  private stopWaitingForUnlock(): void {
    this.unsubscribeVault?.()
    this.unsubscribeVault = null
  }

  /**
   * Kết nối lại ngay (menu chuột phải của tab / phím tắt): bỏ phiên hiện tại nếu còn, mở phiên
   * mới — scrollback giữ nguyên. Tab local: khởi động lại shell.
   */
  reconnect(): void {
    if (this.disposed) return
    this.cancelReconnect()
    this.stopWaitingForUnlock()
    if (this.client) {
      this.generation++
      this.client.close()
      this.client = null
      this.statsOn = false
      this.clearPrompts()
      this.events.onConnectedChange(false)
      this.events.onForwards([])
      this.events.onStats?.(undefined)
    }
    this.setState('exited')
    void this.connect()
  }

  private specFor(): SessionSpec {
    const size = { cols: this.term.cols, rows: this.term.rows }
    if (this.target.kind === 'local')
      return {
        kind: 'local',
        ...size,
        ...(this.target.shellId ? { shellId: this.target.shellId } : {})
      }
    if (this.target.kind === 'module-terminal') {
      // Shell vào container / pod: qua kết nối SSH tới host đã lưu, hoặc phiên module trên máy này.
      const { module, params, hostId } = this.target
      return hostId
        ? { kind: 'host', ...size, hostId, moduleTerminal: { module, params } }
        : { kind: 'module', module, sessionKind: 'terminal', ...size, params, terminal: params }
    }
    this.openedWithoutShell = this.withoutShell()
    const noShell = this.openedWithoutShell ? { noShell: true } : {}
    if (this.target.kind === 'host')
      return { kind: 'host', ...size, hostId: this.target.hostId, ...noShell }
    const { host, port, username } = this.target
    return { kind: 'ssh', ...size, target: { host, port, username }, ...noShell }
  }

  /**
   * Tab mở bằng "Open SFTP" (chế độ file manager) kết nối không mở shell — cho tới khi người dùng
   * xem terminal lần đầu.
   */
  private withoutShell(): boolean {
    if (this.shellWanted) return false
    return useTabs.getState().tabs.find((t) => t.id === this.tabId)?.view === 'files'
  }

  /** Người dùng muốn xem terminal: nếu phiên hiện tại không có shell thì kết nối lại có shell. */
  openShell(): void {
    if (this.shellWanted) return
    this.shellWanted = true
    // Phiên đã có shell (mở terminal trước rồi mới sang File manager) → giữ nguyên, không kết nối lại.
    if (this.openedWithoutShell) this.reconnect()
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
    this.events.onStats?.(undefined)
    this.client?.close()
    this.client = null
    this.statsOn = false
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
        ? `\r\n${YELLOW}[${t('Disconnected — press Enter to reconnect')}]${RESET}\r\n`
        : `\r\n${YELLOW}[${t('Process exited (code {code}) — press Enter to restart', { code: code ?? '?' })}]${RESET}\r\n`
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
      this.statsOn = false
      this.events.onStats?.(undefined)
      this.clearPrompts()
      this.events.onConnectedChange(false)
      this.events.onForwards([])
      this.hostEpoch = null
      this.setState('disconnected')
      this.term.write(`\r\n${YELLOW}— ${t('session host is restarting')} —${RESET}\r\n`)
    }
    if (host.state === 'running' && this.state === 'disconnected') void this.connect()
  }

  private scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
    this.reconnectAttempt++
    this.setState('reconnecting')
    this.term.write(
      `\r\n${YELLOW}[${t(
        'Connection lost — reconnecting in {seconds} s (attempt {attempt}); press Enter to retry now',
        { seconds: Math.round(delay / 1000), attempt: this.reconnectAttempt }
      )}]${RESET}\r\n`
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
    // Ctrl+C trong lúc macro chạy → dừng macro (và vẫn gửi Ctrl+C cho lệnh đang chạy).
    if (data === '\x03') this.cancelMacro()
    // → ở cuối dòng khi đang có gợi ý: gõ nốt phần gợi ý (như fish).
    if ((data === '\x1b[C' || data === '\x1bOC') && this.ghostRest) {
      const rest = this.ghostRest
      this.hideGhost()
      this.handleInput(rest)
      return
    }
    this.trackTyping(data)
    if (
      (this.state === 'exited' || this.state === 'reconnecting' || this.state === 'disconnected') &&
      data === '\r'
    ) {
      this.setState('exited')
      void this.connect()
      return
    }
    if (broadcastInput(this.tabId, data)) return
    this.sendInput(data)
  }

  /** Trả false để xterm bỏ qua phím (phím tắt của app hoặc copy/paste). */
  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true
    if (matchCommand(event)) return false
    // Phím copy/dán do app tự xử lý: chặn luôn hành vi mặc định của Chromium — không thì
    // Ctrl+Shift+V ("dán dạng chữ thường") / Shift+Insert dán THÊM một lần nữa vào terminal.
    const handled = (): false => {
      event.preventDefault()
      return false
    }
    // Ctrl+Insert / Shift+Insert: copy / dán kiểu Windows (PuTTY, MobaXterm, cmd).
    if (event.code === 'Insert' && event.ctrlKey && !event.shiftKey && this.term.hasSelection()) {
      this.copySelection()
      return handled()
    }
    if (event.code === 'Insert' && event.shiftKey && !event.ctrlKey) {
      this.pasteFromClipboard()
      return handled()
    }
    const copyPaste = isMac ? event.metaKey && !event.shiftKey : event.ctrlKey && event.shiftKey
    if (!copyPaste) return true
    if (event.code === 'KeyC') {
      // Không có vùng chọn: vẫn nuốt phím — không để xterm gửi ký tự lạ vào shell.
      if (this.term.hasSelection()) this.copySelection()
      return handled()
    }
    if (event.code === 'KeyV') {
      this.pasteFromClipboard()
      return handled()
    }
    return true
  }

  /** Bảng mã của host (đọc mỗi lần — sửa host thì áp dụng ngay cho output tiếp theo). */
  private outputDecoder(): TextDecoder | null {
    const target = this.target
    const encoding =
      target.kind === 'host'
        ? useHosts.getState().tree.hosts.find((h) => h.id === target.hostId)?.encoding
        : null
    if (!encoding || encoding === 'utf-8') {
      this.decoder = null
      return null
    }
    if (this.decoder?.encoding !== encoding) {
      try {
        this.decoder = new TextDecoder(encoding)
      } catch {
        this.decoder = null
      }
    }
    return this.decoder
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
