import type {
  ContainerRow,
  EngineInfo,
  ImageRow,
  NetworkRow,
  PruneResult,
  PruneTarget,
  StatsSample,
  VolumeRow
} from '../shared/ops'
import { BUILTIN_NETWORKS, type DockerBackend } from './backend'
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

/** Mẫu stats của Docker → % CPU (như `docker stats`), RAM trừ page cache, tổng mạng. */
export function toStatsSample(s: ApiStats): StatsSample | null {
  const cpu = s.cpu_stats
  const pre = s.precpu_stats
  if (!cpu?.cpu_usage?.total_usage || cpu.system_cpu_usage === undefined) return null
  const cpuDelta = cpu.cpu_usage.total_usage - (pre?.cpu_usage?.total_usage ?? 0)
  const sysDelta = cpu.system_cpu_usage - (pre?.system_cpu_usage ?? 0)
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
    cpuPercent: sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0,
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
}
