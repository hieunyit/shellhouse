import { randomUUID } from 'node:crypto'
import { lstat, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { t } from '@shared/i18n'
import type { HostModuleSession, TerminalSize } from '../../registry/host-types'
import type { Transport, TransportCallbacks } from '../../../session-host/transport/types'
import {
  DockerOp,
  DockerTerminalParams,
  isMutating,
  maskEnv,
  type BuildInfo,
  type BuildSpec,
  type ContainerFileList,
  type ContainerRow,
  type CopyResult,
  type EngineInfo,
  type RegistryAuth
} from '../shared/ops'
import { normalizeRegistry, registryOf } from '../shared/ipc'
import {
  authServer,
  buildArgs,
  cliErrorText,
  composeArgs,
  listCommand,
  parseListing,
  type DockerBackend,
  type DockerCli
} from './backend'
import { EngineError } from './engine'
import { extractTar, listFromTar, packPaths } from './tar'

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
  /**
   * Cờ chỉ đọc người dùng đã lưu (main giữ trong DB) cho nguồn này. `hostId` = host SSH do tab /
   * terminal báo (phiên SSH không biết mình là host đã lưu nào). Không có = chỉ dùng cờ renderer.
   */
  storedReadOnly?(hostId: string | undefined): Promise<boolean>
  /**
   * Đang dùng CLI dự phòng → thỉnh thoảng thử lại Engine API (socket vừa bật lại, lỗi mạng thoáng
   * qua lúc chọn). false cho Docker trong WSL (chỉ có CLI).
   */
  reprobeCli?: boolean
  /** Thông tin đăng nhập registry đã lưu (main giải mã từ vault). */
  registryAuth?(id: string): Promise<RegistryAuth>
}

/** Liệt kê qua archive (container không có shell): đọc tối đa chừng này rồi dừng. */
export const ARCHIVE_LIST_LIMIT = 256 * 1024 * 1024

const LOG_FLUSH_MS = 50
const STATS_ALL_MS = 3000
/** statsAll lỗi liên tiếp → giãn dần tới mức này. */
const STATS_ALL_MAX_MS = 30_000
/** Đang dùng CLI dự phòng: thử lại Engine API sau chừng này, chỉ khi có thao tác (test rút ngắn). */
export const cliReprobe = { ms: 2 * 60_000 }
/** Log dồn quá mức này thì gửi ngay (container in liên tục). */
const LOG_FLUSH_BYTES = 64 * 1024
/** Đọc lại cờ sau await (TS tưởng giá trị không đổi kể từ lần kiểm tra trước). */
const isAborted = (s: AbortSignal): boolean => s.aborted
/** Chờ trước khi theo dõi lại sự kiện Engine sau khi luồng đứt: base × 2^lần (test rút ngắn được). */
export const eventsRetry = { baseMs: 500, maxMs: 30_000 }

/** Ngủ `ms`, dậy sớm nếu bị huỷ. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

/** Shell mặc định khi vào container: bash nếu có, không thì sh. */
export const DEFAULT_SHELL = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']

/**
 * Lỗi đường truyền tới Engine (socket mất, kênh SSH đóng…) — khác lỗi Docker trả về (HTTP ≥ 400).
 * Gặp loại này thì bỏ backend đang giữ, lần sau kết nối lại từ đầu.
 */
