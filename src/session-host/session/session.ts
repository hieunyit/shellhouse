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
import { S3Service } from '../s3/service'
import { RemoteEdits } from '../sftp/edit'
import { downloadFolder, uploadFolder } from '../sftp/folders'
import { TransferQueue } from '../sftp/transfers'
import { parentRemote, type SftpOp } from '@shared/sftp'
import { stat } from 'node:fs/promises'
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
import { SessionLog, type SessionLogOptions } from './session-log'

const MAX_PENDING_INPUT = 64 * 1024

/** Lỗi SFTP mang mã số theo giao thức; đổi sang câu dễ hiểu. */
function sftpErrorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 2) return 'No such file or folder'
  if (code === 3) return 'Permission denied'
  if (code === 4) {
    const message = error instanceof Error ? error.message : ''
    return message && message !== 'Failure'
      ? message
      : 'Operation failed (folder not empty or already exists?)'
  }
  return error instanceof Error ? error.message : String(error)
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
  /** Cho test. */
  sshOverrides?: { agent?: string | null; keyFiles?: readonly string[] }
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
  private s3: S3Service | null = null
  private wantStats = false
  /** Yêu cầu forward đến trước khi kết nối xong. */
  private pendingForwards: ForwardSpec[] = []
  private readonly pump: OutputPump
  private closed = false
  private nextPromptId = 1
  private readonly prompts = new Map<number, (reply: PromptReply) => void>()
  /** Phím gõ trong lúc SSH đang kết nối — gửi khi shell mở, thay vì bỏ âm thầm. */
  private pendingInput = ''

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
        this.transport = new LocalPty(launch, this.spec.cols, this.spec.rows, callbacks)
        this.deps.log('info', `Session ${this.id}: started ${launch.file}`)
      } else if (this.spec.kind === 's3') {
        // Không có terminal: chỉ thao tác S3 + truyền file qua port của tab.
        this.s3 = new S3Service(
          this.spec.connection,
          (list) => {
            this.post({ t: 'transfers', list })
          },
          this.spec.limits
        )
        this.post({ t: 'status', phase: 'connected', detail: 'S3 ready' })
        this.deps.log('info', `Session ${this.id}: S3 ${this.spec.connection.endpoint || 'AWS'}`)
      } else if (this.spec.kind === 'telnet') {
        const { host, port } = this.spec.target
        this.post({
          t: 'status',
          phase: 'connecting',
          detail: `Connecting to ${host}:${port} (Telnet)…`
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
        this.post({ t: 'status', phase: 'connected', detail: 'Connected (Telnet — not encrypted)' })
        this.deps.log('info', `Session ${this.id}: telnet ${host}:${port}`)
      } else if (this.spec.kind === 'serial') {
        const { serial } = this.spec
        this.post({ t: 'status', phase: 'connecting', detail: `Opening ${serial.path}…` })
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
          detail: `Connected to ${serial.path} (${serialSummary(serial)}) — press Enter if nothing shows`
        })
        this.deps.log('info', `Session ${this.id}: serial ${serial.path}`)
      } else if (this.spec.kind === 'system-ssh') {
        const file = findSystemSsh()
        if (!file) throw new Error('The system ssh command (OpenSSH client) was not found')
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
          ...(this.spec.noShell ? { shell: false } : {}),
          callbacks,
          ctx: this.context(),
          ...this.deps.sshOverrides
        })
        if (this.closed) {
          transport.close()
          return
        }
        this.ssh = transport
        this.transport = transport
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
    this.s3?.dispose()
    this.s3 = null
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
        message: `The host key of ${host} has been revoked (@revoked). Refusing to connect.`
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
  private async waitForSsh(timeoutMs = 30_000): Promise<SshShell | null> {
    // Đọc qua hàm để TS không thu hẹp kiểu qua `await` (giá trị đổi trong lúc chờ).
    const current = (): SshShell | null => this.ssh
    const closed = (): boolean => this.closed
    if (current() || this.spec.kind !== 'ssh') return current()
    const deadline = Date.now() + timeoutMs
    while (!current() && !closed() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return current()
  }

  private async runSftp(op: SftpOp): Promise<unknown> {
    const ssh = await this.waitForSsh()
    if (!ssh) throw new Error('SFTP is only available on a connected built-in SSH session')
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
        this.edits ??= new RemoteEdits(sftp, transfers)
        await this.edits.open(op.remotePath, op.localPath)
        return null
      case 'cancel':
        transfers.cancel(op.transferId)
        return null
      case 'retry':
        transfers.retry(op.transferId)
        return null
      case 'clearDone':
        transfers.clearDone()
        return null
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

  /** Thanh theo dõi server: chạy khi renderer muốn (tab đang hiện) và đã có SSH tích hợp. */
  private syncStats(): void {
    const ssh = this.ssh
    if (!ssh || this.closed) return
    this.stats ??= new StatsMonitor(ssh.client, (update) => {
      if ('stats' in update) this.post({ t: 'stats', stats: update.stats })
      else this.post({ t: 'stats-unsupported', reason: update.unsupported })
    })
    if (this.wantStats) this.stats.start()
    else this.stats.stop()
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
      case 's3': {
        const { id, op } = message
        const s3 = this.s3
        if (!s3) {
          this.post({ t: 's3-result', id, ok: false, error: 'Not an S3 session' })
          break
        }
        void s3.run(op).then(
          (result) => {
            this.post({ t: 's3-result', id, ok: true, result })
          },
          (error: unknown) => {
            this.post({
              t: 's3-result',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        )
        break
      }
      case 'deploy-key': {
        const { id, publicKey } = message
        void this.waitForSsh().then(async (ssh) => {
          const r: { status: 'added' | 'exists' | 'error'; message?: string } = ssh
            ? await deployPublicKey(ssh.client, publicKey)
            : { status: 'error', message: 'Not connected with built-in SSH' }
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
        else this.rejectForward(message.spec, 'Only available with built-in SSH')
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
