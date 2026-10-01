import type {
  DiskUsage,
  ImageLayer,
  ProcessList,
  RunSpec,
  ContainerRow,
  EngineInfo,
  ImageRow,
  NetworkRow,
  PruneResult,
  PruneTarget,
  StatsSample,
  VolumeRow
} from '../shared/ops'
import { BUILTIN_NETWORKS, mapLimit, type DockerBackend } from './backend'
import { EngineClient, JsonLines, LogDemuxer } from './engine'

/** Docker qua Engine API (socket local hoặc streamlocal qua SSH). */

interface ApiContainer {
  Id: string
  Names?: string[] | null
  Image: string
  State: string
  Status: string
  Created: number
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[] | null
  Labels?: Record<string, string> | null
}

interface ApiImage {
  Id: string
  RepoTags?: string[] | null
  Size: number
  Created: number
  Containers?: number
}

interface ApiVolume {
  Name: string
  Driver: string
  Mountpoint: string
  CreatedAt?: string
  Labels?: Record<string, string> | null
}

interface ApiNetwork {
  Id: string
  Name: string
  Driver: string
  Scope: string
}

interface ApiStats {
  read?: string
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] | null }
    system_cpu_usage?: number
    online_cpus?: number
  }
  precpu_stats?: ApiStats['cpu_stats']
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> }
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }> | null
}

export function toContainerRow(c: ApiContainer): ContainerRow {
  const labels = c.Labels ?? {}
  return {
    id: c.Id,
    name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created * 1000,
    ports: (c.Ports ?? []).map((p) => ({
      ip: p.IP ?? '',
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort ?? null,
      type: p.Type
    })),
    project: labels['com.docker.compose.project'] ?? null,
    service: labels['com.docker.compose.service'] ?? null,
    composeDir: labels['com.docker.compose.project.working_dir'] ?? null,
    composeFiles: labels['com.docker.compose.project.config_files'] ?? null
  }
}

/**
 * Mẫu stats của Docker → % CPU (như `docker stats`), RAM trừ page cache, tổng mạng. `previous` =
 * mẫu CPU lần trước của chính mình (one-shot không có precpu); không có mẫu nào để so → CPU -1
 * (chưa biết, giao diện hiện "—").
 */
export function toStatsSample(
  s: ApiStats,
  previous?: { total: number; system: number }
): StatsSample | null {
  const cpu = s.cpu_stats
  const pre = s.precpu_stats
  if (!cpu?.cpu_usage?.total_usage || cpu.system_cpu_usage === undefined) return null
  const preTotal = pre?.cpu_usage?.total_usage || previous?.total
  const preSystem = pre?.system_cpu_usage || previous?.system
  const known = preTotal !== undefined && preSystem !== undefined
  const cpuDelta = cpu.cpu_usage.total_usage - (preTotal ?? 0)
  const sysDelta = cpu.system_cpu_usage - (preSystem ?? 0)
  const cpus = cpu.online_cpus ?? cpu.cpu_usage.percpu_usage?.length ?? 1
  const mem = s.memory_stats ?? {}
  // cgroup v2: inactive_file; v1: cache.
  const cache = mem.stats?.['inactive_file'] ?? mem.stats?.['cache'] ?? 0
  let rx = 0
  let tx = 0
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0
    tx += n.tx_bytes ?? 0
  }
  return {
    at: s.read ? Date.parse(s.read) || Date.now() : Date.now(),
    cpuPercent: !known ? -1 : sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0,
    memUsage: Math.max(0, (mem.usage ?? 0) - cache),
    memLimit: mem.limit ?? 0,
    netRx: rx,
    netTx: tx
  }
}

/** "nginx:1.27" → fromImage + tag; digest giữ nguyên. */
export function splitImageRef(ref: string): { fromImage: string; tag?: string } {
  if (ref.includes('@')) return { fromImage: ref }
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  if (colon > slash) return { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) }
  return { fromImage: ref, tag: 'latest' }
}

