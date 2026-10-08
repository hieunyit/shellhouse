import { t } from '@shared/i18n'
import {
  ClientMessage,
  type ExitReason,
  type PromptRequest,
  type ResolvedSessionSpec,
  type ServerMessage
} from '@shared/stream-protocol'
import type { HostKeyCheck } from '@shared/session-host-protocol'
import { fingerprintSha256, keyTypeOf, randomart } from '../../node-shared/hostkey'
import { openSshShell, type HopConfig, type SshShell } from '../ssh/connect'
import type { StoredCredentials } from '../ssh/auth'
import { OutputPump, type PausableSource } from '../stream/output-pump'
import { ForwardManager } from '../forward/manager'
import { SftpService } from '../sftp/service'
import { deployPublicKey } from '../ssh/deploy-key'
import { StatsMonitor } from '../ssh/stats-monitor'
import { detectServerOs } from '../ssh/os-detect'
import type { HostOs } from '@shared/host-os'
import { LatencyMonitor } from '../ssh/latency'
import { RemoteEdits } from '../sftp/edit'
import { downloadFolder, uploadFolder } from '../sftp/folders'
import { TransferQueue } from '../sftp/transfers'
import { discardLocalParts, inspectLocalParts } from '../sftp/parts'
import { parentRemote, type SftpOp } from '@shared/sftp'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type { ForwardSpec } from '@shared/forwards'
import { LocalPty, resolveLocalShell } from '../transport/local-pty'
import { buildShellEnv } from '../transport/shell'
import { buildSystemSshArgs, findSystemSsh } from '../transport/system-ssh'
import { SerialTransport } from '../transport/serial'
import { TelnetTransport } from '../transport/telnet'
import { serialSummary } from '@shared/serial'
import { homedir } from 'node:os'
import type { PromptReply, Transport, TransportContext, TransportExit } from '../transport/types'
import { classifyConnectError } from './exit-reason'
import type { HostModuleSession } from '../../modules/registry/host-types'
import type { HostModuleRegistry, ModuleSink } from '../../modules/registry/session-host'
import { createSshCapability } from '../modules/ssh-capability'
import { probeCommand, runProbe } from '../modules/probe'
import { SessionLog, type SessionLogOptions } from './session-log'

const MAX_PENDING_INPUT = 64 * 1024

/** Lỗi SFTP mang mã số theo giao thức; đổi sang câu dễ hiểu. */
function sftpErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 2) return t('No such file or folder')
  if (code === 3) return t('Permission denied')
  if (code === 4) {
    const message = error instanceof Error ? error.message : ''
    return message && message !== 'Failure'
      ? message
      : t('Operation failed (folder not empty or already exists?)')
  }
  return error instanceof Error ? error.message : String(error)
}

function sessionEnded(): Error {
  return new Error(t('The session has ended'))
}

/** Phần tối thiểu của MessagePortMain mà session cần. */
export interface SessionPort {
  postMessage(message: ServerMessage): void
  onMessage(listener: (data: unknown) => void): void
  onClose(listener: () => void): void
  start(): void
  close(): void
}

export type Log = (level: 'info' | 'warn' | 'error', message: string) => void

/** Dịch vụ known_hosts ở main, Session Host gọi qua parentPort. */
export interface HostKeyService {
  check(host: string, port: number, key: Buffer): Promise<HostKeyCheck>
  trust(host: string, port: number, key: Buffer): void
}

export interface SessionDeps {
  log: Log
  appVersion: string
  hostKeys: HostKeyService
  onEnded(id: string): void
  /** Module chính thức (ADR-014). */
  modules: HostModuleRegistry
  /** Đã nhận ra hệ điều hành của server (phiên SSH có `detectOs`) — main lưu theo host. */
  onServerOs?: (sessionId: string, os: HostOs) => void
  /** Cho test. */
  sshOverrides?: { agent?: string | null; keyFiles?: readonly string[] }
  /**
   * Thư mục tạm của "sửa file trên server" (main cấp qua `--edit-dir=`). Có thì op `edit` chỉ nhận
   * đường dẫn nằm trong đó — renderer không thể bắt session host theo dõi / ghi đè file bất kỳ.
   */
  editRoot?: string
}

