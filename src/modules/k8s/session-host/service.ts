import { usablePrinterColumns, type PrinterColumn } from '../shared/printer'
import { findPrometheus, podRange, type PromTarget } from './prometheus'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { parse as parseYaml, stringify as toYaml } from 'yaml'
import { z } from 'zod'
import { t } from '@shared/i18n'
import {
  configScanArgs,
  parseTrivyReport,
  SCAN_MAX_OUTPUT_BYTES,
  SCAN_TIMEOUT_MS,
  trivyFailure
} from '@shared/trivy'
import type WebSocket from 'ws'
import type { HostModuleSession, TerminalSize } from '../../registry/host-types'
import type { Transport, TransportCallbacks } from '../../../session-host/transport/types'
import {
  K8sOp,
  K8sTerminalParams,
  contextKey,
  isMutating,
  type ContextRef,
  type DiscoveredKind,
  type MetricsRange,
  type PortForwardInfo
} from '../shared/ops'
import {
  BUILTIN_GROUPS,
  BUILTIN_KINDS,
  hideSecretValues,
  hideSecretValuesForEdit,
  resourcePath,
  slim,
  type K8sObject,
  type ResourceKind
} from '../shared/resources'
import { KubeClient, KubeError, KubeTimeoutError, type RawConnect } from './client'
import { openTunnel } from '../../../node-shared/proxy-tunnel'
import { isCertificateError, isProxyUrl } from '@shared/proxy'
import { credentialProvider, type AuthConfig, type OidcTokens } from './auth'
import {
  cordon,
  keepHiddenSecretValues,
  pool,
  cronSuspend,
  cronTrigger,
  drain,
  argoRefresh,
  argoSync,
  counts,
  health,
  problems,
  fleet,
  helmRelease,
  helmReleases,
  logTargets,
  metrics,
  overview,
  rollback,
  rolloutHistory,
  serverApply
} from './operations'
import { debugEphemeral, debugNode } from './debug'
import { diffObjects } from './diff'
import { helmRevision, helmRollback, helmUninstall } from './helm'
import { mapData } from './map'
import { egressData } from './egress'
import { HostResolver, type Lookup } from './resolve'
import { recordEvents } from './eventRecorder'
import { workloadTimeline } from './timeline'
import { eventCounts, probeHistory, trafficRange, trafficSeries } from './history'
import type { HistoryProbe } from '../shared/history'
import type { QueryEvents, RecordedEvent } from '../shared/timeline'
import { podTemplate, related } from './related'
import { selectorMatches } from '../shared/map'
import { rbacReach, topology } from './topology'
import { disposeTrafficCache, trafficSample, type TrafficCache } from './traffic'

/** Kết quả `fromMain('resolve')` (xem main/kubeconfig.ts). */
export interface ResolvedClusterConfig {
  name: string
  server: string
  ca?: string
  insecure: boolean
  tlsServerName?: string
  /** Proxy tới API server (proxy-url của kubeconfig hoặc Settings › Network). */
  proxyUrl?: string
  namespace: string
  /** Chế độ chỉ đọc lưu trong main (renderer không tắt được). */
  readOnly?: boolean
  auth: AuthConfig
}

const Pem = z.string().max(256 * 1024)
const Secret = z.string().max(64 * 1024)
/** Kiểm kết quả `resolve` từ main trước khi dùng (không tin cast). */
export const ResolvedClusterSchema = z.object({
  name: z.string().max(253),
  server: z
    .string()
    .max(2048)
    .refine((v) => URL.canParse(v), 'Invalid server address'),
  ca: Pem.optional(),
  insecure: z.boolean(),
  tlsServerName: z.string().max(253).optional(),
  /** Proxy tới API server (proxy-url của kubeconfig hoặc Settings › Network). */
  proxyUrl: z
    .string()
    .max(500)
    .refine((v) => isProxyUrl(v), 'Invalid proxy URL')
    .optional(),
  namespace: z.string().max(63),
  readOnly: z.boolean().optional(),
  auth: z.object({
    token: Secret.optional(),
    cert: Pem.optional(),
    key: Pem.optional(),
    username: z.string().max(1024).optional(),
    password: Secret.optional(),
    exec: z
      .object({
        command: z.string().max(4096),
        args: z.array(z.string().max(4096)).max(128),
        env: z.record(z.string().max(1024), z.string().max(64 * 1024)),
        apiVersion: z.string().max(253)
      })
      .optional(),
    oidc: z
      .object({
        idToken: Secret.optional(),
        refreshToken: Secret.optional(),
        issuer: z.string().max(2048).optional(),
        clientId: z.string().max(1024).optional(),
        clientSecret: Secret.optional(),
        idpCa: Pem.optional()
      })
      .optional()
  })
})

export interface K8sServiceDeps {
  resolve(ref: ContextRef): Promise<ResolvedClusterConfig>
  rawConnect: RawConnect
  spawn: import('../../registry/host-types').LimitedSpawn
  emit(event: string, data: unknown): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Đường dẫn có phải file tạm "sửa trong editor" do main cấp không (thiếu → không cho sửa). */
  checkEditFile?(path: string): Promise<boolean>
  /** Lưu token OIDC vừa làm mới vào kubeconfig / bản import (refresh token xoay vòng). */
  persistOidc?(ref: ContextRef, tokens: OidcTokens): Promise<void>
  /** Ghi một lô event của cluster (main lưu 7 ngày) — thiếu → không ghi. */
  recordEvents?(cluster: string, events: RecordedEvent[]): Promise<void>
  /** Phân giải DNS (thiếu → dùng bộ phân giải của hệ điều hành). */
  lookup?: Lookup
  /** Event đã ghi trên máy + cluster có đang được ghi không. */
  queryEvents?(q: QueryEvents): Promise<{ events: RecordedEvent[]; recording: boolean }>
}

/** Nhóm API có sẵn của Kubernetes — tài nguyên nhóm khác là CRD ("Custom resources"). */
/** Nhóm có sẵn của Kubernetes (Gateway API… đuôi .k8s.io nhưng là CRD — vẫn liệt kê). */
function isBuiltinGroup(group: string): boolean {
  return BUILTIN_GROUPS.has(group)
}

const WATCH_FLUSH_MS = 100
/** Watch không nhận byte nào chừng này → coi kết nối đã chết, nối lại (test chỉnh được). */
export const watchIdle = { ms: 360_000 }
/**
 * Dò kết nối tới API server khi đang có watch: server im lặng không có nghĩa là chết (watch yên
 * ắng bình thường), nên hỏi thẳng `/version`. `failures` lần liên tiếp không trả lời → báo "cũ" tới
 * renderer; trả lời lại → ngắt các luồng watch (có thể là socket nửa chết) để nối lại từ resourceVersion.
 * Test chỉnh được.
 */
export const linkProbe = { intervalMs: 10_000, timeoutMs: 5_000, failures: 2 }
/** Danh mục loại / quyền list được nhớ chừng này (CRD mới cài hiện sau tối đa 5 phút / Reload). */
const DISCOVERY_TTL_MS = 5 * 60_000
/** Chờ trước khi nối lại watch sau lỗi: base × 2^lần, tối đa max (test rút ngắn được). */
export const watchRetry = { baseMs: 1000, maxMs: 30_000 }

export const DEFAULT_POD_SHELL = [
  'sh',
  '-c',
  'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
]

interface SharedWatch {
  /** Khoá trong `watches`. */
  key: string
  /** resourceVersion bắt đầu; `advanced` = đã nhận sự kiện (người đến sau không dùng chung được). */
  startRv: string
  advanced: boolean
  subscribers: Set<string>
  controller: AbortController
  /** Lần kết nối hiện tại — huỷ riêng để nối lại mà không dừng cả watch. */
  attempt: AbortController | null
  pending: { type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: unknown }[]
  timer: NodeJS.Timeout | null
}

/** Port-forward: dừng đọc phía bên kia khi bộ đệm gửi vượt mức này (byte). */
const FORWARD_HIGH_WATER = 1024 * 1024
/** Sửa trong editor: hỏi file mỗi 500 ms; lâu không đổi thì thưa dần, rất lâu thì thôi theo dõi. */
const EDIT_POLL_MS = 500
const EDIT_SLOW_POLL_MS = 3000
const EDIT_SLOW_AFTER_MS = 10 * 60_000
const EDIT_STOP_AFTER_MS = 8 * 60 * 60_000
const MAX_EDITS = 20

