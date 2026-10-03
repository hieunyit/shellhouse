import { t } from '@shared/i18n'
import {
  healthOf,
  type NetworkSpec,
  type RegistryAuth,
  type VolumeSpec,
  type DiskUsage,
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
  authServer,
  BUILTIN_NETWORKS,
  ChunkQueue,
  cliErrorText,
  isAnonymousVolume,
  parseSize,
  runArgs,
  type DockerBackend,
  type DockerCli
} from './backend'

/** Số id mỗi lệnh `container inspect` (id 64 ký tự → ~10KB, dưới giới hạn dòng lệnh của wsl.exe). */
export const INSPECT_BATCH = 150

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

/**
 * "a=b,c=d" → object. CLI nối nhãn bằng dấu phẩy, không thoát dấu phẩy trong giá trị: mảnh không
 * bắt đầu bằng "khoá=" là phần tiếp theo của giá trị trước (vd. config_files "a.yml,b.yml").
 */
export function parseLabels(labels: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  // Podman (`--format '{{json .}}'`) trả Labels dạng object / null thay vì chuỗi "a=b,c=d".
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
    for (const [k, v] of Object.entries(labels as Record<string, unknown>))
      out[k] =
        typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? `${v}` : ''
    return out
  }
  const text = typeof labels === 'string' ? labels : ''
  let last: string | null = null
  for (const part of text.split(',')) {
    const key = /^([A-Za-z0-9][\w.\-/]*)=/.exec(part)?.[1]
    if (key) {
      out[key] = part.slice(key.length + 1)
      last = key
    } else if (last !== null) {
      out[last] = `${out[last] ?? ''},${part}`
    }
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

  /**
   * Chạy `fn` với `--config <thư mục tạm>` đã đăng nhập registry (không đụng ~/.docker của người
   * dùng, không để lại thông tin đăng nhập: thư mục bị xoá ngay sau đó). auth null → không đăng nhập.
   */
  private async withAuth<T>(
    auth: RegistryAuth | null,
    signal: AbortSignal,
    fn: (pre: string[]) => Promise<T>
  ): Promise<T> {
    if (!auth) return fn([])
    if (!this.cli.tempDir)
      throw new Error(t('Signing in to a registry is not available with this Docker connection.'))
    const dir = await this.cli.tempDir()
    try {
      const pre = ['--config', dir.path]
      const r = await this.cli.exec(
        [...pre, 'login', '--username', auth.username, '--password-stdin', authServer(auth.server)],
        { input: auth.password, signal, timeoutMs: 60_000 }
      )
      if (r.code !== 0) throw new Error(cliErrorText(r.stderr, r.code))
      return await fn(pre)
    } finally {
      await dir.remove().catch(() => undefined)
    }
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
      Labels: string | Record<string, string> | null
    }>(out).map((c) => {
      const labels = parseLabels(c.Labels)
      return {
        id: c.ID,
        name: c.Names.split(',')[0] ?? c.ID.slice(0, 12),
        image: c.Image,
        state: c.State.toLowerCase(),
        status: c.Status,
        health: healthOf(c.Status),
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
    const out = await this.sh(['inspect', '--type', kind, '--', id])
    const parsed = JSON.parse(out) as unknown[]
    return parsed[0] ?? null
  }

  // `--` trước đối số vị trí: id không bao giờ bị hiểu thành tuỳ chọn (schema cũng đã chặn "-").
  async action(id: string, action: string, force: boolean, volumes = false): Promise<void> {
    await this.sh(
      action === 'remove'
        ? ['rm', ...(force ? ['-f'] : []), ...(volumes ? ['-v'] : []), '--', id]
        : [action, '--', id]
    )
  }

  async rename(id: string, name: string): Promise<void> {
    await this.sh(['rename', '--', id, name])
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
      [
        'logs',
        '--follow',
        '--tail',
        String(tail),
        ...(timestamps ? ['--timestamps'] : []),
        '--',
        id
      ],
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
      const out = await this.sh(
        ['stats', '--no-stream', '--format', '{{json .}}', '--', id],
        signal
      )
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
    const [out, used] = await Promise.all([
      this.sh(['images', '--no-trunc', '--format', '{{json .}}'], signal),
      // Đếm container chỉ là phụ: lỗi thì để 0, không làm hỏng cả tab Images.
      this.containerImageIds(signal).catch(() => new Map<string, number>())
    ])
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
    for (const row of byId.values()) row.containers = used.get(stripSha(row.id)) ?? 0
    return [...byId.values()]
  }

  /**
   * Số container theo id image. `docker ps` chỉ có `{{.Image}}` (chuỗi người dùng gõ: "nginx",
   * id rút gọn…) — không so được với tag / id đầy đủ → hỏi `inspect` id image thật của từng
   * container, theo lô (một lệnh cho cả nghìn id vượt giới hạn dòng lệnh: wsl.exe ~32KB, sh -c).
   */
  private async containerImageIds(signal: AbortSignal): Promise<Map<string, number>> {
    const ids = (await this.sh(['ps', '-a', '-q', '--no-trunc'], signal))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const out = new Map<string, number>()
    if (ids.length === 0) return out
    for (let i = 0; i < ids.length; i += INSPECT_BATCH) {
      // Container vừa bị xoá giữa hai lệnh → inspect lỗi; vẫn đọc phần stdout của các container còn.
      // Cả lô lỗi (không stdout) thì bỏ qua lô đó — số container chỉ thiếu, không hỏng cả danh sách.
      const r = await this.cli.exec(
        [
          'container',
          'inspect',
          '--format',
          '{{.Image}}',
          '--',
          ...ids.slice(i, i + INSPECT_BATCH)
        ],
        { signal, timeoutMs: 120_000 }
      )
      for (const line of r.stdout.split('\n')) {
        const id = stripSha(line.trim())
        if (id) out.set(id, (out.get(id) ?? 0) + 1)
      }
    }
    return out
  }

  async imageRemove(id: string, force: boolean): Promise<void> {
    await this.sh(['rmi', ...(force ? ['-f'] : []), '--', id])
  }

  /** Dòng tiến độ của pull / push (CLI không có % — chỉ trạng thái). */
  private progress(
    args: readonly string[],
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void> {
    let pending = ''
    return this.follow(
      args,
      (_stream, chunk) => {
        pending += chunk.toString('utf8')
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onProgress(line.trim(), null)
      },
      signal
    )
  }

  async imagePull(
    ref: string,
    auth: RegistryAuth | null,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void> {
    await this.withAuth(auth, signal, (pre) =>
      this.progress([...pre, 'pull', '--', ref], onProgress, signal)
    )
  }

  async imagePush(
    ref: string,
    auth: RegistryAuth | null,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void> {
    await this.withAuth(auth, signal, (pre) =>
      this.progress([...pre, 'push', '--', ref], onProgress, signal)
    )
  }

  async imageTag(id: string, target: string): Promise<void> {
    await this.sh(['tag', '--', id, target])
  }

  async registryLogin(auth: RegistryAuth, signal: AbortSignal): Promise<string> {
    return this.withAuth(auth, signal, () => Promise.resolve('Login Succeeded'))
  }

  async volumes(signal: AbortSignal): Promise<VolumeRow[]> {
    const out = await this.sh(['volume', 'ls', '--format', '{{json .}}'], signal)
    return jsonLines<{
      Name: string
      Driver: string
      Mountpoint: string
      Labels: string | Record<string, string> | null
    }>(out).map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      created: null,
      project: parseLabels(v.Labels)['com.docker.compose.project'] ?? null
    }))
  }

  async volumeRemove(name: string): Promise<void> {
    await this.sh(['volume', 'rm', '--', name])
  }

  async volumeCreate(spec: VolumeSpec): Promise<string> {
    const out = await this.sh([
      'volume',
      'create',
      '--driver',
      spec.driver,
      ...Object.entries(spec.driverOpts).flatMap(([k, v]) => ['--opt', `${k}=${v}`]),
      ...Object.entries(spec.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...(spec.name ? ['--', spec.name] : [])
    ])
    return out.trim().split('\n').pop() ?? spec.name ?? ''
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
    await this.sh(['network', 'rm', '--', id])
  }

  async networkCreate(spec: NetworkSpec): Promise<string> {
    const out = await this.sh([
      'network',
      'create',
      '--driver',
      spec.driver,
      ...(spec.subnet ? ['--subnet', spec.subnet] : []),
      ...(spec.gateway ? ['--gateway', spec.gateway] : []),
      ...(spec.ipRange ? ['--ip-range', spec.ipRange] : []),
      ...(spec.internal ? ['--internal'] : []),
      ...(spec.attachable ? ['--attachable'] : []),
      ...Object.entries(spec.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      ...Object.entries(spec.options).flatMap(([k, v]) => ['--opt', `${k}=${v}`]),
      '--',
      spec.name
    ])
    return out.trim().split('\n').pop() ?? ''
  }

  async networkConnect(
    network: string,
    container: string,
    aliases: readonly string[],
    ipv4: string | undefined
  ): Promise<void> {
    await this.sh([
      'network',
      'connect',
      ...aliases.flatMap((a) => ['--alias', a]),
      ...(ipv4 ? ['--ip', ipv4] : []),
      '--',
      network,
      container
    ])
  }

  async networkDisconnect(network: string, container: string, force: boolean): Promise<void> {
    await this.sh(['network', 'disconnect', ...(force ? ['-f'] : []), '--', network, container])
  }

  async prune(what: PruneTarget, dryRun: boolean, all = false): Promise<PruneResult> {
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
        case 'images': {
          if (!all)
            return {
              items: lines(
                await this.sh(['images', '--filter', 'dangling=true', '--format', '{{.ID}}'])
              ),
              reclaimed: 0
            }
          // Mọi image không container nào dùng (như `docker image prune -a`).
          const [rows, used] = await Promise.all([
            this.images(new AbortController().signal),
            this.containerImageIds(new AbortController().signal)
          ])
          const unused = rows.filter((i) => !used.has(stripSha(i.id)))
          return {
            items: unused.map((i) => i.tags[0] ?? stripSha(i.id).slice(0, 12)),
            reclaimed: unused.reduce((n, i) => n + i.size, 0)
          }
        }
        case 'buildCache': {
          const row = jsonLines<{
            Type: string
            TotalCount: string
            Active: string
            Reclaimable: string
          }>(await this.sh(['system', 'df', '--format', '{{json .}}'])).find((r) =>
            /build cache/i.test(r.Type)
          )
          const count = Math.max(0, (Number(row?.TotalCount) || 0) - (Number(row?.Active) || 0))
          return {
            items: [],
            count,
            reclaimed: parseSize((row?.Reclaimable ?? '').split(' ')[0] ?? '')
          }
        }
        case 'volumes':
          return {
            items: jsonLines<{ Name: string; Labels?: string | Record<string, string> | null }>(
              await this.sh(['volume', 'ls', '--filter', 'dangling=true', '--format', '{{json .}}'])
            )
              .filter((v) => all || isAnonymousVolume(v.Name, parseLabels(v.Labels)))
              .map((v) => v.Name),
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
    if (what === 'volumes') return this.pruneVolumes(all)
    if (what === 'buildCache') {
      // -a: mọi cache không dùng (khớp phần "reclaimable"), không chỉ dangling.
      const out = await this.sh(['builder', 'prune', '-a', '-f'])
      const total = /Total(?: reclaimed space)?:\s*(\S+)/i.exec(out)?.[1]
      return { items: [], reclaimed: total ? parseSize(total) : 0 }
    }
    const kind = {
      containers: 'container',
      images: 'image',
      networks: 'network'
    }[what]
    const out = await this.sh([kind, 'prune', '-f', ...(what === 'images' && all ? ['-a'] : [])])
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

  /**
   * Volume: mặc định chỉ volume ẩn danh — xoá đúng danh sách xem trước (`docker volume prune -f`
   * của CLI < 23 / Engine API < 1.42 xoá cả volume có tên). `all` = mọi volume không dùng.
   */
  private async pruneVolumes(all: boolean): Promise<PruneResult> {
    const { items } = await this.prune('volumes', true, all)
    if (items.length === 0) return { items: [], reclaimed: 0 }
    // `docker volume rm` từng volume (một lệnh): cái vừa bị dùng lại thì lỗi, các cái khác vẫn xoá.
    const r = await this.cli.exec(['volume', 'rm', '--', ...items], { timeoutMs: 120_000 })
    const deleted = new Set(
      r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    )
    if (r.code !== 0 && deleted.size === 0) throw new Error(cliErrorText(r.stderr, r.code))
    return { items: items.filter((n) => deleted.has(n)), reclaimed: 0 }
  }

  async df(signal: AbortSignal): Promise<DiskUsage> {
    const [out, dangling, danglingVolumes] = await Promise.all([
      this.sh(['system', 'df', '--format', '{{json .}}'], signal),
      // Phụ: lỗi thì để trống, không làm hỏng cả trang tổng quan.
      this.sh(['images', '--filter', 'dangling=true', '--format', '{{json .}}'], signal).catch(
        () => ''
      ),
      this.sh(['system', 'df', '-v', '--format', '{{json .}}'], signal).catch(() => '')
    ])
    const rows = jsonLines<{ Type: string; TotalCount: string; Size: string; Reclaimable: string }>(
      out
    )
    const pick = (type: RegExp): DiskUsage['containers'] => {
      const r = rows.find((x) => type.test(x.Type))
      return {
        count: Number(r?.TotalCount ?? 0) || 0,
        size: parseSize(r?.Size ?? ''),
        reclaimable: parseSize((r?.Reclaimable ?? '').split(' ')[0] ?? '')
      }
    }
    const images = pick(/^images/i)
    const danglingRows = jsonLines<{ Size: string }>(dangling)
    const volumes = pick(/volumes/i)
    const verbose = volumeSizes(danglingVolumes)
    return {
      images: {
        count: images.count,
        size: images.size,
        reclaimable: danglingRows.reduce((n, i) => n + parseSize(i.Size), 0),
        unused: { count: 0, size: images.reclaimable }
      },
      containers: pick(/^containers/i),
      volumes: verbose
        ? {
            count: volumes.count,
            size: volumes.size,
            reclaimable: verbose.anonymous,
            namedUnused: verbose.named
          }
        : { ...volumes, namedUnused: null },
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
    return parseTop(await this.sh(['top', '--', id]))
  }

  async imageHistory(id: string): Promise<ImageLayer[]> {
    const out = await this.sh(['history', '--no-trunc', '--format', '{{json .}}', '--', id])
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

  execCapture(
    id: string,
    cmd: readonly string[],
    signal: AbortSignal
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.cli.exec(['exec', '--', id, ...cmd], { signal, timeoutMs: 60_000 })
  }

  async archive(id: string, path: string, signal: AbortSignal): Promise<AsyncIterable<Buffer>> {
    // `docker cp <id>:<path> -` in tar ra stdout.
    const program = await this.cli.spawn(['cp', '--', `${id}:${path}`, '-'], signal)
    const queue = new ChunkQueue()
    const errors: Buffer[] = []
    program.onStdout((c) => {
      queue.push(c)
    })
    program.onStderr((c) => {
      if (errors.length < 16) errors.push(c)
    })
    program.onExit((code) => {
      if (code === 0 || signal.aborted) queue.end()
      else queue.end(new Error(cliErrorText(Buffer.concat(errors).toString('utf8'), code)))
    })
    return queue
  }

  async putArchive(
    id: string,
    dir: string,
    tar: AsyncIterable<Buffer>,
    signal: AbortSignal
  ): Promise<void> {
    // CLI chỉ nhận stdin trọn gói → gom vào bộ nhớ, giới hạn để không làm cạn RAM.
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of tar) {
      size += chunk.length
      if (size > CLI_UPLOAD_LIMIT)
        throw new Error(
          t(
            'Uploads through the docker command are limited to 512 MB at a time. Upload fewer files, or connect to the Docker socket.'
          )
        )
      chunks.push(chunk)
    }
    const r = await this.cli.exec(['cp', '-', `${id}:${dir}`], {
      input: Buffer.concat(chunks),
      signal,
      timeoutMs: 30 * 60_000
    })
    if (r.code !== 0) throw new Error(cliErrorText(r.stderr, r.code))
  }
}

/** Tải file vào container qua CLI: tar gom trong bộ nhớ tối đa chừng này. */
export const CLI_UPLOAD_LIMIT = 512 * 1024 * 1024

/**
 * `docker system df -v --format '{{json .}}'` (Docker ≥ 23: một đối tượng JSON có mảng Volumes)
 * → dung lượng volume ẩn danh / có tên không dùng. Không đọc được → null.
 */
export function volumeSizes(
  text: string
): { anonymous: number; named: { count: number; size: number } } | null {
  try {
    const parsed = JSON.parse(text.trim()) as {
      Volumes?: { Name?: string; Links?: string | number; Size?: string; Labels?: unknown }[]
    }
    if (!Array.isArray(parsed.Volumes)) return null
    let anonymous = 0
    const named = { count: 0, size: 0 }
    for (const v of parsed.Volumes) {
      if (Number(v.Links ?? 0) !== 0) continue
      const size = parseSize(v.Size ?? '')
      if (isAnonymousVolume(v.Name ?? '', parseLabels(v.Labels))) anonymous += size
      else {
        named.count++
        named.size += size
      }
    }
    return { anonymous, named }
  } catch {
    return null
  }
}

const stripSha = (id: string): string => id.replace(/^sha256:/, '')

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