const STOPPED = new Set(['exited', 'created', 'dead'])

export class ApiBackend implements DockerBackend {
  readonly via = 'api' as const

  constructor(private readonly engine: EngineClient) {}

  async info(signal: AbortSignal): Promise<EngineInfo> {
    const [version, info] = await Promise.all([
      this.engine.json<{
        Version?: string
        ApiVersion?: string
        Os?: string
        Arch?: string
        Components?: { Name?: string }[]
      }>('GET', '/version', { signal }),
      this.engine.json<{
        Containers?: number
        ContainersRunning?: number
        Images?: number
        OperatingSystem?: string
      }>('GET', '/info', { signal })
    ])
    const flavor = version.Components?.some((c) => /podman/i.test(c.Name ?? ''))
      ? 'Podman'
      : 'Docker Engine'
    return {
      version: `${flavor} ${version.Version ?? '?'}`,
      apiVersion: version.ApiVersion ?? '',
      os: [info.OperatingSystem, version.Arch].filter(Boolean).join(' · '),
      containers: info.Containers ?? 0,
      running: info.ContainersRunning ?? 0,
      images: info.Images ?? 0,
      via: 'api',
      flavor
    }
  }

  async containers(all: boolean, signal: AbortSignal): Promise<ContainerRow[]> {
    const list = await this.engine.json<ApiContainer[]>('GET', '/containers/json', {
      query: { all },
      signal
    })
    return list.map(toContainerRow)
  }

  inspect(kind: 'container' | 'image' | 'volume' | 'network', id: string): Promise<unknown> {
    const path = {
      container: `/containers/${encodeURIComponent(id)}/json`,
      image: `/images/${encodeURIComponent(id)}/json`,
      volume: `/volumes/${encodeURIComponent(id)}`,
      network: `/networks/${encodeURIComponent(id)}`
    }[kind]
    return this.engine.json('GET', path)
  }

  async action(id: string, action: string, force: boolean): Promise<void> {
    const c = encodeURIComponent(id)
    if (action === 'remove') {
      await this.engine.json('DELETE', `/containers/${c}`, { query: { force } })
      return
    }
    await this.engine.json('POST', `/containers/${c}/${action}`)
  }

  async rename(id: string, name: string): Promise<void> {
    await this.engine.json('POST', `/containers/${encodeURIComponent(id)}/rename`, {
      query: { name }
    })
  }

  async logs(
    id: string,
    tail: number,
    timestamps: boolean,
    onData: (stream: 'stdout' | 'stderr', text: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const inspect = await this.engine.json<{ Config?: { Tty?: boolean } }>(
      'GET',
      `/containers/${encodeURIComponent(id)}/json`,
      { signal }
    )
    const tty = inspect.Config?.Tty === true
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    const emit = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const text = decoders[stream].decode(data, { stream: true })
      if (text) onData(stream, text)
    }
    const demux = new LogDemuxer(emit)
    await this.engine.stream(
      'GET',
      `/containers/${encodeURIComponent(id)}/logs`,
      { query: { follow: true, stdout: true, stderr: true, tail, timestamps }, signal },
      (chunk) => {
        // Container có TTY: luồng thô, không có header.
        if (tty) emit('stdout', chunk)
        else demux.push(chunk)
      }
    )
  }

  async stats(id: string, onSample: (s: StatsSample) => void, signal: AbortSignal): Promise<void> {
    const lines = new JsonLines((value) => {
      const sample = toStatsSample(value as ApiStats)
      if (sample) onSample(sample)
    })
    await this.engine.stream(
      'GET',
      `/containers/${encodeURIComponent(id)}/stats`,
      { query: { stream: true }, signal },
      (chunk) => {
        lines.push(chunk)
      }
    )
  }

