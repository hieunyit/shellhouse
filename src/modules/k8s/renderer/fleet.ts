import {
  activateTab,
  backgroundSession,
  friendlyError,
  formatDate,
  isMonitored,
  monitorConfig,
  onMonitorConfigChange,
  publishAttention,
  publishFleet,
  removeFleet,
  t,
  tn,
  environmentFromColor,
  type BackgroundSession,
  type FleetItem,
  type FleetNote,
  type FleetStat
} from '../../registry/renderer-kit'
import type { ContextEntry } from '../shared/ipc'
import type { FleetResult } from '../shared/ops'
import { k8sSupport } from '../shared/support'
import { k8sApi, openCluster } from './api'
import { attentionOf, clusterTabs } from './attention'

/**
 * Theo dõi nền cho Home › Infrastructure: mở app là kết nối (chỉ đọc) tới các cluster đang theo
 * dõi — mặc định context thuộc môi trường Production — đọc tóm tắt mỗi vài phút, báo vấn đề lên
 * Needs attention. Không bao giờ hỏi mật khẩu / đăng nhập: cần đăng nhập thì chỉ báo trên Home.
 */

/** Đọc lại tóm tắt chừng này một lần. */
export const FLEET_EVERY_MS = 3 * 60_000
/** Một lần đọc tối đa (cluster chậm / mạng treo). */
const TIMEOUT_MS = 60_000
/** Chứng chỉ còn ít hơn chừng này ngày → nhắc. */
const CERT_WARN_DAYS = 30
const DAY_MS = 86_400_000

const sourceKeyOf = (c: ContextEntry): string => `k8s:${c.key}`

/** Môi trường của context: chọn trong Shellhouse, chưa chọn thì suy từ màu cũ (đỏ = Production). */
function environmentOf(c: ContextEntry, sources: Readonly<Record<string, string>>): string | null {
  return sources[sourceKeyOf(c)] ?? environmentFromColor(c.settings.color ?? null) ?? null
}

/** Ghi chú hết hỗ trợ / chứng chỉ (thuần — test). */
export function fleetNotes(r: FleetResult, now = Date.now()): FleetNote[] {
  const notes: FleetNote[] = []
  const support = k8sSupport(r.version, now)
  const provider = support.provider
    ? ` ${t('{provider} may support it longer.', { provider: support.provider })}`
    : ''
  if (support.status === 'ended')
    notes.push({
      severity: 'danger',
      text:
        (support.endOfLife
          ? t('Kubernetes {version} reached end of support on {date}.', {
              version: support.minor,
              date: formatDate(support.endOfLife)
            })
          : t('Kubernetes {version} is no longer supported.', { version: support.minor })) +
        provider
    })
  else if (support.status === 'ending' && support.endOfLife)
    notes.push({
      severity: 'warning',
      text:
        tn(
          Math.max(1, support.daysLeft ?? 1),
          'Kubernetes {version} support ends in {n} day ({date}).',
          'Kubernetes {version} support ends in {n} days ({date}).',
          { version: support.minor, date: formatDate(support.endOfLife) }
        ) + provider
    })
  const cert = (at: string | undefined, expired: string, soon: [string, string]): void => {
    if (!at) return
    const left = (Date.parse(at) - now) / DAY_MS
    if (left < 0) notes.push({ severity: 'danger', text: t(expired, { date: formatDate(at) }) })
    else if (left < CERT_WARN_DAYS)
      notes.push({
        severity: 'warning',
        text: tn(Math.max(1, Math.floor(left)), soon[0], soon[1], { date: formatDate(at) })
      })
  }
  cert(r.serverCertExpiry, 'The API server certificate expired on {date}.', [
    'The API server certificate expires in {n} day ({date}).',
    'The API server certificate expires in {n} days ({date}).'
  ])
  cert(r.clientCertExpiry, 'Your client certificate in the kubeconfig expired on {date}.', [
    'Your client certificate in the kubeconfig expires in {n} day ({date}).',
    'Your client certificate in the kubeconfig expires in {n} days ({date}).'
  ])
  return notes
}