/** `path` nằm TRONG `root` (không phải chính `root`, không thoát ra bằng `..`). */
export function isInside(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(resolvePath(root), resolvePath(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface SessionExtras {
  knownKeyTypes?: readonly string[]
  credentials?: StoredCredentials
  keyFiles?: readonly string[]
  jumps?: readonly HopConfig[]
  autoForwards?: readonly ForwardSpec[]
  legacyAlgorithms?: boolean
  storedOnly?: boolean
  log?: SessionLogOptions
  /** Tên phiên tmux để gắn vào (main cấp theo tab). */
  tmux?: string
  /** Dò hệ điều hành server sau khi kết nối (host đã lưu — hiện icon distro). */
  detectOs?: boolean
}

/** Một session terminal: nối transport (PTY/SSH) với MessagePort của renderer. */
export class Session {
  private transport: Transport | null = null
  /** Có khi là SSH tích hợp — dùng cho SFTP và port forwarding. */
  private ssh: SshShell | null = null
  private forwards: ForwardManager | null = null
  private sftp: SftpService | null = null
  private transfers: TransferQueue | null = null
  private edits: RemoteEdits | null = null
  private log: SessionLog | null = null
  private stats: StatsMonitor | null = null
  private latency: LatencyMonitor | null = null
  /** Phiên riêng của module (spec `module`). */
  private moduleSession: { id: string; session: HostModuleSession } | null = null
  /** Module gắn vào kết nối SSH của tab (đang gắn = promise chưa xong). */
  private readonly attached = new Map<string, Promise<HostModuleSession>>()
  /** Thao tác module đang chạy → huỷ được. */
  private readonly moduleOps = new Map<number, AbortController>()
  private wantStats = false
  /** Yêu cầu forward đến trước khi kết nối xong. */
  private pendingForwards: ForwardSpec[] = []
  private readonly pump: OutputPump
  private closed = false
  private nextPromptId = 1
  private readonly prompts = new Map<number, (reply: PromptReply) => void>()
  /** Phím gõ trong lúc SSH đang kết nối — gửi khi shell mở, thay vì bỏ âm thầm. */
  private pendingInput = ''
  /** Người chờ kết nối SSH tích hợp (null = session kết thúc trước khi có). */
  private sshWaiters: ((ssh: SshShell | null) => void)[] = []

  constructor(
    readonly id: string,
    private readonly spec: ResolvedSessionSpec,
    private readonly port: SessionPort,
    private readonly deps: SessionDeps,
    private readonly extras: SessionExtras = {}
  ) {
    // Pump có trước transport (SSH mở bất đồng bộ); pause/resume chuyển tiếp khi đã có.
    const source: PausableSource = {
      pause: () => this.transport?.pause(),
      resume: () => this.transport?.resume()
    }
    this.pump = new OutputPump((d) => {
      this.post({ t: 'data', d })
    }, source)

    port.onMessage((raw) => {
      this.handleClientMessage(raw)
    })
    port.onClose(() => {
      // Renderer đóng tab, reload hoặc crash → không để lại shell/kết nối mồ côi.
      this.close()
    })
    port.start()
  }

  async start(): Promise<void> {
    if (this.extras.log) {
      try {
        this.log = new SessionLog(this.extras.log, (message) => {
          this.deps.log('warn', `Session ${this.id}: ${message}`)
          this.post({ t: 'error', message })
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.post({ t: 'error', message: `Could not start the session log: ${message}` })
      }
    }
    const callbacks = {
      onData: (data: Uint8Array) => {
        this.log?.write(data)
        this.pump.push(data)
      },
      onExit: (exit: TransportExit) => {
        this.handleExit(exit)
      }
    }
    try {
      if (this.spec.kind === 'local') {
        const launch = resolveLocalShell(this.deps.appVersion, this.spec.shell)
        const spawnedAt = Date.now()
        let firstOutput = true
        // Shell chậm lên prompt gần như luôn do file khởi động của nó (~/.bashrc, nvm, conda…) — ghi
        // lại thời gian tới dòng đầu tiên để phân biệt với lỗi của app.
        const timed = {
          ...callbacks,
          onData: (data: Uint8Array) => {
            if (firstOutput) {
              firstOutput = false
              const ms = Date.now() - spawnedAt
              this.deps.log(
                ms > 1500 ? 'warn' : 'info',
                `Session ${this.id}: ${launch.file} printed its first output after ${String(ms)} ms` +
                  (ms > 1500
                    ? ' — slow: the delay is the shell startup files (~/.bashrc, ~/.profile…), not Shellhouse'
                    : '')
              )
            }
            callbacks.onData(data)
          }
        }
        this.transport = new LocalPty(launch, this.spec.cols, this.spec.rows, timed)
        this.deps.log('info', `Session ${this.id}: started ${launch.file}`)
      } else if (this.spec.kind === 'module') {
        const { module, sessionKind } = this.spec
        const session = this.deps.modules.createSession(
          module,
          sessionKind,
          this.spec.config,
          this.moduleSink(module)
        )
        this.moduleSession = { id: module, session }
        if (this.spec.terminal !== undefined) {
          // Tab terminal của module (shell vào container…): dùng lại toàn bộ đường terminal.
          if (!session.openTerminal) throw new Error(`Module ${module} has no terminal`)
          const transport = await session.openTerminal(
            this.spec.terminal,
            { cols: this.spec.cols, rows: this.spec.rows },
            callbacks
          )
          if (this.closed) {
            transport.close()
            return
          }
          this.transport = transport
          this.flushPendingInput()
        }
        this.deps.log('info', `Session ${this.id}: module ${module} (${sessionKind})`)
        this.post({ t: 'status', phase: 'connected', detail: t('Ready') })
      } else if (this.spec.kind === 'telnet') {
        const { host, port } = this.spec.target
        this.post({
          t: 'status',
          phase: 'connecting',
          detail: t('Connecting to {host}:{port} (Telnet)…', { host, port: String(port) })
        })
        const transport = await TelnetTransport.open(
          { host, port, cols: this.spec.cols, rows: this.spec.rows },
          callbacks
        )
        if (this.closed) {
          transport.close()
          return
        }
        this.transport = transport
        this.flushPendingInput()
        this.deps.log('info', `Session ${this.id}: telnet ${host}:${port}`)
        this.post({
          t: 'status',
          phase: 'connected',
          detail: t('Connected (Telnet — not encrypted)')
        })
      } else if (this.spec.kind === 'serial') {
        const { serial } = this.spec
        this.post({
          t: 'status',
          phase: 'connecting',
          detail: t('Opening {path}…', { path: serial.path })
        })
        const transport = await SerialTransport.open(serial, callbacks)
        if (this.closed) {
          transport.close()
          return
        }
        this.transport = transport
        this.flushPendingInput()
        this.post({
          t: 'status',
          phase: 'connected',
          detail: t('Connected to {path} ({summary}) — press Enter if nothing shows', {
            path: serial.path,
            summary: serialSummary(serial)
          })
        })
        this.deps.log('info', `Session ${this.id}: serial ${serial.path}`)
      } else if (this.spec.kind === 'system-ssh') {
        const file = findSystemSsh()
        if (!file) throw new Error(t('The system ssh command (OpenSSH client) was not found'))
        const args = buildSystemSshArgs(this.spec)
        const env = buildShellEnv({
          platform: process.platform,
          env: process.env,
          homedir: homedir(),
          userShell: null,
          appVersion: this.deps.appVersion
        })
        this.transport = new LocalPty(
          { file, args, cwd: homedir(), env },
          this.spec.cols,
          this.spec.rows,
          callbacks
        )
        this.deps.log('info', `Session ${this.id}: system ssh → ${this.spec.target.host}`)
      } else {
        const destination: HopConfig = {
          target: this.spec.target,
          knownKeyTypes: this.extras.knownKeyTypes ?? [],
          ...(this.extras.credentials ? { credentials: this.extras.credentials } : {}),
          ...(this.extras.keyFiles ? { keyFiles: this.extras.keyFiles } : {}),
          ...(this.extras.legacyAlgorithms ? { legacyAlgorithms: true } : {}),
          ...(this.extras.storedOnly ? { storedOnly: true } : {})
        }
        const transport = await openSshShell({
          destination,
          ...(this.extras.jumps ? { jumps: this.extras.jumps } : {}),
          cols: this.spec.cols,
          rows: this.spec.rows,
          ...(this.spec.noShell || this.spec.moduleTerminal ? { shell: false } : {}),
          ...(this.spec.moduleTerminal ? { noShellStatus: t('Authenticated') } : {}),
          ...(this.extras.tmux ? { tmux: this.extras.tmux } : {}),
          callbacks,
          ctx: this.context(),
          ...this.deps.sshOverrides
        })
        if (this.closed) {
          transport.close()
          return
        }
        this.ssh = transport
        this.dropCredentials()
        this.detectOs(transport)
        for (const resolve of this.sshWaiters.splice(0)) resolve(transport)
        const moduleTerminal = this.spec.moduleTerminal
        if (moduleTerminal) {
          const session = await this.attachModule(moduleTerminal.module)
          if (!session.openTerminal)
            throw new Error(`Module ${moduleTerminal.module} has no terminal`)
          const pty = await session.openTerminal(
            moduleTerminal.params,
            { cols: this.spec.cols, rows: this.spec.rows },
            callbacks
          )
          if (this.isClosed()) {
            pty.close()
            return
          }
          this.transport = pty
        } else {
          this.transport = transport
        }
        this.forwards = new ForwardManager(transport.client, (list) => {
          this.post({ t: 'forwards', list })
        })
        for (const spec of [...(this.extras.autoForwards ?? []), ...this.pendingForwards]) {
          void this.forwards.start(spec)
        }
        this.pendingForwards = []
        this.syncStats()
        this.flushPendingInput()
        const { host, port, username } = this.spec.target
        this.deps.log('info', `Session ${this.id}: SSH ${username}@${host}:${port}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log('warn', `Session ${this.id}: could not open — ${message}`)
      this.post({ t: 'error', message })
      this.finish(null, null, classifyConnectError(error))
    }
  }

  private flushPendingInput(): void {
    if (!this.transport || !this.pendingInput) return
    this.transport.write(this.pendingInput)
    this.pendingInput = ''
  }

  close(): void {
    if (this.closed) return
    this.transport?.close()
    if (this.ssh && this.ssh !== this.transport) this.ssh.close()
    this.end()
  }

  /** Kết nối SSH tích hợp của session (null nếu là local/ssh hệ thống hoặc chưa kết nối). */
  get sshShell(): SshShell | null {
    return this.ssh
  }

  private handleExit(exit: TransportExit): void {
    if (this.closed) return
    if (exit.error) this.post({ t: 'error', message: exit.error })
    // Transport đã mở được mà kết thúc kèm lỗi = mất kết nối giữa chừng.
    this.finish(exit.code, exit.signal, exit.error ? 'network' : 'normal')
  }

  private finish(code: number | null, signal: number | null, reason: ExitReason): void {
    if (this.closed) return
    this.pump.flush()
    this.post({ t: 'exit', code, signal, reason })
    this.deps.log('info', `Session ${this.id}: ended (${reason}, code ${String(code)})`)
    this.end()
  }

  private end(): void {
    if (this.closed) return
    this.closed = true
    this.log?.close(`=== Session ended ${new Date().toISOString()} ===`)
    this.log = null
    this.stats?.stop()
    this.stats = null
    this.latency?.stop()
    this.latency = null
    for (const controller of this.moduleOps.values()) controller.abort()
    this.moduleOps.clear()
    this.moduleSession?.session.dispose()
    this.moduleSession = null
    for (const pending of this.attached.values())
      void pending.then(
        (session) => {
          session.dispose()
        },
        () => undefined
      )
    this.attached.clear()
    // Terminal của module chạy trên kết nối SSH: đóng cả kết nối.
    if (this.ssh && this.ssh !== this.transport) this.ssh.close()
    this.pump.dispose()
    this.forwards?.dispose()
    this.forwards = null
    this.edits?.dispose()
    this.edits = null
    this.transfers?.dispose()
    this.transfers = null
    this.sftp?.close()
    this.sftp = null
    this.pendingForwards = []
    this.pendingInput = ''
    for (const resolve of this.prompts.values()) resolve({ ok: false, answers: [] })
    this.prompts.clear()
    for (const resolve of this.sshWaiters.splice(0)) resolve(this.ssh)
    this.dropCredentials()
    this.deps.onEnded(this.id)
  }

  private context(): TransportContext {
    return {
      status: (phase, detail) => {
        this.post({ t: 'status', phase, detail })
      },
      prompt: (request) => this.prompt(request),
      verifyHostKey: (host, port, key) => this.verifyHostKey(host, port, key),
      log: this.deps.log
    }
  }

  private prompt(request: PromptRequest): Promise<PromptReply> {
    if (this.closed) return Promise.resolve({ ok: false, answers: [] })
    const id = this.nextPromptId++
    return new Promise((resolve) => {
      this.prompts.set(id, resolve)
      this.post({ t: 'prompt', id, prompt: request })
    })
  }

  private async verifyHostKey(host: string, port: number, key: Buffer): Promise<boolean> {
    const result = await this.deps.hostKeys.check(host, port, key)
    if (result.status === 'match') return true
    if (result.status === 'revoked') {
      this.post({
        t: 'error',
        message: t('The host key of {host} has been revoked (@revoked). Refusing to connect.', {
          host
        })
      })
      return false
    }
    const reply = await this.prompt({
      kind: 'hostkey',
      key: {
        host,
        port,
        keyType: keyTypeOf(key),
        fingerprint: fingerprintSha256(key),
        randomart: randomart(key)
      },
      changedFrom: result.status === 'changed' ? result.known : null
    })
    if (!reply.ok) return false
    this.deps.hostKeys.trust(host, port, key)
    return true
  }

  private async handleSftp(id: number, op: SftpOp): Promise<void> {
    try {
      const result = await this.runSftp(op)
      this.post({ t: 'sftp-result', id, ok: true, result })
    } catch (error) {
      this.post({ t: 'sftp-result', id, ok: false, error: sftpErrorText(error) })
    }
  }

  /**
   * Kết nối SSH tích hợp, chờ nếu đang mở dở: renderer thấy "đã xác thực" (và mở SFTP) trước khi
   * kênh shell mở xong — yêu cầu SFTP tới trong khoảng đó phải chờ, không báo lỗi.
   */
  private waitForSsh(timeoutMs = 30_000): Promise<SshShell | null> {
    if (this.ssh || this.spec.kind !== 'ssh' || this.closed) return Promise.resolve(this.ssh)
    return new Promise((resolve) => {
      const waiter = (ssh: SshShell | null): void => {
        clearTimeout(timer)
        resolve(ssh)
      }
      const timer = setTimeout(() => {
        this.sshWaiters = this.sshWaiters.filter((w) => w !== waiter)
        resolve(this.ssh)
      }, timeoutMs)
      this.sshWaiters.push(waiter)
    })
  }

  /**
   * Đã xác thực (hoặc session kết thúc): không giữ password / private key / passphrase trong bộ nhớ
   * lâu hơn cần. Kết nối lại = renderer mở session mới (main gửi lại thông tin xác thực).
   */
  private dropCredentials(): void {
    delete this.extras.credentials
    for (const hop of this.extras.jumps ?? []) delete hop.credentials
  }

  /**
   * File tải dở trong thư mục trên máy (khung Local): đọc / xoá trên máy, không cần chờ kết nối —
   * chỉ "tiếp tục được không" mới hỏi server (khi đã kết nối).
   */
  private async localPartOp(
    op: Extract<SftpOp, { op: 'localParts' | 'discardLocalParts' }>
  ): Promise<unknown> {
    const busy = (localPath: string): boolean => this.transfers?.isBusyLocal(localPath) ?? false
    if (op.op === 'discardLocalParts') return discardLocalParts(op.dir, op.names, busy)
    // Tab đang kết nối: chờ một chút để biết file tải dở còn tiếp tục được không.
    await this.waitForSsh(5_000)
    if (this.ssh && !this.sftp) {
      const limits = this.spec.kind === 'ssh' ? this.spec.sftpLimits : undefined
      this.sftp = new SftpService(this.ssh.client, limits?.requests)
    }
    const sftp = this.ssh && this.sftp && !this.sftp.isLost() ? this.sftp : null
    const remoteStat = sftp
      ? async (path: string) => {
          const st = await sftp.statOrNull(path)
          return st && st.isFile() ? { size: st.size, mtime: st.mtime } : null
        }
      : null
    return inspectLocalParts(op.dir, op.names, remoteStat, busy)
  }

  private async runSftp(op: SftpOp): Promise<unknown> {
    if (op.op === 'localParts' || op.op === 'discardLocalParts') return this.localPartOp(op)
    const ssh = await this.waitForSsh()
    if (!ssh) throw new Error(t('SFTP is only available on a connected built-in SSH session'))
    const limits = this.spec.kind === 'ssh' ? this.spec.sftpLimits : undefined
    this.sftp ??= new SftpService(ssh.client, limits?.requests)
    const sftp = this.sftp
    this.transfers ??= new TransferQueue(
      sftp,
      (list) => {
        this.post({ t: 'transfers', list })
      },
      limits?.transfers
    )
    const transfers = this.transfers
    switch (op.op) {
      case 'realpath':
        return sftp.realpath(op.path)
      case 'list':
        return sftp.list(op.path)
      case 'mkdir':
        await sftp.mkdir(op.path)
        return null
      case 'rename':
        await sftp.rename(op.from, op.to)
        return null
      case 'remove':
        await sftp.remove(op.path, op.recursive)
        return null
      case 'chmod':
        await sftp.chmod(op.path, op.mode)
        return null
      case 'preview':
        return sftp.preview(op.path, op.maxBytes)
      case 'write':
        return sftp.write(op.path, Buffer.from(op.data, 'base64'), op.expect)
      case 'download':
        return transfers.enqueue('download', op.localPath, op.remotePath, op.overwrite)
      case 'upload':
        // Kéo thả từ Explorer/Finder có thể là thư mục → tải cả thư mục.
        if ((await stat(op.localPath).catch(() => null))?.isDirectory())
          return uploadFolder(
            sftp,
            transfers,
            op.localPath,
            parentRemote(op.remotePath),
            op.overwrite
          )
        return transfers.enqueue('upload', op.localPath, op.remotePath, op.overwrite)
      case 'downloadFolder':
        return downloadFolder(sftp, transfers, op.remotePath, op.localParent, op.overwrite)
      case 'uploadFolder':
        return uploadFolder(sftp, transfers, op.localPath, op.remoteParent, op.overwrite)
      case 'edit':
        if (this.deps.editRoot !== undefined && !isInside(this.deps.editRoot, op.localPath))
          throw new Error(t('The local copy for editing must be in the app’s temporary folder'))
        this.edits ??= new RemoteEdits(sftp, transfers)
        await this.edits.open(op.remotePath, op.localPath)
        return null
      case 'cancel':
        transfers.cancel(op.transferId)
        return null
      case 'retry':
        transfers.retry(op.transferId)
        return null
      case 'discard':
        transfers.discard(op.transferId)
        return null
      case 'clearDone':
        transfers.clearDone(op.keepParts === true)
        return null
    }
  }

  /** Đọc qua hàm để TS không thu hẹp kiểu qua `await` (giá trị đổi trong lúc chờ). */
  private isClosed(): boolean {
    return this.closed
  }

  private moduleSink(module: string): ModuleSink {
    return {
      emit: (event, data) => {
        this.post({ t: 'module-event', module, event, data })
      },
      transfers: (list) => {
        this.post({ t: 'transfers', list })
      }
    }
  }

  /** Gắn module vào kết nối SSH tích hợp của tab (chờ nếu kết nối đang mở). */
  private attachModule(module: string): Promise<HostModuleSession> {
    const existing = this.attached.get(module)
    if (existing) return existing
    const pending = (async () => {
      const ssh = await this.waitForSsh()
      if (!ssh || this.closed)
        throw new Error(t('Only available on a connected built-in SSH session'))
      const { host, username } =
        this.spec.kind === 'ssh' ? this.spec.target : { host: '', username: '' }
      const capability = createSshCapability(ssh.client, `${username}@${host}`)
      const session = this.deps.modules.attach(module, capability, this.moduleSink(module))
      if (this.isClosed()) {
        session.dispose()
        throw sessionEnded()
      }
      this.deps.log('info', `Session ${this.id}: attached module ${module}`)
      return session
    })()
    this.attached.set(module, pending)
    // Gắn lỗi → lần sau thử lại (ví dụ kết nối lại xong).
    pending.catch(() => {
      if (this.attached.get(module) === pending) this.attached.delete(module)
    })
    return pending
  }

  private async probeModules(): Promise<void> {
    const ssh = await this.waitForSsh()
    const command = probeCommand(this.deps.modules.probeTargets())
    if (!ssh || !command || this.isClosed()) return
    const found = await runProbe(ssh.client, command)
    const known = new Set(this.deps.modules.probeTargets().map((t) => t.id))
    const modules = found.filter((id) => known.has(id))
    if (modules.length > 0) this.post({ t: 'module-suggest', modules })
  }

  private async runModuleOp(id: number, module: string, op: unknown): Promise<void> {
    const controller = new AbortController()
    this.moduleOps.set(id, controller)
    try {
      const session =
        this.moduleSession?.id === module
          ? this.moduleSession.session
          : this.spec.kind === 'ssh'
            ? await this.attachModule(module)
            : null
      if (!session) throw new Error(t('Module {module} is not available in this tab', { module }))
      const result = await session.run(op, controller.signal)
      this.post({ t: 'module-result', id, ok: true, result })
    } catch (error) {
      this.post({
        t: 'module-result',
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.moduleOps.delete(id)
    }
  }

  private rejectForward(spec: ForwardSpec, error: string): void {
    this.post({
      t: 'forwards',
      list: [
        {
          spec,
          state: 'error',
          actualPort: null,
          activeConnections: 0,
          totalConnections: 0,
          bytesIn: 0,
          bytesOut: 0,
          error
        }
      ]
    })
  }

  private post(message: ServerMessage): void {
    try {
      this.port.postMessage(message)
    } catch {
      // Port đã đóng.
    }
  }

  /** Dò hệ điều hành server song song với shell (kênh exec riêng, có hạn giờ) — lỗi thì bỏ qua. */
  private detectOs(ssh: SshShell): void {
    const report = this.deps.onServerOs
    if (!this.extras.detectOs || !report) return
    void detectServerOs(ssh.client).then(
      (os) => {
        if (os && !this.closed) report(this.id, os)
      },
      () => undefined
    )
  }

  /** Thanh theo dõi server: chạy khi renderer muốn (tab đang hiện) và đã có SSH tích hợp. */
  private syncStats(): void {
    const ssh = this.ssh
    if (!ssh || this.closed) return
    this.stats ??= new StatsMonitor(ssh.client, (update) => {
      if ('stats' in update) this.post({ t: 'stats', stats: update.stats })
      else this.post({ t: 'stats-unsupported', reason: update.unsupported })
    })
    this.latency ??= new LatencyMonitor(ssh.client, (ms) => {
      this.post({ t: 'latency', ms })
    })
    if (this.wantStats) {
      this.stats.start()
      this.latency.start()
    } else {
      this.stats.stop()
      this.latency.stop()
    }
  }

  private handleClientMessage(raw: unknown): void {
    const parsed = ClientMessage.safeParse(raw)
    if (!parsed.success) {
      this.deps.log('warn', `Session ${this.id}: ignoring invalid message`)
      return
    }
    const message = parsed.data
    switch (message.t) {
      case 'input':
        if (this.transport) {
          this.transport.write(message.d)
        } else if (this.pendingInput.length + message.d.length <= MAX_PENDING_INPUT) {
          this.pendingInput += message.d
        }
        break
      case 'resize':
        this.transport?.resize(message.cols, message.rows)
        break
      case 'ack':
        this.pump.ack(message.n)
        break
      case 'sftp':
        void this.handleSftp(message.id, message.op)
        break
      case 'module':
        void this.runModuleOp(message.id, message.module, message.op)
        break
      case 'module-cancel':
        this.moduleOps.get(message.id)?.abort()
        break
      case 'module-probe':
        void this.probeModules()
        break
      case 'module-attach':
        // Lỗi gắn được báo qua kết quả của thao tác kế tiếp.
        this.attachModule(message.module).catch(() => undefined)
        break
      case 'deploy-key': {
        const { id, publicKey } = message
        void this.waitForSsh().then(async (ssh) => {
          const r: { status: 'added' | 'exists' | 'error'; message?: string } = ssh
            ? await deployPublicKey(ssh.client, publicKey)
            : { status: 'error', message: t('Not connected with built-in SSH') }
          this.post({
            t: 'deploy-key-result',
            id,
            status: r.status,
            message: r.status === 'error' ? (r.message ?? null) : null
          })
        })
        break
      }
      case 'forward-start':
        if (this.forwards) void this.forwards.start(message.spec)
        else if (this.spec.kind === 'ssh') this.pendingForwards.push(message.spec)
        else this.rejectForward(message.spec, t('Only available with built-in SSH'))
        break
      case 'stats':
        this.wantStats = message.on
        this.syncStats()
        break
      case 'forward-stop':
        this.forwards?.stop(message.id)
        break
      case 'forward-remove':
        this.forwards?.remove(message.id)
        break
      case 'prompt-reply': {
        const resolve = this.prompts.get(message.id)
        if (resolve) {
          this.prompts.delete(message.id)
          resolve({ ok: message.ok, answers: message.answers })
        }
        break
      }
    }
  }
}
