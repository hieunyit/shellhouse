import {
  backgroundSession,
  friendlyError,
  hostEnvironmentId,
  isMonitored,
  monitorConfig,
  onMonitorConfigChange,
  publishFleet,
  removeFleet,
  savedHost,
  t,
  type BackgroundSession,
  type FleetItem,
  type FleetStat
} from '../../registry/renderer-kit'
import { tcpIdOf, wslDistroOf, type DockerEndpoint } from '../shared/ipc'
import type { ContainerRow, EngineInfo } from '../shared/ops'
import { dockerApi, openDocker, sourceLabel } from './api'

/**
 * Theo dõi nền cho Home › Infrastructure: mở app là kết nối (chỉ đọc) tới Docker đang theo dõi —
 * mặc định endpoint thuộc môi trường Production (tự chọn hoặc kế thừa nhóm host) — đọc trạng thái
 * container mỗi vài phút. Không hỏi mật khẩu: host SSH cần mật khẩu thì chỉ báo trên Home.
 */

export const DOCKER_FLEET_EVERY_MS = 3 * 60_000
const TIMEOUT_MS = 60_000

/** Mã thoát của lần dừng bình thường: 0, SIGKILL (137, `docker stop` quá hạn), SIGTERM (143). */
const CLEAN_EXIT = new Set([0, 137, 143])

/** Đếm container cần để ý (thuần — test). */
export function containerCounts(rows: readonly ContainerRow[]): {
  total: number
  running: number
  unhealthy: number
  restarting: number
  failed: number
} {
  let running = 0
  let unhealthy = 0
  let restarting = 0
  let failed = 0
  for (const c of rows) {
    if (c.state === 'running') running++
    if (c.state === 'restarting' || c.state === 'dead') restarting++
    else if (c.health === 'unhealthy') unhealthy++
    else if (c.state === 'exited') {
      const code = /Exited \((\d+)\)/.exec(c.status)?.[1]
      if (code !== undefined && !CLEAN_EXIT.has(Number(code))) failed++
    }
  }
  return { total: rows.length, running, unhealthy, restarting, failed }
}

export function dockerStats(rows: readonly ContainerRow[]): FleetStat[] {
  const n = containerCounts(rows)
  return [
    {
      label: t('Running'),
      value: `${String(n.running)}/${String(n.total)}`,
      tone: 'ok',
      title: t('Running containers / all containers')
    },
    ...(n.restarting
      ? [{ label: t('Restarting'), value: String(n.restarting), tone: 'danger' as const }]
      : []),
    ...(n.unhealthy
      ? [{ label: t('Unhealthy'), value: String(n.unhealthy), tone: 'danger' as const }]
      : []),
    ...(n.failed
      ? [
          {
            label: t('Exited with error'),
            value: String(n.failed),
            tone: 'warning' as const
          }
        ]
      : [])
  ]
}

/** Khoá nguồn (như endpointKey của DockerSection — không kéo cả thanh bên vào chunk này). */
const sourceKeyOf = (hostId: string | null): string => `docker:${hostId ?? 'local'}`

/** Môi trường của endpoint: chọn riêng, không thì kế thừa từ nhóm của host SSH. */
function environmentOf(
  hostId: string | null,
  sources: Readonly<Record<string, string>>
): string | null {
  return sources[sourceKeyOf(hostId)] ?? hostEnvironmentId(hostId)
}

class EngineMonitor {
  private readonly session: BackgroundSession
  private stopped = false
  private info: EngineInfo | null = null
  private containers: ContainerRow[] | null = null
  private checkedAt: number | undefined
  private state: FleetItem['state'] = 'connecting'
  private message: string | undefined
  private abort: AbortController | null = null

  constructor(
    private readonly hostId: string | null,
    private environment: string | null
  ) {
    const wsl = wslDistroOf(hostId)
    const tcp = tcpIdOf(hostId)
    this.session = backgroundSession(
      'docker',
      () =>
        wsl
          ? { kind: 'module', sessionKind: 'engine', params: { wsl } }
          : tcp
            ? { kind: 'module', sessionKind: 'engine', params: { tcp } }
            : hostId
              ? { kind: 'ssh', hostId }
              : { kind: 'module', sessionKind: 'engine', params: {} },
      {
        ready: async (client) => {
          const sshHost = hostId && !wsl && !tcp ? hostId : undefined
          await client.request({
            op: 'configure',
            readOnly: true,
            ...(sshHost ? { hostId: sshHost } : {})
          })
          await this.poll()
        },
        failed: (state, message) => {
          this.abort?.abort()
          this.state = state
          this.message = message
          this.publish()
        }
      }
    )
  }

