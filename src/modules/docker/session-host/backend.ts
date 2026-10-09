import { t } from '@shared/i18n'
import { normalizeRegistry } from '../shared/ipc'
import type {
  BuildSpec,
  ContainerFileEntry,
  NetworkSpec,
  RegistryAuth,
  VolumeSpec,
  DiskUsage,
  ImageLayer,
  ProcessList,
  RunSpec,
  ComposeAction,
  ContainerAction,
  ContainerRow,
  EngineInfo,
  ImageRow,
  NetworkRow,
  PruneResult,
  PruneTarget,
  StatsSample,
  VolumeRow
} from '../shared/ops'

/**
 * Hai cách nói chuyện với Docker cùng một giao diện: Engine API (socket — cách chính) và `docker`
 * CLI (dự phòng khi server tắt streamlocal / socket ở chỗ lạ).
 */
export interface DockerBackend {
  readonly via: 'api' | 'cli'
  info(signal: AbortSignal): Promise<EngineInfo>
  containers(all: boolean, signal: AbortSignal): Promise<ContainerRow[]>
  inspect(kind: 'container' | 'image' | 'volume' | 'network', id: string): Promise<unknown>
  /** remove: `force` = dừng trước nếu đang chạy; `volumes` = xoá cả volume ẩn danh. */
  action(id: string, action: ContainerAction, force: boolean, volumes?: boolean): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Chạy tới khi luồng kết thúc / bị huỷ. */
  logs(
    id: string,
    tail: number,
    timestamps: boolean,
    onData: (stream: 'stdout' | 'stderr', text: string) => void,
    signal: AbortSignal
  ): Promise<void>
  stats(id: string, onSample: (s: StatsSample) => void, signal: AbortSignal): Promise<void>
  /** Container thay đổi (tạo, chạy, dừng, xoá…). */
  events(onEvent: (e: { action: string; id: string }) => void, signal: AbortSignal): Promise<void>
  images(signal: AbortSignal): Promise<ImageRow[]>
  imageRemove(id: string, force: boolean): Promise<void>
  /** `auth` = thông tin đăng nhập registry (null = ảnh công khai). */
  imagePull(
    ref: string,
    auth: RegistryAuth | null,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void>
  imagePush(
    ref: string,
    auth: RegistryAuth | null,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void>
  /** `docker tag <id> <target>`. */
  imageTag(id: string, target: string): Promise<void>
  /** Thử đăng nhập; trả câu trạng thái của registry ("Login Succeeded"). */
  registryLogin(auth: RegistryAuth, signal: AbortSignal): Promise<string>
  volumes(signal: AbortSignal): Promise<VolumeRow[]>
  /** Tên volume → byte đã dùng (không biết → không có trong kết quả). */
  volumeSizes(signal: AbortSignal): Promise<Record<string, number>>
  volumeRemove(name: string): Promise<void>
  /** Trả tên volume (Docker tự đặt nếu để trống). */
  volumeCreate(spec: VolumeSpec): Promise<string>
  networks(signal: AbortSignal): Promise<NetworkRow[]>
  networkRemove(id: string): Promise<void>
  /** Trả id network. */
  networkCreate(spec: NetworkSpec): Promise<string>
  networkConnect(
    network: string,
    container: string,
    aliases: readonly string[],
    ipv4: string | undefined
  ): Promise<void>
  networkDisconnect(network: string, container: string, force: boolean): Promise<void>
  /**
   * Volume: `all` = cả volume có tên (mặc định chỉ volume ẩn danh, xem `isAnonymousVolume`).
   * Image: `all` = mọi image không dùng (mặc định chỉ image dangling).
   */
  prune(what: PruneTarget, dryRun: boolean, all?: boolean): Promise<PruneResult>
  df(signal: AbortSignal): Promise<DiskUsage>
  /** Một mẫu CPU / RAM cho mọi container đang chạy (khoá = id container). */
  statsOnce(signal: AbortSignal): Promise<Record<string, StatsSample>>
  top(id: string): Promise<ProcessList>
  imageHistory(id: string): Promise<ImageLayer[]>
  /** Tạo + chạy container; trả id. */
  run(spec: RunSpec, signal: AbortSignal): Promise<string>
  /** Chạy lệnh (không TTY) trong container đang chạy, đợi xong. */
  execCapture(
    id: string,
    cmd: readonly string[],
    signal: AbortSignal
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
  /** Tar của một đường dẫn trong container (chạy cả khi container đang dừng). */
  archive(id: string, path: string, signal: AbortSignal): Promise<AsyncIterable<Buffer>>
  /** Giải nén tar vào thư mục `dir` (đã có) trong container. */
  putArchive(
    id: string,
    dir: string,
    tar: AsyncIterable<Buffer>,
    signal: AbortSignal
  ): Promise<void>
}

/** Lệnh `docker …` (máy này hoặc qua SSH) — cho compose up/down/pull và CLI dự phòng. */
export interface DockerCli {
  exec(
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number; input?: string | Buffer }
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
  spawn(
    args: readonly string[],
    signal: AbortSignal
  ): Promise<{
    onStdout(l: (c: Buffer) => void): void
    onStderr(l: (c: Buffer) => void): void
    onExit(l: (code: number | null) => void): void
    kill(): void
  }>
  /**
   * Thư mục tạm (quyền 700) trên máy chạy `docker` — làm `--config` riêng cho một lần đăng nhập
   * registry (không ghi thông tin đăng nhập vào ~/.docker của người dùng). Không có = CLI không đăng
   * nhập registry được.
   */
  tempDir?(): Promise<{ path: string; remove(): Promise<void> }>
}

/**
 * Địa chỉ đăng nhập: Docker Hub dùng "https://index.docker.io/v1/" (khoá trong config.json của
 * Docker), registry khác dùng tên máy (có cổng).
 */
export function authServer(server: string): string {
  const host = normalizeRegistry(server)
  return host === 'docker.io' ? 'https://index.docker.io/v1/' : host
}

/** Header `X-Registry-Auth`: JSON base64url (như Docker CLI). */
export function registryAuthHeader(auth: RegistryAuth | null): string {
  const json = auth
    ? { username: auth.username, password: auth.password, serveraddress: authServer(auth.server) }
    : {}
  return Buffer.from(JSON.stringify(json)).toString('base64url')
}

export const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none'])

/** Nhãn Docker ≥ 23 gắn cho volume ẩn danh (`docker volume prune` mặc định chỉ xoá loại này). */
export const ANONYMOUS_VOLUME_LABEL = 'com.docker.volume.anonymous'

/**
 * Volume ẩn danh: có nhãn của Docker ≥ 23, hoặc tên 64 ký tự hex (volume ẩn danh tạo trước Docker
 * 23 không có nhãn). Xem trước và thao tác xoá dùng CÙNG hàm này → danh sách xem trước khớp đúng
 * những gì bị xoá, trên mọi phiên bản Engine / CLI.
 */
export function isAnonymousVolume(
  name: string,
  labels: Record<string, string> | null | undefined
): boolean {
  return (labels ?? {})[ANONYMOUS_VOLUME_LABEL] !== undefined || /^[0-9a-f]{64}$/.test(name)
}

/** Lỗi của docker CLI → câu dễ hiểu (không tự dùng sudo — ADR-014 mục 6.2). */
export function cliErrorText(stderr: string, code: number | null): string {
  const text = stderr.trim()
  if (/permission denied.*docker(\.sock| daemon)/i.test(text))
    return t(
      "Your user can't access the Docker socket on this server. Add it to the `docker` group (then log in again) or use a user that can."
    )
  if (code === 127 || /command not found|not recognized as an internal/i.test(text))
    return t('Docker is not installed here (the `docker` command was not found).')
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(text))
    return t('Docker is installed but not running.')
  return (
    text.split('\n').slice(-3).join(' ') ||
    t('docker exited with code {code}', { code: code ?? '?' })
  )
}

/** Tham số `docker compose` cho một project (thư mục + file lấy từ nhãn của container). */
export function composeArgs(
  project: string,
  action: ComposeAction,
  dir: string | null,
  files: string | null
): string[] {
  const base = ['compose', '-p', project]
  if (dir) base.push('--project-directory', dir)
  for (const f of (files ?? '').split(',').filter(Boolean)) base.push('-f', f)
  switch (action) {
    case 'up':
      return [...base, 'up', '-d']
    case 'down':
      return [...base, 'down']
    case 'pull':
      return [...base, 'pull']
    default:
      return [...base, action]
  }
}

/** "1.5GB", "12.3MiB", "0B" → byte. */
export function parseSize(text: string): number {
  const m = /^\s*([\d.]+)\s*([kKMGTP]?i?)B?\s*$/.exec(text)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2] ?? ''
  const base = unit.includes('i') ? 1024 : 1000
  const power = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit.replace('i', '')] ?? 0
  return Math.round(n * base ** power)
}

