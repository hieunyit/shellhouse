import { randomUUID } from 'node:crypto'
import type { HostModuleSession, TerminalSize } from '../../registry/host-types'
import type { Transport, TransportCallbacks } from '../../../session-host/transport/types'
import {
  DockerOp,
  DockerTerminalParams,
  isMutating,
  maskEnv,
  type ContainerRow,
  type EngineInfo
} from '../shared/ops'
import { cliErrorText, composeArgs, type DockerBackend, type DockerCli } from './backend'

/**
 * Một phiên Docker (một nguồn: máy này hoặc một server qua SSH). Backend được chọn lúc thao tác
 * đầu tiên (Engine API nếu nói chuyện được với socket, không thì CLI) và dùng lại.
 */
export interface DockerServiceDeps {
  /** Chọn backend (thử socket → CLI). */
  connect(signal: AbortSignal): Promise<DockerBackend>
  /** `docker …` cho compose up/down/pull. */
  cli: DockerCli
  /** Mở `docker exec -it` trong PTY. */
  openPty(args: readonly string[], size: TerminalSize, cb: TransportCallbacks): Promise<Transport>
  emit(event: string, data: unknown): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

const LOG_FLUSH_MS = 50
/** Log dồn quá mức này thì gửi ngay (container in liên tục). */
const LOG_FLUSH_BYTES = 64 * 1024

/** Shell mặc định khi vào container: bash nếu có, không thì sh. */
export const DEFAULT_SHELL = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']

export function execArgs(params: DockerTerminalParams): string[] {
  return [
    'exec',
    '-it',
    // Kích thước ban đầu của TTY đúng ngay từ đầu (resize sau đó đi qua PTY).
    '-e',
    'TERM=xterm-256color',
    ...(params.user ? ['-u', params.user] : []),
    params.container,
    ...(params.command && params.command.length > 0 ? params.command : DEFAULT_SHELL)
  ]
}

export class DockerService implements HostModuleSession {
  private backend: Promise<DockerBackend> | null = null
  private readonly subscriptions = new Map<string, AbortController>()
  private readOnly = false
  private disposed = false

  constructor(private readonly deps: DockerServiceDeps) {}

  private getBackend(signal: AbortSignal): Promise<DockerBackend> {
    if (!this.backend) {
      const pending = this.deps.connect(signal)
      this.backend = pending
      // Lỗi → lần sau thử lại (Docker vừa được khởi động…).
      pending.catch(() => {
        if (this.backend === pending) this.backend = null
      })
    }
    return this.backend
  }

  async run(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const op = DockerOp.parse(raw)
    if (op.op === 'configure') {
      this.readOnly = op.readOnly
      return null
    }
    if (op.op === 'unsubscribe') {
      this.subscriptions.get(op.subscription)?.abort()
      this.subscriptions.delete(op.subscription)
      return null
    }
    if (this.readOnly && isMutating(op))
      throw new Error('Read-only mode is on for this Docker — turn it off to make changes')
    const backend = await this.getBackend(signal)
    switch (op.op) {
      case 'info':
        return backend.info(signal) satisfies Promise<EngineInfo>
      case 'containers':
        return backend.containers(op.all, signal)
      case 'inspect': {
        const data = await backend.inspect(op.kind, op.id)
        return op.kind === 'container' ? maskInspect(data) : data
      }
      case 'action':
        await backend.action(op.id, op.action, op.force === true)
        return null
      case 'rename':
        await backend.rename(op.id, op.name)
        return null
      case 'logs.subscribe':
        return this.subscribe('logs', (id, s) => {
          const batch = new Batcher((stream, text) => {
            this.deps.emit('logs', { subscription: id, stream, text })
          })
          return backend
            .logs(
              op.id,
              op.tail,
              op.timestamps,
              (stream, text) => {
                batch.push(stream, text)
              },
              s
            )
            .finally(() => {
              batch.flush()
            })
        })
      case 'stats.subscribe':
        return this.subscribe('stats', (id, s) =>
          backend.stats(
            op.id,
            (sample) => {
              this.deps.emit('stats', { subscription: id, sample })
            },
            s
          )
        )
      case 'events.subscribe':
        return this.subscribe('engine', (id, s) =>
          backend.events((e) => {
            this.deps.emit('engine', { subscription: id, ...e })
          }, s)
        )
      case 'images':
        return backend.images(signal)
      case 'image.remove':
        await backend.imageRemove(op.id, op.force === true)
        return null
      case 'image.pull':
        return this.subscribe('pull', async (id, s) => {
          await backend.imagePull(
            op.ref,
            (status, progress) => {
              this.deps.emit('pull', { subscription: id, status, progress, done: false })
            },
            s
          )
          this.deps.emit('pull', { subscription: id, status: 'Done', progress: 1, done: true })
        })
      case 'volumes':
        return backend.volumes(signal)
      case 'volume.remove':
        await backend.volumeRemove(op.name)
        return null
      case 'networks':
        return backend.networks(signal)
      case 'network.remove':
        await backend.networkRemove(op.id)
        return null
      case 'prune':
        return backend.prune(op.what, op.dryRun)
      case 'compose':
        return this.compose(backend, op.project, op.action, signal)
    }
  }