interface Forward {
  info: PortForwardInfo
  /** null = đang tắt tạm. */
  server: Server | null
  sockets: Set<Socket>
  client: KubeClient
  /** Pod + cổng đích hiện tại (tìm lại khi pod bị thay). */
  resolved: { pod: string; port: number }
}

/** Không thấy Prometheus → dò lại sau chừng này (có thể vừa được cài). */
const PROM_RETRY_MS = 5 * 60_000
/** Prometheus đã thấy → dò lại sau chừng này (bị gỡ / đổi tên / chuyển namespace). */
const PROM_TTL_MS = 10 * 60_000

/**
 * File sửa phải là file thường (hoặc chưa có) trong thư mục thật — không phải symlink trỏ ra chỗ
 * khác (đường dẫn đã được main xác nhận nằm trong thư mục tạm của nó).
 */
async function assertEditTarget(path: string): Promise<void> {
  const dir = await lstat(dirname(path))
  if (!dir.isDirectory() || dir.isSymbolicLink())
    throw new Error('This file cannot be used for editing')
  const file = await lstat(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  })
  if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink > 1))
    throw new Error('This file cannot be used for editing')
}

/** Ghi file, không đi theo symlink (O_NOFOLLOW nơi có), quyền 0600. */
async function writeNoFollow(path: string, text: string): Promise<void> {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_TRUNC |
    ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0)
  const handle = await open(path, flags, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
}

export class K8sService implements HostModuleSession {
  private client: KubeClient | null = null
  private cluster: ResolvedClusterConfig | null = null
  /** Khoá context đang kết nối (`source#context`). */
  private refKey: string | null = null
  /** Đang ghi event của cluster về máy (theo dõi ở Home). */
  private recorder: AbortController | null = null
  /** Prometheus có metric gì (dò lại sau PROM_RETRY_MS). */
  private probe: { value: HistoryProbe; at: number } | null = null
  private readOnly = false
  private kinds = new Map<string, ResourceKind>(BUILTIN_KINDS.map((k) => [k.id, k]))
  private readonly subscriptions = new Map<string, () => void>()
  private readonly watches = new Map<string, SharedWatch>()
  private readonly forwards = new Map<string, Forward>()
  /** Prometheus đã dò (null = không có; dò lại sau PROM_RETRY_MS). */
  private prom: { target: PromTarget | null; at: number } | null = null
  /** Agent Caretta / Service → workload đã dò (dùng lại 60 s). */
  private readonly trafficCache: TrafficCache = {}
  private readonly edits = new Map<string, { name: string; stop: () => void }>()
  private disposed = false
  /** Dò kết nối (xem `linkProbe`): chạy khi có watch. `down` = đã báo "cũ" cho renderer. */
  private probeTimer: NodeJS.Timeout | null = null
  private link = { down: false, failures: 0 }

  private readonly hostResolver: HostResolver
  constructor(private readonly deps: K8sServiceDeps) {
    this.hostResolver = new HostResolver(deps.lookup)
  }

  private async connect(ref: ContextRef): Promise<KubeClient> {
    const cluster: ResolvedClusterConfig = ResolvedClusterSchema.parse(await this.deps.resolve(ref))
    // Kết nối lại (đổi chế độ chỉ đọc…): đóng kết nối giữ lại của client cũ (watch / log / forward
    // đang chạy giữ kết nối riêng, không ảnh hưởng).
    this.client?.close()
    this.cluster = cluster
    this.prom = null
    this.probe = null
    // Có proxy: mọi kết nối tới API server mở đường hầm qua proxy (proxy đi thẳng, hoặc qua bastion).
    const raw = this.deps.rawConnect
    const proxyUrl = cluster.proxyUrl
    this.client = new KubeClient(
      cluster,
      proxyUrl ? (host, port) => openTunnel(proxyUrl, host, port, raw) : raw,
      credentialProvider(cluster.auth, this.deps.spawn, cluster.server, Date.now, {
        log: (message) => {
          this.deps.log('warn', message)
        },
        reloadOidc: async () =>
          ResolvedClusterSchema.parse(await this.deps.resolve(ref)).auth.oidc ?? null,
        onOidcRefreshed: (tokens) => {
          void this.deps.persistOidc?.(ref, tokens).catch((error: unknown) => {
            this.deps.log(
              'warn',
              `could not save the refreshed OIDC token: ${error instanceof Error ? error.message : String(error)}`
            )
          })
        }
      })
    )
    this.deps.log('info', `context ${cluster.name} → ${cluster.server}`)
    return this.client
  }

  /** Chỉ đọc: renderer bật, HOẶC cài đặt của context trong main bật (renderer không tắt được). */
  private get locked(): boolean {
    return this.readOnly || this.cluster?.readOnly === true
  }

  private require(): KubeClient {
    if (!this.client) throw new Error('Not connected to a cluster')
    return this.client
  }

  /**
   * Cột in của CRD đúng phiên bản đang dùng. Không phải CRD (API gộp như metrics.k8s.io), không đọc
   * được CRD (thiếu quyền) hay CRD không khai báo cột → [] (bảng chỉ có Name / Namespace / Age).
   */
  private async crdColumns(
    client: KubeClient,
    kindId: string,
    signal: AbortSignal
  ): Promise<PrinterColumn[]> {
    const kind = this.kinds.get(kindId)
    if (!kind?.group || BUILTIN_GROUPS.has(kind.group)) return []
    try {
      const crd = await client.json<{
        spec?: {
          versions?: { name?: string; additionalPrinterColumns?: Record<string, unknown>[] }[]
        }
      }>(
        'GET',
        `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${encodeURIComponent(`${kind.plural}.${kind.group}`)}`,
        { signal }
      )
      const version = crd.spec?.versions?.find((v) => v.name === kind.version)
      return usablePrinterColumns(version?.additionalPrinterColumns ?? [])
    } catch (error) {
      if (signal.aborted) throw error
      return []
    }
  }

  private kind(id: string): ResourceKind {
    const k = this.kinds.get(id)
    if (!k) throw new Error(`Unknown resource type ${id}`)
    return k
  }