  async events(
    onEvent: (e: { action: string; id: string }) => void,
    signal: AbortSignal
  ): Promise<void> {
    const lines = new JsonLines((value) => {
      const e = value as { Action?: string; Actor?: { ID?: string }; id?: string }
      onEvent({ action: e.Action ?? '', id: e.Actor?.ID ?? e.id ?? '' })
    })
    await this.engine.stream(
      'GET',
      '/events',
      { query: { filters: JSON.stringify({ type: ['container'] }) }, signal },
      (chunk) => {
        lines.push(chunk)
      }
    )
  }

  async images(signal: AbortSignal): Promise<ImageRow[]> {
    const [list, containers] = await Promise.all([
      this.engine.json<ApiImage[]>('GET', '/images/json', { signal }),
      this.engine.json<{ ImageID: string }[]>('GET', '/containers/json', {
        query: { all: true },
        signal
      })
    ])
    const used = new Map<string, number>()
    for (const c of containers) used.set(c.ImageID, (used.get(c.ImageID) ?? 0) + 1)
    return list.map((i) => {
      const tags = (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>')
      return {
        id: i.Id,
        tags,
        size: i.Size,
        created: i.Created * 1000,
        dangling: tags.length === 0,
        containers: used.get(i.Id) ?? 0
      }
    })
  }

  async imageRemove(id: string, force: boolean): Promise<void> {
    await this.engine.json('DELETE', `/images/${encodeURIComponent(id)}`, { query: { force } })
  }

  async imagePull(
    ref: string,
    onProgress: (status: string, progress: number | null) => void,
    signal: AbortSignal
  ): Promise<void> {
    const layers = new Map<string, { current: number; total: number }>()
    const result: { failure: string | null } = { failure: null }
    const lines = new JsonLines((value) => {
      const e = value as {
        status?: string
        id?: string
        error?: string
        progressDetail?: { current?: number; total?: number }
      }
      if (e.error) {
        result.failure = e.error
        return
      }
      if (e.id && e.progressDetail?.total)
        layers.set(e.id, { current: e.progressDetail.current ?? 0, total: e.progressDetail.total })
      if (e.id && /complete|already exists/i.test(e.status ?? '')) {
        const l = layers.get(e.id)
        if (l) l.current = l.total
      }
      let current = 0
      let total = 0
      for (const l of layers.values()) {
        current += l.current
        total += l.total
      }
      onProgress(
        [e.id, e.status].filter(Boolean).join(': '),
        total > 0 ? Math.min(1, current / total) : null
      )
    })
    await this.engine.stream(
      'POST',
      '/images/create',
      { query: splitImageRef(ref), signal },
      (chunk) => {
        lines.push(chunk)
      }
    )
    if (result.failure) throw new Error(result.failure)
  }

  async volumes(signal: AbortSignal): Promise<VolumeRow[]> {
    const res = await this.engine.json<{ Volumes?: ApiVolume[] | null }>('GET', '/volumes', {
      signal
    })
    return (res.Volumes ?? []).map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      created: v.CreatedAt ? Date.parse(v.CreatedAt) || null : null,
      project: v.Labels?.['com.docker.compose.project'] ?? null
    }))
  }

  async volumeRemove(name: string): Promise<void> {
    await this.engine.json('DELETE', `/volumes/${encodeURIComponent(name)}`)
  }

  async networks(signal: AbortSignal): Promise<NetworkRow[]> {
    const list = await this.engine.json<ApiNetwork[]>('GET', '/networks', { signal })
    return list.map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      builtin: BUILTIN_NETWORKS.has(n.Name)
    }))
  }

  async networkRemove(id: string): Promise<void> {
    await this.engine.json('DELETE', `/networks/${encodeURIComponent(id)}`)
  }

  async prune(what: PruneTarget, dryRun: boolean): Promise<PruneResult> {
    const dangling = JSON.stringify({ dangling: ['true'] })
    if (dryRun) {
      switch (what) {
        case 'containers': {
          const list = await this.engine.json<ApiContainer[]>('GET', '/containers/json', {
            query: { all: true }
          })
          return {
            items: list.filter((c) => STOPPED.has(c.State)).map((c) => toContainerRow(c).name),
            reclaimed: 0
          }
        }
        case 'images': {
          const list = await this.engine.json<ApiImage[]>('GET', '/images/json', {
            query: { filters: dangling }
          })
          return {
            items: list.map((i) => i.Id.replace(/^sha256:/, '').slice(0, 12)),
            reclaimed: list.reduce((n, i) => n + i.Size, 0)
          }
        }
        case 'volumes': {
          const res = await this.engine.json<{ Volumes?: ApiVolume[] | null }>('GET', '/volumes', {
            query: { filters: dangling }
          })
          return { items: (res.Volumes ?? []).map((v) => v.Name), reclaimed: 0 }
        }
        case 'networks': {
          const list = await this.engine.json<ApiNetwork[]>('GET', '/networks', {
            query: { filters: dangling }
          })
          return {
            items: list.filter((n) => !BUILTIN_NETWORKS.has(n.Name)).map((n) => n.Name),
            reclaimed: 0
          }
        }
      }
    }
    switch (what) {
      case 'containers': {
        const r = await this.engine.json<{
          ContainersDeleted?: string[] | null
          SpaceReclaimed?: number
        }>('POST', '/containers/prune')
        return {
          items: (r.ContainersDeleted ?? []).map((id) => id.slice(0, 12)),
          reclaimed: r.SpaceReclaimed ?? 0
        }
      }
      case 'images': {
        const r = await this.engine.json<{
          ImagesDeleted?: { Deleted?: string; Untagged?: string }[] | null
          SpaceReclaimed?: number
        }>('POST', '/images/prune', { query: { filters: dangling } })
        return {
          items: (r.ImagesDeleted ?? []).map((i) =>
            (i.Deleted ?? i.Untagged ?? '').replace(/^sha256:/, '').slice(0, 12)
          ),
          reclaimed: r.SpaceReclaimed ?? 0
        }
      }
      case 'volumes': {
        const r = await this.engine.json<{
          VolumesDeleted?: string[] | null
          SpaceReclaimed?: number
        }>('POST', '/volumes/prune')
        return { items: r.VolumesDeleted ?? [], reclaimed: r.SpaceReclaimed ?? 0 }
      }
      case 'networks': {
        const r = await this.engine.json<{ NetworksDeleted?: string[] | null }>(
          'POST',
          '/networks/prune'
        )
        return { items: r.NetworksDeleted ?? [], reclaimed: 0 }
      }
    }
  }

  async df(signal: AbortSignal): Promise<DiskUsage> {
    const r = await this.engine.json<{
      Images?: { Size: number; SharedSize?: number; Containers: number }[] | null
      Containers?: { SizeRw?: number; State: string }[] | null
      Volumes?: { UsageData?: { Size: number; RefCount: number } }[] | null
      BuildCache?: { Size: number; InUse: boolean }[] | null
    }>('GET', '/system/df', { signal })
    const images = r.Images ?? []
    const containers = r.Containers ?? []
    const volumes = r.Volumes ?? []
    const cache = r.BuildCache ?? []
    const sum = <T>(list: T[], f: (x: T) => number): number =>
      list.reduce((n, x) => n + Math.max(0, f(x)), 0)
    return {
      images: {
        count: images.length,
        size: sum(images, (i) => i.Size),
        reclaimable: sum(
          images.filter((i) => i.Containers === 0),
          (i) => i.Size - (i.SharedSize ?? 0)
        )
      },
      containers: {
        count: containers.length,
        size: sum(containers, (c) => c.SizeRw ?? 0),
        reclaimable: sum(
          containers.filter((c) => c.State !== 'running'),
          (c) => c.SizeRw ?? 0
        )
      },
      volumes: {
        count: volumes.length,
        size: sum(volumes, (v) => v.UsageData?.Size ?? 0),
        reclaimable: sum(
          volumes.filter((v) => v.UsageData?.RefCount === 0),
          (v) => v.UsageData?.Size ?? 0
        )
      },
      buildCache: {
        count: cache.length,
        size: sum(cache, (c) => c.Size),
        reclaimable: sum(
          cache.filter((c) => !c.InUse),
          (c) => c.Size
        )
      }
    }
  }

  /** Mẫu CPU lần trước theo container (one-shot không có precpu — tự tính chênh lệch). */
  private readonly lastCpu = new Map<string, { total: number; system: number }>()

  /**
   * Một mẫu cho mọi container đang chạy. `one-shot=true` trả ngay (~10 ms) thay vì đợi 1 giây lấy
   * mẫu thứ hai như `stream=false` — 100 container: 1 giây thay vì ~13 giây, dockerd đỡ tải.
   */
  async statsOnce(signal: AbortSignal): Promise<Record<string, StatsSample>> {
    const running = await this.engine.json<ApiContainer[]>('GET', '/containers/json', { signal })
    const raw = await mapLimit(running, 8, (c) =>
      this.engine
        .json<ApiStats>('GET', `/containers/${encodeURIComponent(c.Id)}/stats`, {
          query: { stream: false, 'one-shot': true },
          signal
        })
        .catch(() => null)
    )
    const out: Record<string, StatsSample> = {}
    const seen = new Set<string>()
    running.forEach((c, i) => {
      const s = raw[i]
      if (!s) return
      seen.add(c.Id)
      const sample = toStatsSample(s, this.lastCpu.get(c.Id))
      const total = s.cpu_stats?.cpu_usage?.total_usage
      const system = s.cpu_stats?.system_cpu_usage
      if (total !== undefined && system !== undefined) this.lastCpu.set(c.Id, { total, system })
      if (sample) out[c.Id] = sample
    })
    for (const id of this.lastCpu.keys()) if (!seen.has(id)) this.lastCpu.delete(id)
    return out
  }

  async top(id: string): Promise<ProcessList> {
    const r = await this.engine.json<{ Titles?: string[]; Processes?: string[][] }>(
      'GET',
      `/containers/${encodeURIComponent(id)}/top`
    )
    return { titles: r.Titles ?? [], processes: r.Processes ?? [] }
  }

  async imageHistory(id: string): Promise<ImageLayer[]> {
    const list = await this.engine.json<
      { Id: string; Created: number; CreatedBy: string; Size: number; Comment: string }[]
    >('GET', `/images/${encodeURIComponent(id)}/history`)
    return list.map((l) => ({
      id: l.Id,
      created: l.Created * 1000,
      createdBy: l.CreatedBy,
      size: l.Size,
      comment: l.Comment
    }))
  }

  async run(spec: RunSpec, signal: AbortSignal): Promise<string> {
    const exposed: Record<string, object> = {}
    const bindings: Record<string, { HostPort: string }[]> = {}
    for (const p of spec.ports) {
      const key = `${p.container}/${p.protocol}`
      exposed[key] = {}
      bindings[key] = [{ HostPort: p.host ? String(p.host) : '' }]
    }
    const body = {
      Image: spec.image,
      ...(spec.command?.length ? { Cmd: spec.command } : {}),
      Env: spec.env,
      ExposedPorts: exposed,
      HostConfig: {
        PortBindings: bindings,
        Binds: spec.volumes.map((v) => `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`),
        RestartPolicy: { Name: spec.restart },
        AutoRemove: spec.autoRemove
      }
    }
    const create = (): Promise<{ Id: string }> =>
      this.engine.json<{ Id: string }>('POST', '/containers/create', {
        query: { name: spec.name || undefined },
        body,
        signal
      })
    let created: { Id: string }
    try {
      created = await create()
    } catch (error) {
      if (!(spec.pull && error instanceof Error && /no such image/i.test(error.message)))
        throw error
      await this.imagePull(spec.image, () => undefined, signal)
      created = await create()
    }
    await this.engine.json('POST', `/containers/${encodeURIComponent(created.Id)}/start`, {
      signal
    })
    return created.Id
  }
}