  get id(): string {
    return sourceKeyOf(this.hostId)
  }

  start(): void {
    this.publish()
    this.session.start()
  }

  update(environment: string | null): void {
    if (environment === this.environment) return
    this.environment = environment
    this.publish()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    this.session.stop()
    removeFleet(this.id)
  }

  refresh(): void {
    if (this.stopped) return
    if (!this.session.client || this.state === 'error' || this.state === 'signin') {
      this.state = 'connecting'
      this.message = undefined
      this.publish()
      this.session.restart()
      return
    }
    void this.poll()
  }

  private gone(gen: number): boolean {
    return this.stopped || gen !== this.session.generation
  }

  private async poll(): Promise<void> {
    const client = this.session.client
    if (!client || this.stopped) return
    const gen = this.session.generation
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    const timeout = setTimeout(() => {
      abort.abort()
    }, TIMEOUT_MS)
    try {
      const [info, containers] = await Promise.all([
        client.request<EngineInfo>({ op: 'info' }, abort.signal),
        client.request<ContainerRow[]>({ op: 'containers', all: true }, abort.signal)
      ])
      if (this.gone(gen)) return
      this.info = info
      this.containers = containers
      this.checkedAt = Date.now()
      this.message = undefined
      const n = containerCounts(containers)
      this.state = n.restarting || n.unhealthy || n.failed ? 'warning' : 'ok'
      this.publish()
    } catch (e) {
      if (this.gone(gen)) return
      if (abort.signal.aborted && this.abort !== abort) return
      this.state = 'error'
      this.message = abort.signal.aborted
        ? t('Docker did not answer in time.')
        : friendlyError(e instanceof Error ? e.message : String(e))
      this.publish()
    } finally {
      clearTimeout(timeout)
      if (this.abort === abort) this.abort = null
    }
    if (gen !== this.session.generation || this.abort) return
    this.session.later(DOCKER_FLEET_EVERY_MS, () => {
      void this.poll()
    })
  }

  private publish(): void {
    if (this.stopped) return
    const host =
      this.hostId && !wslDistroOf(this.hostId) && !tcpIdOf(this.hostId)
        ? savedHost(this.hostId)
        : undefined
    publishFleet({
      id: this.id,
      module: 'docker',
      kind: 'Docker',
      title: sourceLabel(this.hostId),
      ...(host ? { subtitle: host.address } : {}),
      ...(this.environment ? { environment: this.environment } : {}),
      state: this.state,
      ...(this.message ? { message: this.message } : {}),
      ...(this.info ? { version: this.info.version } : {}),
      stats: this.containers ? dockerStats(this.containers) : [],
      notes: [],
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      open: () => {
        openDocker(this.hostId)
      },
      refresh: () => {
        this.refresh()
      }
    })
  }
}

/** Việc nền của module Docker: giữ đúng tập endpoint đang theo dõi theo cài đặt. */
export function startDockerFleet(): () => void {
  const monitors = new Map<string, EngineMonitor>()
  let endpoints: DockerEndpoint[] | null = null
  let stopped = false

  const sync = (): void => {
    if (stopped) return
    const cfg = monitorConfig()
    if (!cfg.loaded || !endpoints) return
    const want = new Map<string, { hostId: string | null; env: string | null }>()
    if (cfg.enabled)
      for (const e of endpoints) {
        if (e.hidden) continue
        const env = environmentOf(e.hostId, cfg.sourceEnvironments)
        if (isMonitored(cfg.overrides, sourceKeyOf(e.hostId), env))
          want.set(sourceKeyOf(e.hostId), { hostId: e.hostId, env })
      }
    for (const [key, m] of monitors)
      if (!want.has(key)) {
        m.stop()
        monitors.delete(key)
      }
    for (const [key, { hostId, env }] of want) {
      const m = monitors.get(key)
      if (m) m.update(env)
      else {
        const created = new EngineMonitor(hostId, env)
        monitors.set(key, created)
        created.start()
      }
    }
  }

  const reload = (): void => {
    dockerApi.endpoints().then(
      (list) => {
        endpoints = list
        sync()
      },
      () => undefined
    )
  }
  reload()
  const offChanged = dockerApi.onChanged(reload)
  const offConfig = onMonitorConfigChange(sync)
  return () => {
    stopped = true
    offChanged()
    offConfig()
    for (const m of monitors.values()) m.stop()
    monitors.clear()
  }
}