  async run(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const op = K8sOp.parse(raw)
    if (op.op === 'unsubscribe') {
      this.subscriptions.get(op.subscription)?.()
      this.subscriptions.delete(op.subscription)
      return null
    }
    if (op.op === 'connect') {
      this.readOnly = op.readOnly
      // Đổi context: bộ ghi event của cluster cũ dừng (renderer bật lại nếu cần).
      if (this.refKey !== contextKey(op.ref)) this.stopRecorder()
      const client = await this.connect(op.ref)
      this.refKey = contextKey(op.ref)
      const version = await client
        .json<{ gitVersion?: string }>('GET', '/version', { signal })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          // Chứng chỉ tự ký / proxy công ty chặn TLS: chỉ chỗ bật bỏ qua kiểm tra.
          if (isCertificateError(message))
            throw new Error(
              t(
                '{error} — if you trust this API server, turn on “Skip certificate verification” in the context settings',
                { error: message }
              )
            )
          throw error
        })
      return {
        version: version.gitVersion ?? '',
        namespace: this.cluster?.namespace ?? 'default',
        readOnly: this.locked
      }
    }
    if (this.locked && isMutating(op))
      throw new Error(t('Read-only mode is on for this context — turn it off to make changes'))
    const client = this.require()
    switch (op.op) {
      case 'namespaces': {
        try {
          const list = await client.json<{ items: K8sObject[] }>('GET', '/api/v1/namespaces', {
            signal
          })
          return { names: list.items.map((n) => n.metadata.name).sort(), canList: true }
        } catch (error) {
          if (error instanceof KubeError && error.status === 403)
            return { names: [this.cluster?.namespace ?? 'default'], canList: false }
          throw error
        }
      }
      case 'discover':
        if (op.refresh) {
          this.catalog = null
          this.access.clear()
        }
        return this.discover(client, op.namespace, signal)
      case 'crd.columns':
        return this.crdColumns(client, op.kind, signal)
      case 'list': {
        const kind = this.kind(op.kind)
        const res = await client.json<{
          items: K8sObject[]
          metadata: { resourceVersion?: string; continue?: string }
        }>('GET', resourcePath(kind, op.namespace), {
          query: {
            limit: op.limit,
            continue: op.continue,
            labelSelector: op.labelSelector || undefined,
            fieldSelector: op.fieldSelector || undefined
          },
          signal
        })
        const clean = (o: K8sObject): K8sObject =>
          kind.id === 'secrets' ? hideSecretValues(slim(o)) : slim(o)
        return {
          items: res.items.map(clean),
          resourceVersion: res.metadata.resourceVersion ?? '',
          continue: res.metadata.continue ?? null
        }
      }
      case 'watch':
        return this.watch(
          op.kind,
          op.namespace,
          op.labelSelector,
          op.resourceVersion,
          op.fieldSelector
        )
      case 'get': {
        const kind = this.kind(op.kind)
        let o = slim(
          await client.json<K8sObject>('GET', resourcePath(kind, op.namespace, op.name), { signal })
        )
        // YAML (để sửa / áp lại) ghi kèm khoá bị ẩn → lưu lại thì chỉ giữ giá trị của đúng các khoá đó.
        if (kind.id === 'secrets')
          o = op.format === 'yaml' ? hideSecretValuesForEdit(o) : hideSecretValues(o)
        return op.format === 'yaml' ? toYaml(o) : o
      }
      case 'scan': {
        const kind = this.kind(op.kind)
        // Secret có giá trị bí mật — không đưa cho chương trình ngoài, cũng không có gì để quét.
        if (kind.id === 'secrets') throw new Error(t('Secrets are not scanned.'))
        const live = slim(
          await client.json<K8sObject>('GET', resourcePath(kind, op.namespace, op.name), { signal })
        )
        const dir = await mkdtemp(join(tmpdir(), 'shellhouse-scan-'))
        try {
          await writeFile(join(dir, 'resource.yaml'), toYaml(live), { mode: 0o600 })
          const r = await this.deps.spawn.exec('trivy', configScanArgs(dir), {
            timeoutMs: SCAN_TIMEOUT_MS,
            maxOutputBytes: SCAN_MAX_OUTPUT_BYTES,
            signal
          })
          if (r.code !== 0) throw trivyFailure(r.code, r.stderr)
          const label = `${kind.kind} ${op.namespace ? `${op.namespace}/` : ''}${op.name}`
          return parseTrivyReport(r.stdout, label, Date.now(), true)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
      case 'apply':
        return this.apply(client, op.yaml, signal)
      case 'delete':
        await client.json('DELETE', resourcePath(this.kind(op.kind), op.namespace, op.name), {
          // Như kubectl: luôn xoá nền — không gửi thì REST mặc định của Job là "orphan" (pod con ở lại).
          query: {
            propagationPolicy: 'Background',
            ...(op.force ? { gracePeriodSeconds: 0 } : {})
          },
          signal
        })
        return null
      case 'serverApply':
        return serverApply(
          client,
          op.yaml,
          op.namespace ?? this.cluster?.namespace ?? 'default',
          (v, k) => this.findKind(client, v, k),
          signal
        )
      case 'metrics':
        return metrics(client, op.scope, op.namespace, signal)
      case 'metrics.range': {
        const target = await this.prometheus(client, signal)
        if (!target)
          return {
            source: 'none',
            reason: 'No Prometheus found in the cluster (or not allowed to use services/proxy)'
          } satisfies MetricsRange
        try {
          return await podRange(client, target, op.namespace, op.pods, op.minutes, signal)
        } catch (error) {
          // Prometheus đã gỡ / đổi chỗ → lần sau dò lại.
          if (error instanceof KubeError) this.prom = null
          throw error
        }
      }
      case 'overview':
        return overview(client, op.namespaces, signal)
      case 'argoSync':
      case 'argoRefresh': {
        const version = this.kinds.get('applications.argoproj.io')?.version ?? 'v1alpha1'
        if (op.op === 'argoSync')
          await argoSync(client, version, op.namespace, op.name, op.prune, signal)
        else await argoRefresh(client, version, op.namespace, op.name, op.hard, signal)
        return null
      }
      case 'map':
        return mapData(client, op.namespaces, signal)
      case 'resolve':
        return this.hostResolver.resolve(op.hosts, signal, op.internal === true)
      case 'egress':
        return egressData(client, op.namespaces, op.secrets, signal, op.workload)
      case 'helm.releases':
        return helmReleases(client, op.namespaces, signal)
      case 'helm.release':
        return helmRelease(client, op.namespace, op.name, signal)
      case 'helm.revision':
        return helmRevision(client, op.namespace, op.name, op.revision, signal)
      case 'helm.rollback':
        return helmRollback(
          client,
          op.namespace,
          op.name,
          op.revision,
          (v, k) => this.findKind(client, v, k),
          signal
        )
      case 'helm.uninstall':
        return helmUninstall(
          client,
          op.namespace,
          op.name,
          op.keepHistory,
          (v, k) => this.findKind(client, v, k),
          signal
        )
      case 'diff':
        return diffObjects(
          client,
          op.mode,
          op.yaml,
          op.namespace ?? this.cluster?.namespace ?? 'default',
          (v, k) => this.findKind(client, v, k),
          signal
        )
      case 'debug.ephemeral':
        return debugEphemeral(client, op.namespace, op.pod, op.image, op.target, signal)
      case 'debug.node':
        return debugNode(client, op.node, op.image, op.namespace, signal)
      case 'health':
        return health(client, signal)
      case 'problems':
        return problems(client, signal)
      case 'fleet':
        return fleet(client, this.cluster?.auth.cert, signal)
      case 'events.record':
        if (op.on) this.startRecorder(client)
        else this.stopRecorder()
        return { recording: this.recorder !== null }
      case 'timeline': {
        const cluster = this.refKey
        const deps = this.deps
        const target = await this.prometheus(client, signal)
        const probe = await this.historyProbe(client, signal)
        return workloadTimeline(
          client,
          op.kind,
          op.namespace,
          op.name,
          (q) =>
            cluster && deps.queryEvents
              ? deps.queryEvents({ ...q, cluster })
              : Promise.resolve({ events: [], recording: false }),
          signal,
          Date.now(),
          probe.events
            ? (pattern, start, end) =>
                eventCounts(client, target, probe, op.namespace, pattern, start, end, signal)
            : undefined
        )
      }
      case 'history.probe':
        return this.historyProbe(client, signal)
      case 'traffic.range': {
        const target = await this.prometheus(client, signal)
        const probe = await this.historyProbe(client, signal)
        return trafficRange(client, target, probe, this.trafficCache, op.start, op.end, signal)
      }
      case 'traffic.series': {
        const target = await this.prometheus(client, signal)
        const probe = await this.historyProbe(client, signal)
        const kind = this.kind(op.kind)
        const w = await client.json<K8sObject>('GET', resourcePath(kind, op.namespace, op.name), {
          signal
        })
        // Service chọn pod của workload (Caretta ghi phía server là Service khi gọi qua ClusterIP).
        const labels = podTemplate(op.kind, w)?.labels ?? {}
        const services = await client
          .json<{ items: K8sObject[] }>(
            'GET',
            `/api/v1/namespaces/${encodeURIComponent(op.namespace)}/services`,
            { signal }
          )
          .then((r) =>
            r.items
              .filter((svc) => {
                const sel = (svc.spec?.['selector'] ?? {}) as Record<string, string>
                return Object.keys(sel).length > 0 && selectorMatches(sel, labels)
              })
              .map((svc) => svc.metadata.name)
          )
          .catch(() => [])
        return trafficSeries(
          client,
          target,
          probe,
          {
            ns: op.namespace,
            name: op.name,
            kind: kind.kind,
            services
          },
          op.start,
          op.end,
          signal
        )
      }
      case 'counts':
        return counts(
          client,
          op.kinds.map((id) => this.kinds.get(id)).filter((k) => k !== undefined),
          op.namespaces,
          signal
        )
      case 'related': {
        const kind = this.kind(op.kind)
        const obj = await client.json<K8sObject>('GET', resourcePath(kind, op.namespace, op.name), {
          signal
        })
        return related(client, kind.id, obj, signal)
      }
      case 'topology': {
        const kind = this.kind(op.kind)
        const obj = await client.json<K8sObject>('GET', resourcePath(kind, op.namespace, op.name), {
          signal
        })
        return topology(client, kind.id, obj, signal)
      }
      case 'traffic':
        return trafficSample(client, this.trafficCache, signal)
      case 'rbacReach':
        return rbacReach(client, op.namespace, op.serviceAccount, signal)
      case 'rolloutHistory':
        return rolloutHistory(client, op.namespace, op.name, signal)
      case 'rollback':
        await rollback(client, op.namespace, op.name, op.revision, signal)
        return null
      case 'cordon':
        await cordon(client, op.node, op.unschedulable, signal)
        return null
      case 'drain':
        return drain(
          client,
          op.node,
          {
            gracePeriodSeconds: op.gracePeriodSeconds,
            deleteEmptyDirData: op.deleteEmptyDirData,
            force: op.force,
            timeoutSeconds: op.timeoutSeconds
          },
          signal
        )
      case 'cronTrigger':
        return cronTrigger(client, op.namespace, op.name, signal)
      case 'cronSuspend':
        await cronSuspend(client, op.namespace, op.name, op.suspend, signal)
        return null
      case 'scale':
        await client.json(
          'PATCH',
          resourcePath(this.kind(op.kind), op.namespace, op.name, 'scale'),
          {
            body: { spec: { replicas: op.replicas } },
            contentType: 'application/merge-patch+json',
            signal
          }
        )
        return null
      case 'rolloutRestart':
        await client.json('PATCH', resourcePath(this.kind(op.kind), op.namespace, op.name), {
          body: {
            spec: {
              template: {
                metadata: {
                  annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() }
                }
              }
            }
          },
          contentType: 'application/strategic-merge-patch+json',
          signal
        })
        return null
      case 'rolloutPause':
        await client.json(
          'PATCH',
          resourcePath(this.kind('deployments.apps'), op.namespace, op.name),
          {
            body: { spec: { paused: op.paused } },
            contentType: 'application/merge-patch+json',
            signal
          }
        )
        return null
      case 'logs.subscribe': {
        const targets = await logTargets(client, op.namespace, op, signal)
        const prefixed = targets.length > 1
        return this.subscribe('logs', async (id, s) => {
          let buffer = ''
          let timer: NodeJS.Timeout | null = null
          const flush = (): void => {
            if (timer) clearTimeout(timer)
            timer = null
            if (buffer) this.deps.emit('logs', { subscription: id, stream: 'stdout', text: buffer })
            buffer = ''
          }
          const push = (text: string): void => {
            buffer += text
            if (buffer.length > 64 * 1024) flush()
            else timer ??= setTimeout(flush, 50)
          }
          try {
            // Nhiều nguồn: mỗi dòng có tiền tố pod/container (như `stern` / log workload của Lens).
            await Promise.all(
              targets.map(async (t) => {
                const decoder = new TextDecoder()
                let partial = ''
                const prefix = prefixed ? `[${t.pod}${t.container ? `/${t.container}` : ''}] ` : ''
                const onChunk = (chunk: Buffer): void => {
                  const text = decoder.decode(chunk, { stream: true })
                  if (!prefixed) {
                    push(text)
                    return
                  }
                  partial += text
                  const lines = partial.split('\n')
                  partial = lines.pop() ?? ''
                  if (lines.length) push(lines.map((l) => `${prefix}${l}\n`).join(''))
                }
                // Follow: proxy (Rancher, load balancer…) cắt luồng giữa chừng → theo dõi tiếp từ
                // lúc bị cắt (sinceTime), không tải lại từ đầu. Lỗi liên tiếp không có dữ liệu → dừng.
                let since: string | null = null
                for (let quickFailures = 0; ;) {
                  const started = Date.now()
                  const seen = { data: false }
                  try {
                    await client.stream(
                      'GET',
                      `/api/v1/namespaces/${encodeURIComponent(op.namespace)}/pods/${encodeURIComponent(t.pod)}/log`,
                      {
                        query: {
                          follow: !op.previous,
                          previous: op.previous || undefined,
                          container: t.container,
                          ...(since
                            ? { sinceTime: since }
                            : {
                                tailLines: op.tail,
                                ...(op.sinceSeconds ? { sinceSeconds: op.sinceSeconds } : {})
                              }),
                          timestamps: op.timestamps || undefined
                        },
                        signal: s
                      },
                      (chunk) => {
                        seen.data = true
                        onChunk(chunk)
                      }
                    )
                    break
                  } catch (error) {
                    if (s.aborted || op.previous || error instanceof KubeError) throw error
                    const cut = seen.data || Date.now() - started > 10_000
                    quickFailures = cut ? 0 : quickFailures + 1
                    if (quickFailures >= 5) throw error
                    since = new Date(Date.now() - 1000).toISOString()
                    await new Promise((r) => setTimeout(r, cut ? 0 : 1000 * quickFailures))
                  }
                }
                if (partial) push(`${prefix}${partial}\n`)
              })
            )
          } finally {
            flush()
          }
        })
      }
      case 'portForward':
        return this.portForward(client, op.namespace, op.target, op.ports, signal)
      case 'portForward.stop': {
        const f = this.forwards.get(op.id)
        if (f) this.stopForward(f)
        return null
      }
      case 'portForward.pause': {
        const f = this.forwards.get(op.id)
        if (f) this.pauseForward(f)
        return null
      }
      case 'portForward.resume': {
        const f = this.forwards.get(op.id)
        if (f) await this.listenForward(f)
        return null
      }
      case 'portForwards':
        return [...this.forwards.values()].map((f) => f.info)
      case 'secret.reveal': {
        const secret = await client.json<K8sObject>(
          'GET',
          resourcePath(this.kind('secrets'), op.namespace, op.name),
          { signal }
        )
        const value = secret.data?.[op.key]
        if (value === undefined) throw new Error(`The secret has no key ${op.key}`)
        return Buffer.from(value, 'base64').toString('utf8')
      }
      case 'edit':
        return this.edit(client, this.kind(op.kind), op.namespace, op.name, op.localPath, signal)
    }
  }

  /** Loại theo apiVersion + kind (YAML người dùng) — hỏi discovery của group/version khi cần. */
  private async findKind(
    client: KubeClient,
    apiVersion: string,
    kindName: string
  ): Promise<ResourceKind | undefined> {
    const known = [...this.kinds.values()].find(
      (k) => k.kind === kindName && (k.group ? `${k.group}/${k.version}` : k.version) === apiVersion
    )
    if (known) return known
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion]
    const list = await client
      .json<{ resources: { name: string; kind: string; namespaced: boolean }[] }>(
        'GET',
        group ? `/apis/${group}/${version ?? ''}` : `/api/${version ?? ''}`
      )
      .catch(() => null)
    const r = list?.resources.find((x) => x.kind === kindName && !x.name.includes('/'))
    if (!r) return undefined
    const kind: ResourceKind = {
      id: group ? `${r.name}.${group}` : r.name,
      group: group ?? '',
      version: version ?? '',
      plural: r.name,
      kind: r.kind,
      namespaced: r.namespaced,
      title: r.kind,
      section: 'Custom resources'
    }
    this.kinds.set(kind.id, kind)
    return kind
  }

  /**
   * Loại tài nguyên cluster có (gồm CRD), đánh dấu loại không list được trong namespace đang xem
   * (SelfSubjectAccessReview) để ẩn khỏi điều hướng.
   */
  /** Danh mục loại (CRD + loại có sẵn mà cluster phục vụ) — đổi rất ít, nhớ 5 phút. */
  private catalog: { at: number; kinds: ResourceKind[] } | null = null
  /** Quyền list theo loại + namespace — nhớ 5 phút (đổi namespace không hỏi lại từ đầu). */
  private readonly access = new Map<string, { at: number; allowed: boolean }>()

  private async catalogOf(client: KubeClient, signal: AbortSignal): Promise<ResourceKind[]> {
    if (this.catalog && Date.now() - this.catalog.at < DISCOVERY_TTL_MS) return this.catalog.kinds
    const custom: ResourceKind[] = []
    try {
      const groups = await client.json<{
        groups: { name: string; preferredVersion: { groupVersion: string; version: string } }[]
      }>('GET', '/apis', { signal })
      const others = groups.groups.filter((g) => !isBuiltinGroup(g.name))
      await pool(others.slice(0, 200), 12, async (g) => {
        const list = await client
          .json<{
            resources: { name: string; kind: string; namespaced: boolean; verbs: string[] }[]
          }>('GET', `/apis/${g.preferredVersion.groupVersion}`, { signal })
          .catch(() => null)
        for (const r of list?.resources ?? []) {
          if (r.name.includes('/') || !r.verbs.includes('list')) continue
          custom.push({
            id: `${r.name}.${g.name}`,
            group: g.name,
            version: g.preferredVersion.version,
            plural: r.name,
            kind: r.kind,
            namespaced: r.namespaced,
            title: r.kind,
            section: 'Custom resources'
          })
        }
      })
    } catch (error) {
      this.deps.log(
        'warn',
        `discovery failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    for (const k of custom) this.kinds.set(k.id, k)
    // Loại có sẵn mà cluster không có (ValidatingAdmissionPolicy trước 1.30, HPA v2 trên cluster
    // rất cũ…) → ẩn khỏi điều hướng thay vì báo 404 khi bấm.
    const groupVersions = [
      ...new Set(
        BUILTIN_KINDS.map((k) => (k.group ? `/apis/${k.group}/${k.version}` : `/api/${k.version}`))
      )
    ]
    const served = new Map<string, Set<string> | null>()
    await pool(groupVersions, 12, async (gv) => {
      const list = await client
        .json<{ resources: { name: string }[] }>('GET', gv, { signal })
        .catch((error: unknown) =>
          error instanceof KubeError && error.status === 404 ? { resources: [] } : null
        )
      served.set(gv, list ? new Set(list.resources.map((r) => r.name)) : null)
    })
    const exists = (k: ResourceKind): boolean => {
      const set = served.get(k.group ? `/apis/${k.group}/${k.version}` : `/api/${k.version}`)
      // Không hỏi được → coi như có (lỗi thật báo khi list).
      return !set || set.has(k.plural)
    }
    const kinds = [
      ...BUILTIN_KINDS.filter(exists),
      ...custom.sort((a, b) => a.id.localeCompare(b.id))
    ]
    this.catalog = { at: Date.now(), kinds }
    return kinds
  }

  /**
   * Loại tài nguyên + quyền list trong namespace đang xem. Danh mục và quyền được nhớ 5 phút: đổi
   * namespace chỉ hỏi quyền những loại có namespace, mỗi loại một lần (cluster Rancher ~150 loại).
   */
  private async discover(
    client: KubeClient,
    namespace: string | undefined,
    signal: AbortSignal
  ): Promise<DiscoveredKind[]> {
    const all = await this.catalogOf(client, signal)
    const now = Date.now()
    const keyOf = (k: ResourceKind): string => `${k.id}|${k.namespaced ? (namespace ?? '') : ''}`
    const allowed = await pool(all, 16, async (k) => {
      const cached = this.access.get(keyOf(k))
      if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.allowed
      const ok = await client
        .json<{ status?: { allowed?: boolean } }>(
          'POST',
          '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
          {
            body: {
              apiVersion: 'authorization.k8s.io/v1',
              kind: 'SelfSubjectAccessReview',
              spec: {
                resourceAttributes: {
                  verb: 'list',
                  group: k.group,
                  resource: k.plural,
                  ...(k.namespaced && namespace ? { namespace } : {})
                }
              }
            },
            signal
          }
        )
        .then(
          (r) => r.status?.allowed !== false,
          // Không hỏi được quyền → cứ hiện (lỗi thật sẽ báo khi list); không nhớ.
          () => null
        )
      if (ok !== null) this.access.set(keyOf(k), { at: now, allowed: ok })
      return ok ?? true
    })
    return all.map((k, i) => ({
      id: k.id,
      group: k.group,
      version: k.version,
      plural: k.plural,
      kind: k.kind,
      namespaced: k.namespaced,
      forbidden: allowed[i] === false
    }))
  }

  /** Luồng dài chạy nền; trả id đăng ký ngay; kết thúc / lỗi → sự kiện `<kind>-end`. */
  private subscribe(
    kind: string,
    start: (id: string, signal: AbortSignal) => Promise<void>
  ): { subscription: string } {
    const id = randomUUID()
    const controller = new AbortController()
    this.subscriptions.set(id, () => {
      controller.abort()
    })
    void start(id, controller.signal)
      .then(
        () => {
          if (!controller.signal.aborted) this.deps.emit(`${kind}-end`, { subscription: id })
        },
        (error: unknown) => {
          if (controller.signal.aborted || this.disposed) return
          this.deps.emit(`${kind}-end`, {
            subscription: id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      )
      .finally(() => {
        this.subscriptions.delete(id)
      })
    return { subscription: id }
  }

  /**
   * Watch dùng chung theo (loại, namespace, selector) trong phiên (ADR-014 mục 7.6): tự nối lại khi
   * server đóng luồng; 410 Gone → báo renderer list lại. Sự kiện gửi theo lô ≤ 10 lần / giây.
   */
  private watch(
    kindId: string,
    namespace: string | undefined,
    selector: string | undefined,
    resourceVersion: string,
    fieldSelector?: string
  ): { subscription: string } {
    const kind = this.kind(kindId)
    const base = `${kindId}|${namespace ?? ''}|${selector ?? ''}|${fieldSelector ?? ''}`
    const id = randomUUID()
    const existing = this.watches.get(base)
    // Dùng chung chỉ khi watch đó bắt đầu từ cùng resourceVersion và chưa nhận sự kiện nào: người
    // đến sau list ở thời điểm khác — dùng chung sẽ mất (hoặc lặp) sự kiện giữa hai mốc.
    let w: SharedWatch
    if (existing && !existing.advanced && existing.startRv === resourceVersion) w = existing
    else {
      const key = existing ? `${base}#${id}` : base
      w = {
        key,
        startRv: resourceVersion,
        advanced: false,
        subscribers: new Set(),
        controller: new AbortController(),
        attempt: null,
        pending: [],
        timer: null
      }
      this.watches.set(key, w)
      this.startProbe()
      void this.runWatch(w, kind, namespace, selector, resourceVersion, fieldSelector).finally(
        () => {
          // Watch đã dừng (410 Gone…): bỏ khỏi danh sách — người đến sau không nhập vào watch chết.
          if (this.watches.get(w.key) === w) this.watches.delete(w.key)
          if (this.watches.size === 0) this.stopProbe()
        }
      )
    }
    w.subscribers.add(id)
    this.subscriptions.set(id, () => {
      w.subscribers.delete(id)
      if (w.subscribers.size === 0) {
        w.controller.abort()
        if (w.timer) clearTimeout(w.timer)
        if (this.watches.get(w.key) === w) this.watches.delete(w.key)
        if (this.watches.size === 0) this.stopProbe()
      }
    })
    return { subscription: id }
  }

  private startProbe(): void {
    if (this.probeTimer || this.disposed) return
    this.probeTimer = setInterval(() => {
      void this.checkLink()
    }, linkProbe.intervalMs)
    this.probeTimer.unref()
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
    this.link = { down: false, failures: 0 }
  }

  /**
   * Hỏi `/version` (mọi tài khoản đều đọc được). Chỉ lỗi mạng / hết giờ mới là "mất kết nối": API
   * server trả lỗi HTTP (kể cả 5xx) thì vẫn đang trả lời.
   */
  private async checkLink(): Promise<void> {
    const client = this.client
    if (!client || this.disposed || this.watches.size === 0) return
    let reachable = true
    // Hạn tổng cho cả bắt tay TLS (client thử lại tới 3 × 10 s, không nghe `signal` lúc đó) lẫn chờ
    // trả lời: hết hạn là "không trả lời" ngay, request còn dang dở tự bị huỷ.
    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort()
    }, linkProbe.timeoutMs)
    try {
      await Promise.race([
        client.json('GET', '/version', {
          idleMs: linkProbe.timeoutMs,
          signal: deadline.signal
        }),
        new Promise<never>((_, reject) => {
          deadline.signal.addEventListener('abort', () => {
            reject(new KubeTimeoutError('API server did not answer /version'))
          })
        })
      ])
    } catch (error) {
      reachable = error instanceof KubeError
    } finally {
      clearTimeout(timer)
    }
    // dispose() xoá hết watch trong lúc chờ → không báo gì nữa.
    if (this.watches.size === 0) return
    if (reachable) {
      const wasDown = this.link.down
      this.link = { down: false, failures: 0 }
      if (!wasDown) return
      // Mạng về: socket watch cũ có thể đã chết nửa chừng — buộc nối lại từ resourceVersion.
      for (const w of this.watches.values()) {
        this.flushWatch(w, { stale: false })
        w.attempt?.abort()
      }
      return
    }
    this.link.failures++
    if (this.link.down || this.link.failures < linkProbe.failures) return
    this.link.down = true
    for (const w of this.watches.values()) this.flushWatch(w, { stale: true })
  }

  private flushWatch(
    w: SharedWatch,
    extra?: { relist?: boolean; error?: string; stale?: boolean }
  ): void {
    if (w.timer) clearTimeout(w.timer)
    w.timer = null
    const events = w.pending
    w.pending = []
    if (events.length === 0 && !extra) return
    for (const subscription of w.subscribers)
      this.deps.emit('watch', { subscription, events, ...extra })
  }

  private async runWatch(
    w: SharedWatch,
    kind: ResourceKind,
    namespace: string | undefined,
    selector: string | undefined,
    startVersion: string,
    fieldSelector?: string
  ): Promise<void> {
    let rv = startVersion
    let failures = 0
    /** Đã báo lỗi cho renderer — khi nối lại thì list lại. */
    let lostEvents = false
    const client = this.require()
    const signal = w.controller.signal
    // Đọc qua hàm để TS không thu hẹp kiểu qua `await`.
    const aborted = (): boolean => signal.aborted
    while (!aborted() && !this.disposed) {
      let pending = ''
      let gone = false
      // Object (không phải let): được gán trong callback, TS không theo dõi được.
      const seen = { data: false }
      const started = Date.now()
      // Mỗi lần kết nối có controller riêng: dò kết nối huỷ được nó (nối lại) mà không dừng watch.
      const attempt = new AbortController()
      const forced = { value: false }
      const onStop = (): void => {
        attempt.abort()
      }
      signal.addEventListener('abort', onStop, { once: true })
      attempt.signal.addEventListener(
        'abort',
        () => {
          forced.value = !signal.aborted
        },
        { once: true }
      )
      w.attempt = attempt
      try {
        await client.stream(
          'GET',
          resourcePath(kind, namespace),
          {
            query: {
              watch: true,
              resourceVersion: rv,
              allowWatchBookmarks: true,
              labelSelector: selector || undefined,
              fieldSelector: fieldSelector || undefined,
              timeoutSeconds: 300
            },
            // Kết nối chết im lặng (NAT / bastion rớt) không bao giờ báo đóng → quá 6 phút không có
            // byte nào (server tự đóng sau 5 phút) thì bỏ và nối lại từ resourceVersion.
            idleMs: watchIdle.ms,
            signal: attempt.signal
          },
          (chunk) => {
            if (lostEvents) {
              // Nối lại được sau khi đã báo lỗi: renderer list lại (dữ liệu mới + xoá thông báo lỗi)
              // rồi đăng ký watch mới — luồng này sẽ bị huỷ khi nó bỏ đăng ký.
              lostEvents = false
              failures = 0
              this.flushWatch(w, { relist: true })
            }
            seen.data = true
            pending += chunk.toString('utf8')
            let nl = pending.indexOf('\n')
            while (nl >= 0) {
              const line = pending.slice(0, nl).trim()
              pending = pending.slice(nl + 1)
              nl = pending.indexOf('\n')
              if (!line) continue
              let e: { type: string; object: K8sObject & { code?: number } }
              try {
                e = JSON.parse(line) as typeof e
              } catch {
                continue
              }
              if (e.type === 'ERROR') {
                if (e.object.code === 410) gone = true
                continue
              }
              if (e.object.metadata.resourceVersion) rv = e.object.metadata.resourceVersion
              w.advanced = true
              if (e.type === 'BOOKMARK') continue
              if (e.type !== 'ADDED' && e.type !== 'MODIFIED' && e.type !== 'DELETED') continue
              const obj = kind.id === 'secrets' ? hideSecretValues(slim(e.object)) : slim(e.object)
              w.pending.push({ type: e.type, object: obj })
              w.timer ??= setTimeout(() => {
                this.flushWatch(w)
              }, WATCH_FLUSH_MS)
            }
          }
        )
        failures = 0
      } catch (error) {
        if (aborted()) return
        if (error instanceof KubeError && error.status === 410) gone = true
        else if (
          forced.value ||
          error instanceof KubeTimeoutError ||
          (!(error instanceof KubeError) && (seen.data || Date.now() - started > 10_000))
        ) {
          // Proxy / load balancer (Rancher, ingress, NAT…) cắt luồng watch đang chạy ("aborted",
          // ECONNRESET), hoặc hết giờ chờ (kết nối chết im lặng): như server đóng luồng — nối lại
          // ngay từ resourceVersion, không phải lỗi.
          failures = 0
        } else {
          failures++
          this.deps.log(
            'warn',
            `watch ${kind.id}: ${error instanceof Error ? error.message : String(error)}`
          )
          // Báo lỗi một lần (bảng giữ dữ liệu cũ), vẫn thử lại chậm dần tới khi nối được.
          if (failures === 5)
            this.flushWatch(w, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      signal.removeEventListener('abort', onStop)
      if (failures >= 5) lostEvents = true
      if (gone) {
        // Phiên bản quá cũ — renderer list lại rồi đăng ký watch mới.
        this.flushWatch(w, { relist: true })
        return
      }
      this.flushWatch(w)
      // Server đóng luồng (timeoutSeconds) → nối lại ngay; lỗi mạng → chờ tăng dần.
      if (failures > 0)
        await new Promise((r) =>
          setTimeout(r, Math.min(watchRetry.maxMs, watchRetry.baseMs * 2 ** Math.min(failures, 16)))
        )
    }
  }

  /**
   * Replace (PUT) có kiểm resourceVersion — ai đó đã sửa trước → báo, không ghi đè. Secret: khoá bị
   * ẩn (đánh dấu trong YAML) còn rỗng giữ nguyên giá trị trên cluster (xem keepHiddenSecretValues).
   */
  private async apply(client: KubeClient, text: string, signal?: AbortSignal): Promise<K8sObject> {
    // Kiểm lại ở đây: lưu từ editor (edit) chạy ngoài run() — bật chỉ đọc giữa chừng cũng chặn.
    if (this.locked)
      throw new Error(t('Read-only mode is on for this context — turn it off to make changes'))
    const o = parseYaml(text) as K8sObject | null
    const meta = (o as { metadata?: K8sObject['metadata'] } | null)?.metadata
    if (!o || typeof o !== 'object' || !meta?.name || !o.kind || !o.apiVersion)
      throw new Error('The YAML needs apiVersion, kind and metadata.name')
    const kind = [...this.kinds.values()].find(
      (k) => k.kind === o.kind && (k.group ? `${k.group}/${k.version}` : k.version) === o.apiVersion
    )
    if (!kind) throw new Error(`Unknown kind ${o.kind} (${o.apiVersion})`)
    if (!o.metadata.resourceVersion)
      throw new Error(t('metadata.resourceVersion is missing — reload the object before saving'))
    await keepHiddenSecretValues(client, kind, o.metadata.namespace, o, signal)
    try {
      return await client.json<K8sObject>(
        'PUT',
        resourcePath(kind, o.metadata.namespace, o.metadata.name),
        { body: o, ...(signal ? { signal } : {}) }
      )
    } catch (error) {
      if (error instanceof KubeError && error.status === 409)
        throw new Error(
          t(
            'Someone changed this object since you opened it. Reload it and apply your change again.'
          ),
          { cause: error }
        )
      throw error
    }
  }

  /**
   * Sửa YAML bằng editor trên máy: ghi ra file tạm (main cấp đường dẫn — chỉ nhận đúng file đó),
   * theo dõi; mỗi lần lưu → replace. Lưu nối tiếp dùng resourceVersion mới nhất của chính mình;
   * người khác sửa → 409 → báo. Lâu không lưu thì hỏi file thưa dần; 8 giờ không đổi / file bị xoá
   * → thôi theo dõi.
   */
  private async edit(
    client: KubeClient,
    kind: ResourceKind,
    namespace: string | undefined,
    name: string,
    localPath: string,
    signal?: AbortSignal
  ): Promise<null> {
    if (kind.id === 'secrets')
      throw new Error('Secrets cannot be edited in an editor (values would be written to disk)')
    if (!(await this.deps.checkEditFile?.(localPath)))
      throw new Error('This file cannot be used for editing')
    await assertEditTarget(localPath)
    const o = slim(
      await client.json<K8sObject>(
        'GET',
        resourcePath(kind, namespace, name),
        signal ? { signal } : {}
      )
    )
    const writtenRv = o.metadata.resourceVersion ?? ''
    let currentRv = writtenRv
    let last = toYaml(o)
    await writeNoFollow(localPath, last)
    this.edits.get(localPath)?.stop()
    // Giới hạn số file đang theo dõi: bỏ file cũ nhất.
    while (this.edits.size >= MAX_EDITS) {
      const [oldest] = this.edits.keys()
      if (oldest === undefined) break
      this.edits.get(oldest)?.stop()
    }
    let busy = false
    let changedAt = Date.now()
    let timer: NodeJS.Timeout | null = null
    let stopped = false
    const stop = (): void => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (this.edits.get(localPath)?.stop === stop) this.edits.delete(localPath)
    }
    const schedule = (): void => {
      if (stopped || this.disposed) return
      const idle = Date.now() - changedAt
      if (idle > EDIT_STOP_AFTER_MS) {
        this.deps.log('info', `stopped watching ${localPath} (no changes for a long time)`)
        stop()
        return
      }
      timer = setTimeout(check, idle > EDIT_SLOW_AFTER_MS ? EDIT_SLOW_POLL_MS : EDIT_POLL_MS)
    }
    // Hỏi nội dung file định kỳ (YAML nhỏ): không phụ thuộc mtime / sự kiện theo dõi file của
    // từng hệ điều hành (lưu hai lần trong cùng một giây, editor ghi file tạm rồi đổi tên…).
    const check = (): void => {
      if (busy || stopped) return
      busy = true
      void (async () => {
        try {
          let text: string
          try {
            text = await readFile(localPath, 'utf8')
          } catch (error) {
            // File tạm bị dọn (đóng app / main xoá) → thôi theo dõi.
            if ((error as { code?: string }).code === 'ENOENT') stop()
            return
          }
          if (text === last) return
          last = text
          changedAt = Date.now()
          const edited = parseYaml(text) as K8sObject
          // Người dùng không tự sửa resourceVersion → dùng bản mới nhất mình vừa ghi.
          if (edited.metadata.resourceVersion === writtenRv)
            edited.metadata.resourceVersion = currentRv
          const saved = await this.apply(client, toYaml(edited))
          currentRv = saved.metadata.resourceVersion ?? currentRv
          this.deps.emit('edit', { path: localPath, name, ok: true })
        } catch (error) {
          this.deps.emit('edit', {
            path: localPath,
            name,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          busy = false
          schedule()
        }
      })()
    }
    this.edits.set(localPath, { name, stop })
    schedule()
    return null
  }

  private async resolveTarget(
    client: KubeClient,
    namespace: string,
    target: string,
    port: number,
    signal?: AbortSignal
  ): Promise<{ pod: string; port: number }> {
    const [type, name] = target.split('/') as [string, string]
    if (type === 'pod') return { pod: name, port }
    const opts = signal ? { signal } : {}
    const svc = await client.json<{
      spec: {
        selector?: Record<string, string>
        ports?: { port: number; targetPort?: number | string }[]
      }
    }>(
      'GET',
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
      opts
    )
    const selector = Object.entries(svc.spec.selector ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    if (!selector) throw new Error(`The service ${name} has no pod selector`)
    const pods = await client.json<{
      items: (K8sObject & {
        spec: { containers?: { ports?: { name?: string; containerPort: number }[] }[] }
      })[]
    }>('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
      query: { labelSelector: selector, fieldSelector: 'status.phase=Running' },
      ...opts
    })
    const pod = pods.items[0]
    if (!pod) throw new Error(`No running pod behind the service ${name}`)
    const svcPort = svc.spec.ports?.find((p) => p.port === port)
    let targetPort: number = port
    if (typeof svcPort?.targetPort === 'number') targetPort = svcPort.targetPort
    else if (typeof svcPort?.targetPort === 'string') {
      const named = svcPort.targetPort
      const found = pod.spec.containers?.flatMap((c) => c.ports ?? []).find((p) => p.name === named)
      if (!found) throw new Error(`The pod has no port named ${named}`)
      targetPort = found.containerPort
    }
    return { pod: pod.metadata.name, port: targetPort }
  }

  /**
   * Port-forward: cổng trên máy (127.0.0.1) → WebSocket portforward tới pod (mỗi kết nối một WS).
   * Kết nối hỏng (pod bị thay khi rollout / khởi động lại) → tìm lại pod đích rồi thử lần nữa, nên
   * forward tới service tự "nối lại" mà không phải tạo lại.
   */
  private async portForward(
    client: KubeClient,
    namespace: string,
    target: string,
    ports: [number, number][],
    signal?: AbortSignal
  ): Promise<PortForwardInfo[]> {
    const out: PortForwardInfo[] = []
    for (const [local, remote] of ports) {
      const resolved = await this.resolveTarget(client, namespace, target, remote, signal)
      const id = randomUUID()
      const f: Forward = {
        info: {
          id,
          namespace,
          target,
          localPort: local,
          remotePort: remote,
          connections: 0,
          error: null,
          state: 'active',
          pod: resolved.pod,
          latencyMs: null,
          reconnects: 0
        },
        server: null,
        sockets: new Set(),
        client,
        resolved
      }
      await this.listenForward(f)
      this.forwards.set(id, f)
      out.push(f.info)
    }
    this.emitForwards()
    return out
  }

  /** Mở (lại) cổng trên máy của forward — bật lại dùng đúng cổng cũ. */
  private async listenForward(f: Forward): Promise<void> {
    if (f.server) return
    const server = createServer((socket) => {
      f.sockets.add(socket)
      f.info.connections++
      this.emitForwards()
      socket.on('close', () => {
        f.sockets.delete(socket)
        f.info.connections--
        this.emitForwards()
      })
      void this.connectForward(f, socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(f.info.localPort, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address && typeof address === 'object') f.info.localPort = address.port
    f.server = server
    f.info.state = f.info.error ? 'error' : 'active'
    this.emitForwards()
  }

  private pauseForward(f: Forward): void {
    f.server?.close()
    f.server = null
    for (const s of f.sockets) s.destroy()
    f.info.state = 'paused'
    this.emitForwards()
  }

  /** Một kết nối tới cổng trên máy: nối tới pod hiện tại; hỏng → tìm lại pod, thử lần nữa. */
  private async connectForward(f: Forward, socket: Socket): Promise<void> {
    const { info } = f
    try {
      await this.pipeForward(f, socket)
    } catch {
      if (socket.destroyed) return
      try {
        const next = await this.resolveTarget(
          f.client,
          info.namespace,
          info.target,
          info.remotePort
        )
        const moved = next.pod !== f.resolved.pod
        f.resolved = next
        info.pod = next.pod
        await this.pipeForward(f, socket)
        if (moved) info.reconnects++
      } catch (error) {
        info.error = error instanceof Error ? error.message : String(error)
        info.state = 'error'
        this.emitForwards()
        socket.destroy()
        return
      }
    }
    if (info.error || info.state === 'error') {
      info.error = null
      info.state = 'active'
    }
    this.emitForwards()
  }

  /** Mở kênh portforward tới pod hiện tại của forward và nối với socket (đo thời gian mở kênh). */
  private async pipeForward(f: Forward, socket: Socket): Promise<void> {
    socket.pause()
    const { pod, port } = f.resolved
    const started = performance.now()
    const ws: WebSocket = await f.client.websocket(
      `/api/v1/namespaces/${encodeURIComponent(f.info.namespace)}/pods/${encodeURIComponent(pod)}/portforward`,
      { ports: String(port) },
      ['v4.channel.k8s.io']
    )
    f.info.latencyMs = Math.round(performance.now() - started)
    if (socket.destroyed) {
      ws.close()
      return
    }
    const seen = new Set<number>()
    let wsPaused = false
    ws.on('message', (data: Buffer) => {
      if (data.length === 0) return
      const channel = data[0] ?? 0
      let payload = data.subarray(1)
      // Khung đầu tiên của mỗi kênh mang số cổng (2 byte) — bỏ qua.
      if (!seen.has(channel)) {
        seen.add(channel)
        payload = payload.subarray(2)
      }
      if (payload.length === 0) return
      if (channel === 0) {
        // Ứng dụng trên máy đọc chậm (tải file lớn…) → dừng đọc từ pod tới khi socket rút bớt,
        // không dồn cả luồng vào bộ nhớ.
        if (!socket.write(payload) && !wsPaused) {
          wsPaused = true
          ws.pause()
          socket.once('drain', () => {
            wsPaused = false
            ws.resume()
          })
        }
      } else if (channel === 1) {
        this.deps.log('warn', `port-forward: ${payload.toString('utf8')}`)
        socket.destroy()
      }
    })
    ws.on('close', () => socket.destroy())
    ws.on('error', () => socket.destroy())
    let paused = false
    socket.on('data', (chunk: Buffer) => {
      ws.send(Buffer.concat([Buffer.from([0]), chunk]), () => {
        // Đã gửi xong phần đệm → đọc tiếp từ ứng dụng trên máy.
        if (paused && ws.bufferedAmount < FORWARD_HIGH_WATER / 2) {
          paused = false
          socket.resume()
        }
      })
      // Mạng tới pod (qua bastion) chậm hơn ứng dụng gửi → dừng đọc socket.
      if (ws.bufferedAmount > FORWARD_HIGH_WATER && !paused) {
        paused = true
        socket.pause()
      }
    })
    socket.on('close', () => {
      ws.close()
    })
    socket.resume()
  }

  private emitForwards(): void {
    this.deps.emit(
      'forwards',
      [...this.forwards.values()].map((f) => f.info)
    )
  }

  private async historyProbe(client: KubeClient, signal?: AbortSignal): Promise<HistoryProbe> {
    if (this.probe && Date.now() - this.probe.at < PROM_RETRY_MS) return this.probe.value
    const value = await probeHistory(client, await this.prometheus(client, signal), signal)
    this.probe = { value, at: Date.now() }
    return value
  }

  private async prometheus(client: KubeClient, signal?: AbortSignal): Promise<PromTarget | null> {
    if (this.prom && Date.now() - this.prom.at < (this.prom.target ? PROM_TTL_MS : PROM_RETRY_MS))
      return this.prom.target
    const target = await findPrometheus(client, signal)
    this.prom = { target, at: Date.now() }
    return target
  }

  private stopForward(f: Forward): void {
    f.server?.close()
    for (const s of f.sockets) s.destroy()
    this.forwards.delete(f.info.id)
    this.emitForwards()
  }

  /** Shell vào pod: exec qua WebSocket (kênh v4), TTY đổi kích thước theo terminal. */
  async openTerminal(raw: unknown, size: TerminalSize, cb: TransportCallbacks): Promise<Transport> {
    const params = K8sTerminalParams.parse(raw)
    const client = this.client ?? (await this.connect(params.ref))
    // Shell vào pod làm được mọi thứ → chặn ở chế độ chỉ đọc (như thao tác thay đổi).
    if (this.locked)
      throw new Error(t('Read-only mode is on for this context — turn it off to open a shell'))
    const pod = `/api/v1/namespaces/${encodeURIComponent(params.namespace)}/pods/${encodeURIComponent(params.pod)}`
    // Container debug (stdin + TTY): gắn vào tiến trình chính như `kubectl debug -it` / `attach`.
    const ws = params.attach
      ? await client.websocket(
          `${pod}/attach`,
          { container: params.container, stdin: true, stdout: true, stderr: true, tty: true },
          ['v4.channel.k8s.io']
        )
      : await client.websocket(
          `${pod}/exec`,
          {
            command: params.command?.length ? params.command : DEFAULT_POD_SHELL,
            container: params.container,
            stdin: true,
            stdout: true,
            stderr: true,
            tty: true
          },
          ['v4.channel.k8s.io']
        )
    if (params.banner)
      cb.onData(Buffer.from(`\x1b[2m${params.banner.replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`))
    const transport = new PodExecTransport(ws, size, cb)
    // Attach không in lại dấu nhắc đã có → gửi Enter để shell hiện dấu nhắc.
    if (params.attach) transport.write('\r')
    return transport
  }

  private startRecorder(client: KubeClient): void {
    const cluster = this.refKey
    const deps = this.deps
    if (this.recorder || !cluster || !deps.recordEvents) return
    const controller = new AbortController()
    this.recorder = controller
    void recordEvents(
      client,
      (events) => deps.recordEvents?.(cluster, events) ?? Promise.resolve(),
      controller.signal
    )
      .catch((error: unknown) => {
        this.deps.log(
          'warn',
          `event recorder stopped: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (this.recorder === controller) this.recorder = null
      })
  }

  private stopRecorder(): void {
    this.recorder?.abort()
    this.recorder = null
  }

  dispose(): void {
    this.disposed = true
    this.stopProbe()
    this.stopRecorder()
    disposeTrafficCache(this.trafficCache)
    for (const stop of this.subscriptions.values()) stop()
    this.subscriptions.clear()
    for (const w of this.watches.values()) w.controller.abort()
    this.watches.clear()
    for (const f of [...this.forwards.values()]) this.stopForward(f)
    for (const e of [...this.edits.values()]) e.stop()
    this.edits.clear()
    this.client?.close()
  }
}

/** Transport terminal trên kênh exec của Kubernetes (0 stdin, 1 stdout, 2 stderr, 3 lỗi, 4 resize). */
export class PodExecTransport implements Transport {
  private exited = false
  private code: number | null = null

  constructor(
    private readonly ws: WebSocket,
    size: TerminalSize,
    cb: TransportCallbacks
  ) {
    ws.on('message', (data: Buffer) => {
      const channel = data[0]
      const payload = data.subarray(1)
      if (channel === 1 || channel === 2) cb.onData(payload)
      else if (channel === 3) {
        try {
          const status = JSON.parse(payload.toString('utf8')) as {
            status?: string
            details?: { causes?: { reason?: string; message?: string }[] }
          }
          if (status.status === 'Success') this.code = 0
          else {
            const exit = status.details?.causes?.find((c) => c.reason === 'ExitCode')?.message
            this.code = exit ? Number(exit) : 1
          }
        } catch {
          this.code = 1
        }
      }
    })
    ws.on('close', () => {
      if (this.exited) return
      this.exited = true
      cb.onExit({ code: this.code, signal: null })
    })
    ws.on('error', (error) => {
      if (this.exited) return
      this.exited = true
      cb.onExit({ code: null, signal: null, error: error.message })
    })
    this.resize(size.cols, size.rows)
  }

  write(data: string): void {
    if (!this.exited) this.ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(data, 'utf8')]))
  }

  resize(cols: number, rows: number): void {
    if (!this.exited)
      this.ws.send(
        Buffer.concat([
          Buffer.from([4]),
          Buffer.from(JSON.stringify({ Width: cols, Height: rows }))
        ])
      )
  }

  pause(): void {
    this.ws.pause()
  }

  resume(): void {
    this.ws.resume()
  }

  close(): void {
    if (!this.exited) this.ws.close()
  }
}
