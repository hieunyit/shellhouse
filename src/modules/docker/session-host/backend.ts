import type {
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
  action(id: string, action: ContainerAction, force: boolean): Promise<void>
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
  imagePull(
    ref: string,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void>
  volumes(signal: AbortSignal): Promise<VolumeRow[]>
  volumeRemove(name: string): Promise<void>
  networks(signal: AbortSignal): Promise<NetworkRow[]>
  networkRemove(id: string): Promise<void>
  prune(what: PruneTarget, dryRun: boolean): Promise<PruneResult>
  df(signal: AbortSignal): Promise<DiskUsage>
  /** Một mẫu CPU / RAM cho mọi container đang chạy (khoá = id container). */
  statsOnce(signal: AbortSignal): Promise<Record<string, StatsSample>>
  top(id: string): Promise<ProcessList>
  imageHistory(id: string): Promise<ImageLayer[]>
  /** Tạo + chạy container; trả id. */
  run(spec: RunSpec, signal: AbortSignal): Promise<string>
}

/** Lệnh `docker …` (máy này hoặc qua SSH) — cho compose up/down/pull và CLI dự phòng. */
export interface DockerCli {
  exec(
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number }
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
}

export const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none'])

/** Lỗi của docker CLI → câu dễ hiểu (không tự dùng sudo — ADR-014 mục 6.2). */
export function cliErrorText(stderr: string, code: number | null): string {
  const text = stderr.trim()
  if (/permission denied.*docker(\.sock| daemon)/i.test(text))
    return "Your user can't access the Docker socket on this server. Add it to the `docker` group (then log in again) or use a user that can."
  if (code === 127 || /command not found|not recognized as an internal/i.test(text))
    return 'Docker is not installed here (the `docker` command was not found).'
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(text))
    return 'Docker is installed but not running.'
  return text.split('\n').slice(-3).join(' ') || `docker exited with code ${code ?? '?'}`
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