/** Số liệu ngắn trên hàng (thuần — test). */
export function fleetStats(r: FleetResult): FleetStat[] {
  const failing = r.problems.failing.total + r.problems.imagePull.total
  const pending = r.problems.pending.total
  const notReady = r.nodes.total - r.nodes.ready
  const noNodes = r.limited?.includes('nodes') === true
  const noPods = r.limited?.includes('pods') === true
  return [
    noNodes
      ? { label: t('Nodes'), value: '—', tone: 'muted', title: t('No permission to list nodes') }
      : {
          label: t('Nodes'),
          value: `${String(r.nodes.ready)}/${String(r.nodes.total)}`,
          tone: notReady > 0 ? 'danger' : 'ok',
          title:
            notReady > 0
              ? tn(notReady, '{n} node not ready', '{n} nodes not ready')
              : t('All nodes ready')
        },
    noPods
      ? {
          label: t('Failing pods'),
          value: '—',
          tone: 'muted',
          title: t('No permission to read pods across the cluster')
        }
      : {
          label: t('Failing pods'),
          value: String(failing),
          tone: failing > 0 ? 'danger' : 'muted'
        },
    ...(pending > 0
      ? [{ label: t('Pending'), value: String(pending), tone: 'warning' as const }]
      : [])
  ]
}

/** Một cluster đang theo dõi: phiên chỉ đọc riêng, đọc tóm tắt theo nhịp. */
class ClusterMonitor {
  private readonly session: BackgroundSession
  private stopped = false
  private result: FleetResult | null = null
  private checkedAt: number | undefined
  private state: FleetItem['state'] = 'connecting'
  private message: string | undefined
  private abort: AbortController | null = null