export function isTransportError(error: unknown): boolean {
  if (error instanceof EngineError) return false
  const code = (error as { code?: unknown } | null)?.code
  if (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EACCES'].includes(code)
  )
    return true
  const message = error instanceof Error ? error.message : String(error)
  return /socket hang up|channel open fail|not connected|connection (?:lost|closed|reset)|No response from server/i.test(
    message
  )
}

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
  /** Backend đã kết nối xong (để so khi bỏ backend hỏng). */
  private resolved: DockerBackend | null = null
  private backendAt = 0
  private reprobing = false
  private readonly subscriptions = new Map<string, AbortController>()
  /** Huỷ khi dispose (thử lại API nền…). */
  private readonly lifetime = new AbortController()
  /** Cờ renderer gửi (configure). */
  private readOnly = false
  /** Host SSH renderer báo (configure) — để hỏi main cờ đã lưu. */
  private hostId: string | undefined
  private disposed = false

  constructor(private readonly deps: DockerServiceDeps) {}

  private getBackend(signal: AbortSignal): Promise<DockerBackend> {
    if (!this.backend) {
      const pending = this.deps.connect(signal)
      this.backend = pending
      this.backendAt = Date.now()
      pending.then(
        (b) => {
          if (this.backend === pending) this.resolved = b
        },
        // Lỗi → lần sau thử lại (Docker vừa được khởi động…).
        () => {
          if (this.backend === pending) this.backend = null
        }
      )
    } else this.maybeReprobe()
    return this.backend
  }

  /** Đang dùng CLI dự phòng đã lâu → nền: thử Engine API lại, được thì đổi sang. */
  private maybeReprobe(): void {
    const current = this.resolved
    if (
      this.deps.reprobeCli === false ||
      this.reprobing ||
      current?.via !== 'cli' ||
      Date.now() - this.backendAt < cliReprobe.ms
    )
      return
    this.reprobing = true
    this.backendAt = Date.now()
    this.deps
      .connect(this.lifetime.signal)
      .then(
        (next) => {
          if (next.via === 'api' && this.resolved === current && !this.disposed) {
            this.deps.log('info', 'the Docker socket is reachable again — using the Engine API')
            this.backend = Promise.resolve(next)
            this.resolved = next
          }
        },
        () => undefined
      )
      .finally(() => {
        this.reprobing = false
      })
  }

  /** Backend vừa lỗi đường truyền → bỏ, thao tác sau kết nối lại (không kẹt backend chết mãi). */
  private invalidate(failed: DockerBackend, error: unknown): void {
    if (failed.via !== 'api' || this.resolved !== failed || !isTransportError(error)) return
    this.deps.log(
      'warn',
      `lost the Docker engine (${error instanceof Error ? error.message : String(error)}) — will reconnect`
    )
    this.backend = null
    this.resolved = null
  }

  /**
   * Chỉ đọc nếu renderer báo HOẶC main đã lưu cờ cho nguồn này (không chỉ tin renderer). Hỏi main
   * lỗi → chỉ đọc. Phiên SSH không có hostId thì deps trả false mà không hỏi.
   */
  private async isReadOnly(hostId: string | undefined = this.hostId): Promise<boolean> {
    if (this.readOnly) return true
    if (!this.deps.storedReadOnly) return false
    try {
      return await this.deps.storedReadOnly(hostId)
    } catch (error) {
      // Không hỏi được main → coi như chỉ đọc (fail-closed): thà chặn nhầm còn hơn cho sửa nhầm.
      this.deps.log(
        'warn',
        `read-only flag unavailable, treating as read-only: ${error instanceof Error ? error.message : String(error)}`
      )
      return true
    }
  }

  async run(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const op = DockerOp.parse(raw)
    if (op.op === 'configure') {
      this.readOnly = op.readOnly
      this.hostId = op.hostId
      return null
    }
    if (op.op === 'unsubscribe') {
      this.subscriptions.get(op.subscription)?.abort()
      this.subscriptions.delete(op.subscription)
      return null
    }
    if (isMutating(op) && (await this.isReadOnly()))
      throw new Error(t('Read-only mode is on for this Docker — turn it off to make changes'))
    const backend = await this.getBackend(signal)
    try {
      return await this.runOp(op, backend, signal)
    } catch (error) {
      this.invalidate(backend, error)
      throw error
    }
  }

  private async runOp(op: DockerOp, backend: DockerBackend, signal: AbortSignal): Promise<unknown> {
    switch (op.op) {
      case 'configure':
      case 'unsubscribe':
        return null
      case 'info':
        return backend.info(signal) satisfies Promise<EngineInfo>
      case 'containers':
        return backend.containers(op.all, signal)
      case 'inspect': {
        const data = await backend.inspect(op.kind, op.id)
        return op.kind === 'container' && !op.reveal ? maskInspect(data) : data
      }
      case 'df':
        return backend.df(signal)
      case 'top':
        return backend.top(op.id)
      case 'image.history':
        return backend.imageHistory(op.id)
      case 'run':
        return { id: await backend.run(op.spec, signal) }
      case 'statsAll.subscribe':
        // Một mẫu cho mọi container đang chạy mỗi STATS_ALL_MS (như cột của `docker stats`).
        return this.subscribe('statsAll', async (id, s) => {
          // Lần đầu chưa có mẫu CPU để so (one-shot) → lấy lại sau 1 giây cho cột CPU hiện sớm.
          // Lỗi không nuốt im: báo tab (`error`), giãn nhịp hỏi; mất Engine → kết nối lại.
          let failures = 0
          for (let round = 0; !s.aborted; round++) {
            let current: DockerBackend | null = null
            try {
              current = await this.getBackend(s)
              const samples = await current.statsOnce(s)
              if (isAborted(s)) return
              failures = 0
              this.deps.emit('statsAll', { subscription: id, samples })
            } catch (error) {
              if (isAborted(s)) return
              if (current) this.invalidate(current, error)
              failures++
              this.deps.emit('statsAll', {
                subscription: id,
                samples: {},
                error: error instanceof Error ? error.message : String(error)
              })
            }
            await sleep(
              failures
                ? Math.min(STATS_ALL_MAX_MS, STATS_ALL_MS * 2 ** Math.min(failures - 1, 8))
                : round === 0
                  ? 1000
                  : STATS_ALL_MS,
              s
            )
          }
        })
      case 'logs.subscribeMany':
        return this.subscribe('logs', async (id, s) => {
          const batch = new Batcher((stream, text) => {
            this.deps.emit('logs', { subscription: id, stream, text })
          })
          try {
            // Một container lỗi (vừa bị xoá…) không làm đứt log của các container khác.
            const results = await Promise.allSettled(
              op.containers.map(async (c) => {
                const partial = { stdout: '', stderr: '' }
                const prefix = `[${c.name}] `
                try {
                  await backend.logs(
                    c.id,
                    op.tail,
                    op.timestamps,
                    (stream, text) => {
                      const lines = (partial[stream] + text).split('\n')
                      partial[stream] = lines.pop() ?? ''
                      if (lines.length)
                        batch.push(stream, lines.map((l) => `${prefix}${l}\n`).join(''))
                    },
                    s
                  )
                } catch (error) {
                  if (!isAborted(s))
                    batch.push(
                      'stderr',
                      `${prefix}${t('log stream failed: {error}', { error: error instanceof Error ? error.message : String(error) })}\n`
                    )
                  throw error
                } finally {
                  // Dòng cuối không có "\n" (container in rồi dừng) vẫn hiện.
                  for (const stream of ['stdout', 'stderr'] as const)
                    if (partial[stream]) batch.push(stream, `${prefix}${partial[stream]}\n`)
                }
              })
            )
            const failed = results.filter((r) => r.status === 'rejected')
            if (failed.length === results.length && failed[0]) throw failed[0].reason
          } finally {
            batch.flush()
          }
        })
      case 'action':
        await backend.action(op.id, op.action, op.force === true, op.volumes === true)
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
        // Luồng sự kiện đứt (daemon khởi động lại, socket / SSH chập chờn) → theo dõi lại, chờ tăng
        // dần; mỗi lần nối lại báo renderer tải lại (có thể đã lỡ sự kiện trong lúc đứt).
        return this.subscribe('engine', async (id, s) => {
          let failures = 0
          while (!isAborted(s)) {
            const started = Date.now()
            let current: DockerBackend | null = null
            try {
              // Lấy lại backend mỗi lần: Engine mất hẳn → kết nối lại thay vì gọi mãi backend chết.
              current = await this.getBackend(s)
              await current.events((e) => {
                this.deps.emit('engine', { subscription: id, ...e })
              }, s)
            } catch (error) {
              if (current && !isAborted(s)) this.invalidate(current, error)
              this.deps.log(
                'warn',
                `docker events: ${error instanceof Error ? error.message : String(error)}`
              )
            }
            if (isAborted(s)) return
            failures = Date.now() - started > 60_000 ? 1 : failures + 1
            await sleep(
              Math.min(eventsRetry.maxMs, eventsRetry.baseMs * 2 ** Math.min(failures, 16)),
              s
            )
            if (isAborted(s)) return
            this.deps.emit('engine', { subscription: id, action: 'reconnect', id: '' })
          }
        })
      case 'images':
        return backend.images(signal)
      case 'image.remove':
        await backend.imageRemove(op.id, op.force === true)
        return null
      case 'image.pull':
      case 'image.push': {
        const kind = op.op === 'image.pull' ? 'pull' : 'push'
        // Lấy thông tin đăng nhập trước khi trả id đăng ký: lỗi (registry đã xoá…) báo ngay.
        const auth = await this.auth(op.registry, op.ref)
        return this.subscribe(kind, async (id, s) => {
          const progress = (status: string, value: number | null): void => {
            this.deps.emit(kind, { subscription: id, status, progress: value, done: false })
          }
          if (kind === 'pull') await backend.imagePull(op.ref, auth, progress, s)
          else await backend.imagePush(op.ref, auth, progress, s)
          this.deps.emit(kind, { subscription: id, status: t('Done'), progress: 1, done: true })
        })
      }
      case 'image.tag':
        await backend.imageTag(op.id, op.target)
        return null
      case 'registry.check': {
        const auth = await this.registry(op.registry)
        return { status: await backend.registryLogin(auth, signal) }
      }
      case 'build':
        return this.build(op.spec)
      case 'build.info':
        return this.buildInfo(signal)
      case 'volume.create':
        return { name: await backend.volumeCreate(op.spec) }
      case 'network.create':
        return { id: await backend.networkCreate(op.spec) }
      case 'network.connect':
        await backend.networkConnect(op.network, op.container, op.aliases, op.ipv4)
        return null
      case 'network.disconnect':
        await backend.networkDisconnect(op.network, op.container, op.force)
        return null
      case 'files.list':
        return this.listFiles(backend, op.id, op.path, signal)
      case 'files.download':
        return this.download(backend, op.id, op.paths, op.localDir, signal)
      case 'files.upload':
        return this.upload(backend, op.id, op.dir, op.localPaths, signal)
      case 'volumes':
        return backend.volumes(signal)
      case 'volumes.sizes':
        return backend.volumeSizes(signal)
      case 'volume.remove':
        await backend.volumeRemove(op.name)
        return null
      case 'networks':
        return backend.networks(signal)
      case 'network.remove':
        await backend.networkRemove(op.id)
        return null
      case 'prune':
        return backend.prune(op.what, op.dryRun, op.all === true)
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
          if (kind === 'pull' || kind === 'push')
            this.deps.emit(kind, {
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
        // Luồng con còn sót (nhánh khác của log nhiều container…) dừng theo, không chạy mồ côi.
        controller.abort()
      })
    return { subscription: id }
  }

  /** Thông tin đăng nhập của registry đã lưu. */
  private async registry(id: string): Promise<RegistryAuth> {
    if (!this.deps.registryAuth) throw new Error(t('Saved registries are not available here.'))
    return this.deps.registryAuth(id)
  }

  /**
   * Thông tin đăng nhập cho một image: chỉ khi registry đã lưu ĐÚNG là máy chủ của image — không
   * gửi mật khẩu của registry này tới máy chủ khác (renderer chọn nhầm / bị lừa).
   */
  private async auth(id: string | null | undefined, ref: string): Promise<RegistryAuth | null> {
    if (!id) return null
    const auth = await this.registry(id)
    if (normalizeRegistry(auth.server) !== registryOf(ref))
      throw new Error(
        t('The image {ref} is not on {server} — pick the matching registry.', {
          ref,
          server: normalizeRegistry(auth.server)
        })
      )
    return auth
  }

  /**
   * Đăng nhập registry cho `docker buildx build --push`: chỉ khi chọn registry đã lưu VÀ mọi tag nằm
   * đúng trên registry đó. `pre` = `--config <thư mục tạm>` đặt trước lệnh; `done` xoá thư mục.
   */
  private async buildLogin(
    spec: BuildSpec,
    signal: AbortSignal
  ): Promise<{ pre: string[]; done: () => Promise<void> }> {
    const none = { pre: [] as string[], done: () => Promise.resolve() }
    if (spec.output !== 'push' || !spec.registry) return none
    let auth: RegistryAuth | null = null
    for (const tag of spec.tags) auth = await this.auth(spec.registry, tag)
    if (!auth) return none
    if (!this.deps.cli.tempDir)
      throw new Error(t('Signing in to a registry is not available with this Docker connection.'))
    const dir = await this.deps.cli.tempDir()
    const done = (): Promise<void> => dir.remove().catch(() => undefined)
    try {
      const pre = ['--config', dir.path]
      const r = await this.deps.cli.exec(
        [...pre, 'login', '--username', auth.username, '--password-stdin', authServer(auth.server)],
        { input: auth.password, signal, timeoutMs: 60_000 }
      )
      if (r.code !== 0) throw new Error(cliErrorText(r.stderr, r.code))
      return { pre, done }
    } catch (error) {
      await done()
      throw error
    }
  }

  /** Buildx (phiên bản, builder, nền tảng) trên máy chạy Docker — không có thì `buildx: null`. */
  private async buildInfo(signal: AbortSignal): Promise<BuildInfo> {
    const exec = (args: string[]): Promise<{ code: number | null; stdout: string } | null> =>
      this.deps.cli.exec(args, { signal, timeoutMs: 15_000 }).catch(() => null)
    const v = await exec(['buildx', 'version'])
    if (!v || v.code !== 0) return { buildx: null, builders: [] }
    const version = /v?(\d+\.\d+\.\d+[\w.+-]*)/.exec(v.stdout)?.[1] ?? v.stdout.trim().slice(0, 40)
    const ls = await exec(['buildx', 'ls', '--format', '{{json .}}'])
    const builders: BuildInfo['builders'] = []
    for (const line of (ls?.code === 0 ? ls.stdout : '').split('\n')) {
      if (!line.trim().startsWith('{')) continue
      try {
        const b = JSON.parse(line) as {
          Name?: unknown
          Driver?: unknown
          Current?: unknown
          Nodes?: { Platforms?: unknown }[]
        }
        if (typeof b.Name !== 'string') continue
        const platforms = new Set<string>()
        for (const n of b.Nodes ?? []) {
          const raw = n.Platforms
          const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
          for (const p of list)
            if (typeof p === 'string') platforms.add(p.trim().replace(/\*$/, ''))
        }
        builders.push({
          name: b.Name,
          driver: typeof b.Driver === 'string' ? b.Driver : '',
          current: b.Current === true,
          platforms: [...platforms].filter(Boolean)
        })
      } catch {
        // Dòng không đọc được — bỏ qua.
      }
    }
    return { buildx: version, builders }
  }

  /**
   * `docker build` (BuildKit, output chữ) chạy bằng CLI trên máy chạy Docker — context là thư mục
   * ở đó (server với SSH). Engine API cần gửi cả context dạng tar từ máy này, nên không dùng.
   */
  private build(spec: BuildSpec): { subscription: string } {
    return this.subscribe('build', async (id, s) => {
      const batch = new Batcher((_stream, text) => {
        this.deps.emit('build', { subscription: id, text })
      })
      const tail: string[] = []
      const remember = (text: string): void => {
        for (const line of text.split('\n')) if (line.trim()) tail.push(line)
        if (tail.length > 20) tail.splice(0, tail.length - 20)
      }
      // `--push` qua CLI: đăng nhập registry đã lưu vào thư mục `--config` tạm, xoá ngay khi xong.
      const login = await this.buildLogin(spec, s)
      let program
      try {
        program = await this.deps.cli.spawn([...login.pre, ...buildArgs(spec)], s)
      } catch (error) {
        await login.done()
        throw new Error(
          t('Building images needs the docker command where Docker runs: {error}', {
            error: error instanceof Error ? error.message : String(error)
          }),
          { cause: error }
        )
      }
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
      const on = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
        const text = decoders[stream].decode(chunk, { stream: true })
        if (!text) return
        remember(text)
        batch.push(stream, text)
      }
      program.onStdout(on('stdout'))
      program.onStderr(on('stderr'))
      const code = await new Promise<number | null>((resolve) => {
        program.onExit(resolve)
      })
      await login.done()
      batch.flush()
      if (isAborted(s)) return
      if (code !== 0) {
        const last = tail.filter((l) => /error|failed/i.test(l)).at(-1) ?? tail.at(-1)
        throw new Error(
          code === 127
            ? cliErrorText('', 127)
            : (last ?? t('docker exited with code {code}', { code: code ?? '?' }))
        )
      }
    })
  }

  /**
   * Thư mục trong container: `sh` + `stat` (nhanh, đủ thông tin); container không có shell
   * (distroless) hoặc đang dừng → đọc tar của thư mục qua archive.
   */
  private async listFiles(
    backend: DockerBackend,
    id: string,
    path: string,
    signal: AbortSignal
  ): Promise<ContainerFileList> {
    let execError: unknown = null
    let result: Awaited<ReturnType<DockerBackend['execCapture']>> | null = null
    try {
      result = await backend.execCapture(id, listCommand(path), signal)
    } catch (error) {
      if (signal.aborted) throw error
      execError = error
    }
    if (result?.code === 0)
      return { path, entries: parseListing(result.stdout), via: 'exec', truncated: false }
    // Mã 3 = `cd` lỗi (không có / không phải thư mục / không có quyền) — báo luôn, không thử archive.
    if (result?.code === 3)
      throw new Error(
        t('Cannot open {path}: {error}', {
          path,
          error:
            result.stderr
              .trim()
              .split('\n')
              .pop()
              ?.replace(/^.*:\s*/, '') || t('not a folder')
        })
      )
    if (result) execError = new Error(result.stderr.trim() || `exit ${String(result.code)}`)
    this.deps.log(
      'info',
      `files: exec failed (${execError instanceof Error ? execError.message : String(execError)}) — reading the archive`
    )
    const controller = new AbortController()
    const stop = (): void => {
      controller.abort()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      const source = await backend.archive(id, path, controller.signal)
      const { entries, truncated } = await listFromTar(source, ARCHIVE_LIST_LIMIT, path === '/')
      return { path, entries, via: 'archive', truncated }
    } finally {
      signal.removeEventListener('abort', stop)
      // Dừng sớm (thư mục quá lớn) → đóng luồng còn dở.
      controller.abort()
    }
  }

  private async download(
    backend: DockerBackend,
    id: string,
    paths: readonly string[],
    localDir: string,
    signal: AbortSignal
  ): Promise<CopyResult> {
    if (!isAbsolute(localDir)) throw new Error(t('Choose a folder on this computer'))
    const st = await stat(localDir).catch(() => null)
    if (!st?.isDirectory())
      throw new Error(t('The folder {path} does not exist', { path: localDir }))
    const result: CopyResult = { files: 0, bytes: 0, skipped: 0, saved: [] }
    for (const path of paths) {
      if (path === '/')
        throw new Error(t('Pick files or folders inside the container, not / itself'))
      const source = await backend.archive(id, path, signal)
      await extractTar(source, localDir, result)
    }
    return result
  }

  private async upload(
    backend: DockerBackend,
    id: string,
    dir: string,
    localPaths: readonly string[],
    signal: AbortSignal
  ): Promise<CopyResult> {
    for (const p of localPaths) {
      if (!isAbsolute(p)) throw new Error(t('Choose files on this computer'))
      if (!(await lstat(p).catch(() => null)))
        throw new Error(t('{path} no longer exists', { path: p }))
    }
    const stats = { files: 0, bytes: 0, skipped: 0 }
    await backend.putArchive(id, dir, packPaths(localPaths, stats), signal)
    return { ...stats, saved: [] }
  }

  private async compose(
    backend: DockerBackend,
    project: string,
    action: 'start' | 'stop' | 'restart' | 'up' | 'down' | 'pull',
    signal: AbortSignal
  ): Promise<string> {
    const members = (await backend.containers(true, signal)).filter((c) => c.project === project)
    if (action === 'start' || action === 'stop' || action === 'restart') {
      if (members.length === 0)
        throw new Error(t('No containers in the Compose project {project}', { project }))
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

  async openTerminal(raw: unknown, size: TerminalSize, cb: TransportCallbacks): Promise<Transport> {
    const params = DockerTerminalParams.parse(raw)
    // Shell / exec chạy được mọi lệnh trong container → chặn ở chế độ chỉ đọc (cờ main đã lưu).
    if (await this.isReadOnly(params.hostId ?? this.hostId))
      throw new Error(t('Read-only mode is on for this Docker — shells and exec are turned off'))
    return this.deps.openPty(execArgs(params), size, cb)
  }

  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
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
