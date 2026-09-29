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
import { TransferQueue } from '../sftp/transfers'
import type { SftpOp } from '@shared/sftp'
import type { ForwardSpec } from '@shared/forwards'
import { LocalPty, resolveLocalShell } from '../transport/local-pty'
import { buildShellEnv } from '../transport/shell'
import { buildSystemSshArgs, findSystemSsh } from '../transport/system-ssh'
import { homedir } from 'node:os'
import type { PromptReply, Transport, TransportContext, TransportExit } from '../transport/types'
import { classifyConnectError } from './exit-reason'

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
}

/** Một session terminal: nối transport (PTY/SSH) với MessagePort của renderer. */
export class Session {
  private transport: Transport | null = null
  /** Có khi là SSH tích hợp — dùng cho SFTP và port forwarding. */
  private ssh: SshShell | null = null
  private forwards: ForwardManager | null = null
  private sftp: SftpService | null = null
  private transfers: TransferQueue | null = null
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
    const callbacks = {
      onData: (data: Uint8Array) => {
        this.pump.push(data)
      },
      onExit: (exit: TransportExit) => {
        this.handleExit(exit)
      }
    }
    try {
      if (this.spec.kind === 'local') {
        const launch = resolveLocalShell(this.deps.appVersion)
        this.transport = new LocalPty(launch, this.spec.cols, this.spec.rows, callbacks)
        this.deps.log('info', `Session ${this.id}: started ${launch.file}`)
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
          ...(this.extras.legacyAlgorithms ? { legacyAlgorithms: true } : {})
        }
        const transport = await openSshShell({
          destination,
          ...(this.extras.jumps ? { jumps: this.extras.jumps } : {}),
          cols: this.spec.cols,
          rows: this.spec.rows,
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
        if (this.pendingInput) {
          transport.write(this.pendingInput)
          this.pendingInput = ''
        }
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
    this.pump.dispose()
    this.forwards?.dispose()
    this.forwards = null
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

  private async runSftp(op: SftpOp): Promise<unknown> {
    const ssh = this.ssh
    if (!ssh) throw new Error('SFTP is only available on a connected built-in SSH session')
    this.sftp ??= new SftpService(ssh.client)
    const sftp = this.sftp
    this.transfers ??= new TransferQueue(sftp, (list) => {
      this.post({ t: 'transfers', list })
    })
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
        return transfers.enqueue('upload', op.localPath, op.remotePath, op.overwrite)
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
      case 'deploy-key': {
        const id = message.id
        const ssh = this.ssh
        if (!ssh) {
          this.post({
            t: 'deploy-key-result',
            id,
            status: 'error',
            message: 'Not connected with built-in SSH'
          })
          break
        }
        void deployPublicKey(ssh.client, message.publicKey).then((r) => {
          this.post({
            t: 'deploy-key-result',
            id,
            status: r.status,
            message: r.status === 'error' ? r.message : null
          })
        })
        break
      }
      case 'forward-start':
        if (this.forwards) void this.forwards.start(message.spec)
        else if (this.spec.kind === 'ssh') this.pendingForwards.push(message.spec)
        else this.rejectForward(message.spec, 'Only available with built-in SSH')
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
