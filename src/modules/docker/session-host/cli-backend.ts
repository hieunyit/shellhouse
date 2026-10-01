import type {
  DiskUsage,
  ImageLayer,
  ProcessList,
  RunSpec,
  ContainerRow,
  EngineInfo,
  ImageRow,
  NetworkRow,
  PortMapping,
  PruneResult,
  PruneTarget,
  StatsSample,
  VolumeRow
} from '../shared/ops'
import {
  BUILTIN_NETWORKS,
  cliErrorText,
  parseSize,
  runArgs,
  type DockerBackend,
  type DockerCli
} from './backend'

/**
 * Docker qua `docker` CLI với `--format '{{json .}}'` (ADR-014 mục 6.2, dự phòng): khi server tắt
 * `AllowStreamLocalForwarding` hoặc socket ở chỗ khác. Chậm hơn API (mỗi thao tác một tiến trình).
 */

function jsonLines<T>(stdout: string): T[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T]
      } catch {
        return []
      }
    })
}

/** "a=b,c=d" → object (giá trị có dấu phẩy thì phần sau bị cắt — chỉ dùng cho nhãn compose). */
export function parseLabels(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (text ?? '').split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return out
}

/** "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp" → danh sách cổng. */
export function parsePorts(text: string | undefined): PortMapping[] {
  const out: PortMapping[] = []
  for (const part of (text ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(?:(.*):(\d+)(?:-\d+)?->)?(\d+)(?:-\d+)?\/(\w+)$/.exec(part)
    if (!m) continue
    out.push({
      ip: m[1] ?? '',
      publicPort: m[2] ? Number(m[2]) : null,
      privatePort: Number(m[3]),
      type: m[4] ?? 'tcp'
    })
  }
  return out
}

/** "2024-05-01 10:00:00 +0000 UTC" → ms. */
/**
 * Ngày của `docker … --format json`: "2026-09-30 07:48:41 +0700 +07" / "… +0000 UTC" (tên múi giờ
 * cuối có thể là chữ hoặc số — bỏ qua, dùng độ lệch +0700).
 */
export function parseCliDate(text: string | undefined): number {
  if (!text) return 0
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(?:([+-])(\d{2}):?(\d{2})|Z)?/.exec(
      text.trim()
    )
  if (!m) return 0
  const zone = m[4] ? `${m[4]}${m[5] ?? '00'}:${m[6] ?? '00'}` : 'Z'
  const t = Date.parse(`${m[1] ?? ''}T${m[2] ?? ''}${(m[3] ?? '').slice(0, 4)}${zone}`)
  return Number.isFinite(t) ? t : 0
}

export class CliBackend implements DockerBackend {
  readonly via = 'cli' as const

  constructor(private readonly cli: DockerCli) {}

  private async sh(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const r = await this.cli.exec(args, { ...(signal ? { signal } : {}), timeoutMs: 120_000 })
    if (r.code !== 0) throw new Error(cliErrorText(r.stderr, r.code))
    return r.stdout
  }

  async info(signal: AbortSignal): Promise<EngineInfo> {
    const [version, info] = await Promise.all([
      this.sh(['version', '--format', '{{json .}}'], signal),
      this.sh(['info', '--format', '{{json .}}'], signal)
    ])
    const v =
      (
        JSON.parse(version) as {
          Server?: {
            Version?: string
            ApiVersion?: string
            Os?: string
            Arch?: string
            Platform?: { Name?: string }
          }
        }
      ).Server ?? {}
    const i = JSON.parse(info) as {
      Containers?: number
      ContainersRunning?: number
      Images?: number
      OperatingSystem?: string
    }
    const flavor = /podman/i.test(v.Platform?.Name ?? '') ? 'Podman' : 'Docker Engine'
    return {
      version: `${flavor} ${v.Version ?? '?'}`,
      apiVersion: v.ApiVersion ?? '',
      os: [i.OperatingSystem, v.Arch].filter(Boolean).join(' · '),
      containers: i.Containers ?? 0,
      running: i.ContainersRunning ?? 0,
      images: i.Images ?? 0,
      via: 'cli',
      flavor
    }
  }

  async containers(all: boolean, signal: AbortSignal): Promise<ContainerRow[]> {
    const out = await this.sh(
      ['ps', ...(all ? ['-a'] : []), '--no-trunc', '--format', '{{json .}}'],
      signal
    )
    return jsonLines<{
      ID: string
      Names: string
      Image: string
      State: string
      Status: string
      CreatedAt: string
      Ports: string
      Labels: string
    }>(out).map((c) => {
      const labels = parseLabels(c.Labels)
      return {
        id: c.ID,
        name: c.Names.split(',')[0] ?? c.ID.slice(0, 12),
        image: c.Image,
        state: c.State.toLowerCase(),
        status: c.Status,
        created: parseCliDate(c.CreatedAt),
        ports: parsePorts(c.Ports),
        project: labels['com.docker.compose.project'] ?? null,
        service: labels['com.docker.compose.service'] ?? null,
        composeDir: labels['com.docker.compose.project.working_dir'] ?? null,
        composeFiles: labels['com.docker.compose.project.config_files'] ?? null
      }
    })
  }

  async inspect(kind: 'container' | 'image' | 'volume' | 'network', id: string): Promise<unknown> {
    const out = await this.sh(['inspect', '--type', kind, id])
    const parsed = JSON.parse(out) as unknown[]
    return parsed[0] ?? null
  }

  async action(id: string, action: string, force: boolean): Promise<void> {
    await this.sh(action === 'remove' ? ['rm', ...(force ? ['-f'] : []), id] : [action, id])
  }

  async rename(id: string, name: string): Promise<void> {
    await this.sh(['rename', id, name])
  }

  /** Chạy một lệnh dài, chuyển output theo luồng tới khi thoát / bị huỷ. */
  private async follow(
    args: readonly string[],
    onData: (stream: 'stdout' | 'stderr', chunk: Buffer) => void,
    signal: AbortSignal
  ): Promise<void> {
    const program = await this.cli.spawn(args, signal)
    const errors: Buffer[] = []
    program.onStdout((c) => {
      onData('stdout', c)
    })
    program.onStderr((c) => {
      if (errors.length < 16) errors.push(c)
      onData('stderr', c)
    })
    const code = await new Promise<number | null>((resolve) => {
      program.onExit(resolve)
    })
    if (!signal.aborted && code !== 0 && code !== null)
      throw new Error(cliErrorText(Buffer.concat(errors).toString('utf8'), code))
  }

  async logs(
    id: string,
    tail: number,
    timestamps: boolean,
    onData: (stream: 'stdout' | 'stderr', text: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    await this.follow(
      ['logs', '--follow', '--tail', String(tail), ...(timestamps ? ['--timestamps'] : []), id],
      (stream, chunk) => {
        const text = decoders[stream].decode(chunk, { stream: true })
        if (text) onData(stream, text)
      },
      signal
    )
  }

  async stats(id: string, onSample: (s: StatsSample) => void, signal: AbortSignal): Promise<void> {
    // `docker stats` dạng luồng vẽ lại màn hình bằng mã điều khiển → hỏi từng mẫu mỗi 2 giây.
    while (!signal.aborted) {
      const out = await this.sh(['stats', '--no-stream', '--format', '{{json .}}', id], signal)
      const s = jsonLines<{ CPUPerc?: string; MemUsage?: string; NetIO?: string }>(out)[0]
      if (s) {
        const [used, limit] = (s.MemUsage ?? '').split('/')
        const [rx, tx] = (s.NetIO ?? '').split('/')
        onSample({
          at: Date.now(),
          cpuPercent: Number.parseFloat(s.CPUPerc ?? '0') || 0,
          memUsage: parseSize(used ?? ''),
          memLimit: parseSize(limit ?? ''),
          netRx: parseSize(rx ?? ''),
          netTx: parseSize(tx ?? '')
        })
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  async events(
    onEvent: (e: { action: string; id: string }) => void,
    signal: AbortSignal
  ): Promise<void> {
    let pending = ''
    await this.follow(
      ['events', '--filter', 'type=container', '--format', '{{json .}}'],
      (stream, chunk) => {
        if (stream !== 'stdout') return
        pending += chunk.toString('utf8')
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const e of jsonLines<{ Action?: string; Actor?: { ID?: string }; id?: string }>(
          lines.join('\n')
        ))
          onEvent({ action: e.Action ?? '', id: e.Actor?.ID ?? e.id ?? '' })
      },
      signal
    )
  }

  async images(signal: AbortSignal): Promise<ImageRow[]> {
    const [out, containers] = await Promise.all([
      this.sh(['images', '--no-trunc', '--format', '{{json .}}'], signal),
      this.sh(['ps', '-a', '--no-trunc', '--format', '{{.Image}}'], signal)
    ])
    const used = containers.split('\n').filter(Boolean)
    const byId = new Map<string, ImageRow>()
    for (const i of jsonLines<{
      ID: string
      Repository: string
      Tag: string
      Size: string
      CreatedAt: string
    }>(out)) {
      const tag = i.Repository === '<none>' ? null : `${i.Repository}:${i.Tag}`
      const row = byId.get(i.ID) ?? {
        id: i.ID,
        tags: [],
        size: parseSize(i.Size),
        created: parseCliDate(i.CreatedAt),
        dangling: true,
        containers: 0
      }
      if (tag && i.Tag !== '<none>') {
        row.tags.push(tag)
        row.dangling = false
      }
      byId.set(i.ID, row)
    }
    for (const row of byId.values())
      row.containers = used.filter((u) => row.tags.includes(u) || u === row.id).length
    return [...byId.values()]
  }

  async imageRemove(id: string, force: boolean): Promise<void> {
    await this.sh(['rmi', ...(force ? ['-f'] : []), id])
  }

  async imagePull(
    ref: string,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void> {
    let pending = ''
    await this.follow(
      ['pull', ref],
      (_stream, chunk) => {
        pending += chunk.toString('utf8')
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onProgress(line.trim(), null)
      },
      signal
    )
  }

  async volumes(signal: AbortSignal): Promise<VolumeRow[]> {
    const out = await this.sh(['volume', 'ls', '--format', '{{json .}}'], signal)
    return jsonLines<{ Name: string; Driver: string; Mountpoint: string; Labels: string }>(out).map(
      (v) => ({
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        created: null,
        project: parseLabels(v.Labels)['com.docker.compose.project'] ?? null
      })
    )
  }

  async volumeRemove(name: string): Promise<void> {
    await this.sh(['volume', 'rm', name])
  }

  async networks(signal: AbortSignal): Promise<NetworkRow[]> {
    const out = await this.sh(['network', 'ls', '--no-trunc', '--format', '{{json .}}'], signal)
    return jsonLines<{ ID: string; Name: string; Driver: string; Scope: string }>(out).map((n) => ({
      id: n.ID,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      builtin: BUILTIN_NETWORKS.has(n.Name)
    }))
  }

  async networkRemove(id: string): Promise<void> {
    await this.sh(['network', 'rm', id])
  }

  async prune(what: PruneTarget, dryRun: boolean): Promise<PruneResult> {
    if (dryRun) {
      const lines = (out: string): string[] =>
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      switch (what) {
        case 'containers':
          return {
            items: lines(
              await this.sh([
                'ps',
                '-a',
                '--filter',
                'status=exited',
                '--filter',
                'status=created',
                '--filter',
                'status=dead',
                '--format',
                '{{.Names}}'
              ])
            ),
            reclaimed: 0
          }
        case 'images':
          return {
            items: lines(
              await this.sh(['images', '--filter', 'dangling=true', '--format', '{{.ID}}'])
            ),
            reclaimed: 0
          }
        case 'volumes':
          return {
            items: lines(
              await this.sh(['volume', 'ls', '--filter', 'dangling=true', '--format', '{{.Name}}'])
            ),
            reclaimed: 0
          }
        case 'networks':
          return {
            items: lines(
              await this.sh(['network', 'ls', '--filter', 'dangling=true', '--format', '{{.Name}}'])
            ).filter((n) => !BUILTIN_NETWORKS.has(n)),
            reclaimed: 0
          }
      }
    }
    const kind = {
      containers: 'container',
      images: 'image',
      volumes: 'volume',
      networks: 'network'
    }[what]
    const out = await this.sh([kind, 'prune', '-f'])
    const items = out
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) => l && !/^(deleted|untagged)?\s*(containers|images|volumes|networks|total)/i.test(l)
      )
      .map((l) => l.replace(/^(deleted|untagged): /i, ''))
    const reclaimed = /Total reclaimed space:\s*(\S+)/i.exec(out)?.[1]
    return { items, reclaimed: reclaimed ? parseSize(reclaimed) : 0 }
  }

  async df(signal: AbortSignal): Promise<DiskUsage> {
    const out = await this.sh(['system', 'df', '--format', '{{json .}}'], signal)
    const rows = jsonLines<{ Type: string; TotalCount: string; Size: string; Reclaimable: string }>(
      out
    )
    const pick = (type: RegExp): DiskUsage['images'] => {
      const r = rows.find((x) => type.test(x.Type))
      return {
        count: Number(r?.TotalCount ?? 0) || 0,
        size: parseSize(r?.Size ?? ''),
        reclaimable: parseSize((r?.Reclaimable ?? '').split(' ')[0] ?? '')
      }
    }
    return {
      images: pick(/^images/i),
      containers: pick(/^containers/i),
      volumes: pick(/volumes/i),
      buildCache: pick(/build cache/i)
    }
  }

  async statsOnce(signal: AbortSignal): Promise<Record<string, StatsSample>> {
    const out = await this.sh(
      ['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'],
      signal
    )
    const result: Record<string, StatsSample> = {}
    for (const s of jsonLines<{ ID: string; CPUPerc?: string; MemUsage?: string; NetIO?: string }>(
      out
    )) {
      const [used, limit] = (s.MemUsage ?? '').split('/')
      const [rx, tx] = (s.NetIO ?? '').split('/')
      result[s.ID] = {
        at: Date.now(),
        cpuPercent: Number.parseFloat(s.CPUPerc ?? '0') || 0,
        memUsage: parseSize(used ?? ''),
        memLimit: parseSize(limit ?? ''),
        netRx: parseSize(rx ?? ''),
        netTx: parseSize(tx ?? '')
      }
    }
    return result
  }

  async top(id: string): Promise<ProcessList> {
    return parseTop(await this.sh(['top', id]))
  }

  async imageHistory(id: string): Promise<ImageLayer[]> {
    const out = await this.sh(['history', '--no-trunc', '--format', '{{json .}}', id])
    return jsonLines<{
      ID: string
      CreatedAt: string
      CreatedBy: string
      Size: string
      Comment: string
    }>(out).map((l) => ({
      id: l.ID,
      created: parseCliDate(l.CreatedAt),
      createdBy: l.CreatedBy,
      size: parseSize(l.Size),
      comment: l.Comment
    }))
  }

  async run(spec: RunSpec, signal: AbortSignal): Promise<string> {
    const r = await this.cli.exec(runArgs(spec), { signal, timeoutMs: 15 * 60_000 })
    if (r.code !== 0) throw new Error(cliErrorText(r.stderr, r.code))
    return r.stdout.trim().split('\n').pop() ?? ''
  }
}

/** Bảng của `docker top` (cột cuối — lệnh — có thể chứa khoảng trắng). */
export function parseTop(text: string): ProcessList {
  const lines = text.split('\n').filter((l) => l.trim())
  const titles = (lines[0] ?? '').trim().split(/\s+/)
  const processes = lines.slice(1).map((l) => {
    const parts = l.trim().split(/\s+/)
    return [...parts.slice(0, titles.length - 1), parts.slice(titles.length - 1).join(' ')]
  })
  return { titles, processes }
}