  /**
   * Chạy một luồng dài (log, stats…) nền; trả id đăng ký ngay. Luồng lỗi / kết thúc → sự kiện
   * `<kind>-end` (có `error` nếu lỗi) để tab hiện trạng thái.
   */
  private subscribe(
    kind: string,
    start: (id: string, signal: AbortSignal) => Promise<void>
  ): { subscription: string } {
    const id = randomUUID()
    const controller = new AbortController()
    this.subscriptions.set(id, controller)
    void start(id, controller.signal)
      .then(
        () => {
          if (!controller.signal.aborted) this.deps.emit(`${kind}-end`, { subscription: id })
        },
        (error: unknown) => {
          if (controller.signal.aborted || this.disposed) return
          const message = error instanceof Error ? error.message : String(error)
          if (kind === 'pull')
            this.deps.emit('pull', {
              subscription: id,
              status: message,
              progress: null,
              done: true,
              error: message
            })
          else this.deps.emit(`${kind}-end`, { subscription: id, error: message })
        }
      )
      .finally(() => {
        this.subscriptions.delete(id)
      })
    return { subscription: id }
  }

  private async compose(
    backend: DockerBackend,
    project: string,
    action: 'start' | 'stop' | 'restart' | 'up' | 'down' | 'pull',
    signal: AbortSignal
  ): Promise<string> {
    const members = (await backend.containers(true, signal)).filter((c) => c.project === project)
    if (action === 'start' || action === 'stop' || action === 'restart') {
      if (members.length === 0) throw new Error(`No containers in the Compose project ${project}`)
      await Promise.all(members.map((c) => backend.action(c.id, action, false)))
      return ''
    }
    // up / down / pull cần file compose: lấy thư mục + file từ nhãn của container.
    const ref: ContainerRow | undefined = members.find((c) => c.composeDir || c.composeFiles)
    const args = composeArgs(project, action, ref?.composeDir ?? null, ref?.composeFiles ?? null)
    this.deps.log('info', `docker ${args.join(' ')}`)
    const r = await this.deps.cli.exec(args, { signal, timeoutMs: 15 * 60_000 })
    if (r.code !== 0) throw new Error(cliErrorText(r.stderr, r.code))
    return `${r.stdout}${r.stderr}`.trim()
  }

  openTerminal(raw: unknown, size: TerminalSize, cb: TransportCallbacks): Promise<Transport> {
    const params = DockerTerminalParams.parse(raw)
    return this.deps.openPty(execArgs(params), size, cb)
  }

  dispose(): void {
    this.disposed = true
    for (const c of this.subscriptions.values()) c.abort()
    this.subscriptions.clear()
  }
}

/** Inspect container: che giá trị biến môi trường có vẻ bí mật (ADR-014 mục 6.3). */
export function maskInspect(data: unknown): unknown {
  const d = data as { Config?: { Env?: unknown } } | null
  if (!d?.Config || !Array.isArray(d.Config.Env)) return data
  return {
    ...d,
    Config: {
      ...d.Config,
      Env: (d.Config.Env as unknown[]).map((e) => (typeof e === 'string' ? maskEnv(e) : e))
    }
  }
}

/** Gom mảnh log nhỏ thành gói ~50 ms — container in từng dòng không làm ngập MessagePort. */
class Batcher {
  private parts: { stream: 'stdout' | 'stderr'; text: string }[] = []
  private bytes = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly send: (stream: 'stdout' | 'stderr', text: string) => void) {}

  push(stream: 'stdout' | 'stderr', text: string): void {
    const last = this.parts.at(-1)
    if (last?.stream === stream) last.text += text
    else this.parts.push({ stream, text })
    this.bytes += text.length
    if (this.bytes >= LOG_FLUSH_BYTES) this.flush()
    else
      this.timer ??= setTimeout(() => {
        this.flush()
      }, LOG_FLUSH_MS)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const parts = this.parts
    this.parts = []
    this.bytes = 0
    for (const p of parts) this.send(p.stream, p.text)
  }
}