  constructor(
    private entry: ContextEntry,
    private environment: string | null
  ) {
    this.session = backgroundSession(
      'k8s',
      () => {
        const bastion = this.entry.settings.bastionHostId
        return bastion
          ? { kind: 'ssh', hostId: bastion }
          : { kind: 'module', sessionKind: 'cluster', params: {} }
      },
      {
        ready: async (client) => {
          await client.request({ op: 'connect', ref: this.entry.ref, readOnly: true })
          // Ghi event của cluster về máy (7 ngày) cho tab Timeline — chạy trong phiên này.
          void client.request({ op: 'events.record', on: true }).catch(() => undefined)
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
    return sourceKeyOf(this.entry)
  }

  start(): void {
    this.publish()
    this.session.start()
  }

  /** Tên / môi trường đổi → vẽ lại; bastion đổi → kết nối lại. */
  update(entry: ContextEntry, environment: string | null): void {
    const reconnect = entry.settings.bastionHostId !== this.entry.settings.bastionHostId
    const changed =
      reconnect ||
      entry.name !== this.entry.name ||
      entry.server !== this.entry.server ||
      environment !== this.environment
    this.entry = entry
    this.environment = environment
    if (reconnect) {
      this.state = 'connecting'
      this.session.restart()
    }
    if (changed) this.publish()
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    this.session.stop()
    removeFleet(this.id)
    publishAttention(this.attentionId, null)
  }

  /** Nút làm mới trên Home: lỗi / cần đăng nhập → kết nối lại; đang chạy → đọc lại ngay. */
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

  /** Đã dừng / phiên đã đổi kể từ lần `gen` — kết quả cũ bỏ đi. */
  private gone(gen: number): boolean {
    return this.stopped || gen !== this.session.generation
  }

  private get attentionId(): string {
    return `k8s-fleet:${this.entry.key}`
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
      const r = await client.request<FleetResult>({ op: 'fleet' }, abort.signal)
      if (this.gone(gen)) return
      this.result = r
      this.checkedAt = Date.now()
      this.message = undefined
      const notes = fleetNotes(r)
      const bad =
        r.nodes.ready < r.nodes.total ||
        r.problems.failing.total + r.problems.imagePull.total > 0 ||
        notes.some((n) => n.severity !== 'info')
      this.state = bad ? 'warning' : 'ok'
      this.publish()
      publishAttention(
        this.attentionId,
        monitorConfig().attention
          ? attentionOf(r.problems, this.entry.name, (kind, ns, name) => {
              this.reveal(kind, ns, name)
            })
          : null
      )
    } catch (e) {
      // Bị huỷ vì phiên đóng / có lần đọc mới → bỏ qua; quá giờ / lỗi thật → báo.
      if (this.gone(gen)) return
      if (abort.signal.aborted && this.abort !== abort) return
      this.state = 'error'
      this.message = abort.signal.aborted
        ? t('The cluster did not answer in time.')
        : friendlyError(e instanceof Error ? e.message : String(e))
      this.publish()
    } finally {
      clearTimeout(timeout)
      if (this.abort === abort) this.abort = null
    }
    if (gen !== this.session.generation || this.abort) return
    this.session.later(FLEET_EVERY_MS, () => {
      void this.poll()
    })
  }

  /** Mở đối tượng: tab cluster đang mở thì dùng nó, không thì mở tab mới tới đúng chỗ. */
  private reveal(kind: string, ns: string | undefined, name: string): void {
    const tab = clusterTabs.get(this.entry.key)
    if (tab) {
      activateTab(tab.tabId)
      tab.open(kind, ns, name)
      return
    }
    openCluster(this.entry, { kind, ...(ns ? { namespace: ns } : {}), name })
  }

  private publish(): void {
    if (this.stopped) return
    const r = this.result
    publishFleet({
      id: this.id,
      module: 'k8s',
      kind: 'Kubernetes',
      title: this.entry.name,
      subtitle: this.entry.server,
      ...(this.environment ? { environment: this.environment } : {}),
      state: this.state,
      ...(this.message ? { message: this.message } : {}),
      ...(r?.version ? { version: r.version } : {}),
      stats: r ? fleetStats(r) : [],
      notes: r ? fleetNotes(r) : [],
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      open: () => {
        const tab = clusterTabs.get(this.entry.key)
        if (tab) activateTab(tab.tabId)
        else openCluster(this.entry)
      },
      refresh: () => {
        this.refresh()
      }
    })
  }
}

/** Việc nền của module Kubernetes: giữ đúng tập cluster đang theo dõi theo cài đặt. */
export function startK8sFleet(): () => void {
  const monitors = new Map<string, ClusterMonitor>()
  let contexts: ContextEntry[] | null = null
  let stopped = false

  const sync = (): void => {
    if (stopped) return
    const cfg = monitorConfig()
    if (!cfg.loaded || !contexts) return
    const want = new Map<string, { entry: ContextEntry; env: string | null }>()
    if (cfg.enabled)
      for (const c of contexts) {
        if (c.settings.hidden) continue
        const env = environmentOf(c, cfg.sourceEnvironments)
        if (isMonitored(cfg.overrides, sourceKeyOf(c), env)) want.set(c.key, { entry: c, env })
      }
    for (const [key, m] of monitors)
      if (!want.has(key)) {
        m.stop()
        monitors.delete(key)
      }
    for (const [key, { entry, env }] of want) {
      const m = monitors.get(key)
      if (m) m.update(entry, env)
      else {
        const created = new ClusterMonitor(entry, env)
        monitors.set(key, created)
        created.start()
      }
    }
  }

  const reload = (): void => {
    k8sApi.contexts().then(
      (list) => {
        contexts = list.contexts
        sync()
      },
      () => undefined
    )
  }
  reload()
  const offChanged = k8sApi.onChanged(reload)
  const offConfig = onMonitorConfigChange(sync)
  return () => {
    stopped = true
    offChanged()
    offConfig()
    for (const m of monitors.values()) m.stop()
    monitors.clear()
  }
}