/** Chạy hàm cho từng phần tử, tối đa `limit` cùng lúc. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i] as T)
      }
    })
  )
  return out
}

/** Tham số `docker run -d` cho CLI. */
export function runArgs(spec: RunSpec): string[] {
  return [
    'run',
    '-d',
    ...(spec.name ? ['--name', spec.name] : []),
    ...spec.ports.flatMap((p) => [
      '-p',
      `${p.host ? `${p.host}:` : ''}${p.container}/${p.protocol}`
    ]),
    ...spec.env.flatMap((e) => ['-e', e]),
    ...spec.volumes.flatMap((v) => ['-v', `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`]),
    ...(spec.restart !== 'no' ? ['--restart', spec.restart] : []),
    ...(spec.autoRemove ? ['--rm'] : []),
    '--pull',
    spec.pull ? 'missing' : 'never',
    spec.image,
    ...(spec.command ?? [])
  ]
}

/**
 * Tham số `docker build` (BuildKit, output dạng chữ để hiện trực tiếp). Dockerfile tương đối tính
 * từ context (CLI tính `-f` theo thư mục hiện tại — qua SSH là thư mục nhà, không phải context).
 */
export function buildArgs(spec: BuildSpec): string[] {
  const dockerfile = spec.dockerfile?.trim()
  const absolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
  const file =
    dockerfile && !absolute(dockerfile)
      ? `${spec.context.replace(/[\\/]+$/, '')}/${dockerfile}`
      : dockerfile
  const platforms = spec.platforms ?? []
  // Nền tảng / output / builder → buildx; không thì `docker build` như trước.
  const buildx = platforms.length > 0 || spec.output !== undefined || spec.builder !== undefined
  return [
    ...(buildx
      ? ['buildx', 'build', ...(spec.builder ? ['--builder', spec.builder] : [])]
      : ['build']),
    '--progress=plain',
    ...(file ? ['-f', file] : []),
    ...spec.tags.flatMap((tag) => ['-t', tag]),
    ...spec.buildArgs.flatMap((a) => ['--build-arg', a]),
    ...(spec.target ? ['--target', spec.target] : []),
    ...(platforms.length ? ['--platform', platforms.join(',')] : []),
    ...(spec.output === 'push' ? ['--push'] : spec.output === 'load' ? ['--load'] : []),
    ...(spec.noCache ? ['--no-cache'] : []),
    ...(spec.pull ? ['--pull'] : []),
    '--',
    spec.context
  ]
}

/**
 * Liệt kê thư mục bằng `sh` trong container (không cần `ls` của GNU): dòng "kiểu/tên" cho từng mục,
 * rồi "--", rồi `stat -c` của cả thư mục một lần (busybox và GNU đều có; thiếu `stat` thì chỉ không
 * có kích thước / ngày).
 */
export const LIST_SCRIPT = [
  'cd -- "$1" || exit 3',
  'for f in * .[!.]* ..?*; do',
  '  if [ -L "$f" ]; then if [ -d "$f" ]; then t=L; else t=l; fi',
  '  elif [ -d "$f" ]; then t=d',
  '  elif [ -f "$f" ]; then t=f',
  '  elif [ -e "$f" ]; then t=o',
  '  else continue; fi',
  '  printf \'%s/%s\\n\' "$t" "$f"',
  'done',
  "printf '%s\\n' --",
  "stat -c '%s/%Y/%A/%n' -- * .[!.]* ..?* 2>/dev/null",
  'exit 0'
].join('\n')

export function listCommand(path: string): string[] {
  return ['sh', '-c', LIST_SCRIPT, 'sh', path]
}

/** Output của LIST_SCRIPT → danh sách mục. */
export function parseListing(stdout: string): ContainerFileEntry[] {
  const lines = stdout.split('\n')
  const sep = lines.indexOf('--')
  const head = sep >= 0 ? lines.slice(0, sep) : lines
  const stats = new Map<string, { size: number; mtime: number; mode: string }>()
  for (const line of sep >= 0 ? lines.slice(sep + 1) : []) {
    const m = /^(\d+)\/(\d+)\/([-a-zA-Z?]{10}[.+]?)\/(.+)$/.exec(line)
    if (m)
      stats.set(m[4] ?? '', { size: Number(m[1]), mtime: Number(m[2]) * 1000, mode: m[3] ?? '' })
  }
  const out: ContainerFileEntry[] = []
  for (const line of head) {
    const m = /^([dfoLl])\/(.+)$/.exec(line)
    if (!m) continue
    const kind = m[1] ?? 'o'
    const name = m[2] ?? ''
    const st = stats.get(name)
    out.push({
      name,
      type: kind === 'd' ? 'dir' : kind === 'f' ? 'file' : kind === 'o' ? 'other' : 'link',
      ...(kind === 'L' ? { linkDir: true } : {}),
      size: kind === 'f' && st ? st.size : null,
      mtime: st?.mtime ?? null,
      mode: st?.mode ?? null
    })
  }
  return out
}

/** Hàng đợi chuyển callback (stdout của tiến trình) thành luồng đọc bằng `for await`. */
export class ChunkQueue implements AsyncIterable<Buffer> {
  private readonly chunks: Buffer[] = []
  private ended = false
  private failure: unknown = null
  private wake: (() => void) | null = null

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.notify()
  }

  end(error?: unknown): void {
    this.ended = true
    if (error !== undefined) this.failure = error
    this.notify()
  }

  private notify(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    for (;;) {
      const next = this.chunks.shift()
      if (next) {
        yield next
        continue
      }
      if (this.ended) {
        if (this.failure)
          throw this.failure instanceof Error
            ? this.failure
            : new Error(typeof this.failure === 'string' ? this.failure : 'Stream failed')
        return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}
