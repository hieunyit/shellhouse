import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * API server Kubernetes giả (ADR-014 mục 7.7 — thay cho kind trên máy / CI không có Docker).
 * Chứng chỉ trong fixtures/ chỉ dùng cho test (CA tự ký, không dùng ở đâu khác).
 */

const FIXTURES = join(__dirname, 'fixtures')
export const TEST_CA = readFileSync(join(FIXTURES, 'ca.crt'), 'utf8')
export const TOKEN = 'test-token'

interface Obj {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    uid: string
    resourceVersion: string
    creationTimestamp: string
    labels?: Record<string, string>
  }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
  data?: Record<string, string>
  type?: string
  [k: string]: unknown
}

export interface ApiTestServer {
  url: string
  port: number
  requests: string[]
  /** Thêm / sửa / xoá đối tượng → gửi sự kiện tới các watch đang mở. */
  upsert(
    plural: string,
    obj: Omit<Obj, 'metadata'> & { metadata: Partial<Obj['metadata']> & { name: string } }
  ): Obj
  remove(plural: string, namespace: string | undefined, name: string): void
  /** Giả cluster không có metrics-server. */
  disableMetrics(): void
  /**
   * Cài Caretta giả: một pod agent (DaemonSet) xuất `caretta_links_observed` tăng theo thời gian.
   * forbidden = có agent nhưng không được đọc metric (pods/proxy). realistic = thêm cluster giống
   * thật cho service map (console-stg gọi qua lại, ingress-nginx, kube-system, monitoring, hàng chục
   * địa chỉ ngoài cluster, vài kết nối idle). idle = counter đứng yên (mọi kết nối idle).
   */
  enableCaretta(options?: { forbidden?: boolean; realistic?: boolean; idle?: boolean }): void
  /** Cài Prometheus giả (monitoring/prometheus-operated:9090) trả lời query / query_range. */
  enablePrometheus(): void
  /**
   * Cluster mẫu giống thật cho ảnh chụp (Topology / Map): nhiều namespace, Ingress nhiều host / path /
   * TLS, Service đủ loại (ClusterIP, headless, NodePort, LoadBalancer, ExternalName, không endpoint),
   * Deployment / StatefulSet / DaemonSet / Job khoẻ / suy giảm / hỏng, HPA, NetworkPolicy, PVC,
   * ConfigMap / Secret, EndpointSlice; có cả lỗi cấu hình (Service đích không có, thiếu Secret TLS…).
   */
  seedDemo(): void
  get(plural: string, namespace: string | undefined, name: string): Obj | undefined
  list(plural: string): Obj[]
  /** Làm các watch sau nhận 410 Gone. */
  expireWatches(): void
  /** Ngắt các watch đang mở; `n` lần watch tiếp theo trả 503 (mạng / API server chập chờn). */
  failWatches(n: number): void
  /** Cắt ngang các watch đang chạy (proxy Rancher / load balancer đóng kết nối giữa chừng). */
  cutWatches(): void
  /** Cắt ngang các luồng log đang follow. */
  cutLogs(): void
  /** Số kết nối TCP đã nhận (đo keep-alive). */
  connections(): number
  /** Request tới đường dẫn khớp → không bao giờ trả lời (API server / proxy treo). */
  stall(path: RegExp | null): void
  /** `n` lần evict tiếp theo bị PodDisruptionBudget chặn (429). */
  blockEvictions(n: number): void
  /** Header Accept của các request (kiểm list chỉ metadata). */
  accepts: string[]
  close(): Promise<void>
}

let rv = 100
const nextRv = (): string => String(++rv)

function make(
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string | undefined,
  extra: Partial<Obj> = {}
): Obj {
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      ...(namespace ? { namespace } : {}),
      uid: `${kind}-${name}`,
      resourceVersion: nextRv(),
      creationTimestamp: new Date(Date.now() - 3_600_000).toISOString(),
      managedFields: [{ manager: 'kubectl' }]
    } as Obj['metadata'],
    ...extra
  }
}

const POD_SPEC = {
  containers: [
    { name: 'app', image: 'nginx:1.27', ports: [{ containerPort: 8080, name: 'http' }] }
  ],
  nodeName: 'node-1'
}
const RUNNING = {
  phase: 'Running',
  containerStatuses: [{ name: 'app', ready: true, restartCount: 2, state: { running: {} } }]
}

export async function startApiTestServer(options: { tls?: boolean } = {}): Promise<ApiTestServer> {
  const store = new Map<string, Map<string, Obj>>([
    [
      'namespaces',
      new Map(
        ['default', 'shop', 'restricted'].map((n) => {
          const ns = make('v1', 'Namespace', n, undefined, { status: { phase: 'Active' } })
          // Nhãn team (bản đồ: gom vùng theo nhãn); kubernetes.io/* là nhãn hệ thống, bỏ qua.
          ns.metadata.labels = {
            'kubernetes.io/metadata.name': n,
            ...(n === 'restricted' ? {} : { team: n === 'shop' ? 'commerce' : 'platform' })
          }
          return [n, ns]
        })
      )
    ],
    [
      'pods',
      new Map([
        ['shop/web-1', make('v1', 'Pod', 'web-1', 'shop', { spec: POD_SPEC, status: RUNNING })],
        [
          'shop/web-2',
          make('v1', 'Pod', 'web-2', 'shop', {
            spec: POD_SPEC,
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  ready: false,
                  restartCount: 7,
                  state: { waiting: { reason: 'CrashLoopBackOff' } }
                }
              ]
            }
          })
        ],
        ['default/tool', make('v1', 'Pod', 'tool', 'default', { spec: POD_SPEC, status: RUNNING })]
      ])
    ],
    [
      'deployments',
      new Map([
        [
          'shop/web',
          make('apps/v1', 'Deployment', 'web', 'shop', {
            spec: {
              replicas: 2,
              selector: { matchLabels: { app: 'web' } },
              template: {
                metadata: { labels: { app: 'web' } },
                spec: {
                  serviceAccountName: 'web-sa',
                  containers: [
                    {
                      name: 'app',
                      image: 'nginx:1.27',
                      envFrom: [{ configMapRef: { name: 'web-config' } }]
                    }
                  ]
                }
              }
            },
            status: { readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1 }
          })
        ]
      ])
    ],
    [
      'services',
      new Map([
        [
          'shop/web',
          make('v1', 'Service', 'web', 'shop', {
            spec: {
              type: 'ClusterIP',
              clusterIP: '10.0.0.10',
              selector: { app: 'web' },
              ports: [{ port: 80, targetPort: 'http', protocol: 'TCP' }]
            }
          })
        ]
      ])
    ],
    [
      'secrets',
      new Map([
        [
          'shop/db',
          make('v1', 'Secret', 'db', 'shop', {
            type: 'Opaque',
            data: {
              password: Buffer.from('s3cr3t').toString('base64'),
              user: Buffer.from('app').toString('base64')
            }
          })
        ]
      ])
    ],
    [
      'events',
      new Map([
        [
          'shop/ev1',
          make('v1', 'Event', 'ev1', 'shop', {
            type: 'Warning',
            reason: 'BackOff',
            message: 'Back-off restarting failed container',
            involvedObject: { kind: 'Pod', name: 'web-2', namespace: 'shop' },
            lastTimestamp: new Date().toISOString()
          })
        ]
      ])
    ],
    ['widgets', new Map([['shop/w1', make('example.com/v1', 'Widget', 'w1', 'shop')]])],
    [
      'replicasets',
      new Map(
        [1, 2].map((rev) => [
          `shop/web-rs${rev}`,
          make('apps/v1', 'ReplicaSet', `web-rs${rev}`, 'shop', {
            spec: {
              replicas: rev === 2 ? 2 : 0,
              template: {
                metadata: { labels: { app: 'web', 'pod-template-hash': `h${rev}` } },
                spec: {
                  containers: [{ name: 'app', image: rev === 1 ? 'nginx:1.26' : 'nginx:1.27' }]
                }
              }
            },
            status: { replicas: rev === 2 ? 2 : 0 }
          })
        ])
      )
    ],
    [
      'nodes',
      new Map(
        ['node-1', 'node-2'].map((n, i) => [
          n,
          make('v1', 'Node', n, undefined, {
            spec: {},
            status: {
              conditions: [{ type: 'Ready', status: i === 0 ? 'True' : 'False' }],
              allocatable: { cpu: '4', memory: '8Gi' },
              nodeInfo: { kubeletVersion: 'v1.31.2' }
            }
          })
        ])
      )
    ],
    [
      'cronjobs',
      new Map([
        [
          'shop/nightly',
          make('batch/v1', 'CronJob', 'nightly', 'shop', {
            spec: {
              schedule: '0 2 * * *',
              suspend: false,
              jobTemplate: {
                metadata: { labels: { job: 'nightly' } },
                spec: { template: { spec: { containers: [{ name: 'job', image: 'busybox' }] } } }
              }
            }
          })
        ]
      ])
    ],
    ['jobs', new Map()],
    [
      'configmaps',
      new Map([
        [
          'shop/web-config',
          make('v1', 'ConfigMap', 'web-config', 'shop', { data: { MODE: 'prod' } })
        ]
      ])
    ],
    ['persistentvolumeclaims', new Map()],
    ['persistentvolumes', new Map()],
    ['serviceaccounts', new Map([['shop/web-sa', make('v1', 'ServiceAccount', 'web-sa', 'shop')]])],
    // RBAC: web-sa đọc được Secret trong shop (quyền nhạy cảm — tab Security / Topology).
    [
      'roles',
      new Map([
        [
          'shop/secret-reader',
          make('rbac.authorization.k8s.io/v1', 'Role', 'secret-reader', 'shop', {
            rules: [
              { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list'] },
              { apiGroups: [''], resources: ['configmaps'], verbs: ['get'] }
            ]
          })
        ]
      ])
    ],
    [
      'rolebindings',
      new Map([
        [
          'shop/web-reader',
          make('rbac.authorization.k8s.io/v1', 'RoleBinding', 'web-reader', 'shop', {
            subjects: [{ kind: 'ServiceAccount', name: 'web-sa', namespace: 'shop' }],
            roleRef: {
              apiGroup: 'rbac.authorization.k8s.io',
              kind: 'Role',
              name: 'secret-reader'
            }
          })
        ]
      ])
    ],
    ['clusterroles', new Map()],
    ['clusterrolebindings', new Map()],
    [
      'networkpolicies',
      new Map([
        [
          'shop/default-deny',
          make('networking.k8s.io/v1', 'NetworkPolicy', 'default-deny', 'shop', {
            spec: { podSelector: {}, policyTypes: ['Ingress'] }
          })
        ]
      ])
    ],
    [
      'gateways',
      new Map([
        [
          'shop/public',
          make('gateway.networking.k8s.io/v1', 'Gateway', 'public', 'shop', {
            spec: {
              gatewayClassName: 'nginx',
              listeners: [{ name: 'http', protocol: 'HTTP', port: 80 }]
            }
          })
        ]
      ])
    ],
    [
      'httproutes',
      new Map([
        [
          'shop/web',
          make('gateway.networking.k8s.io/v1', 'HTTPRoute', 'web', 'shop', {
            spec: {
              parentRefs: [{ name: 'public' }],
              hostnames: ['shop.example.com'],
              rules: [{ backendRefs: [{ name: 'web', port: 80 }] }]
            }
          })
        ]
      ])
    ],
    ['ingresses', new Map()],
    ['horizontalpodautoscalers', new Map()],
    ['poddisruptionbudgets', new Map()],
    ['applications', new Map()]
  ])
  for (const rs of store.get('replicasets')?.values() ?? []) {
    rs.metadata.labels = { app: 'web' }
    ;(
      rs.metadata as Obj['metadata'] & {
        annotations?: Record<string, string>
        ownerReferences?: unknown[]
      }
    ).annotations = {
      'deployment.kubernetes.io/revision': rs.metadata.name.endsWith('1') ? '1' : '2'
    }
    ;(rs.metadata as Obj['metadata'] & { ownerReferences?: unknown[] }).ownerReferences = [
      { kind: 'Deployment', name: 'web' }
    ]
  }
  const web = store.get('deployments')?.get('shop/web')
  if (web)
    (web.metadata as Obj['metadata'] & { annotations?: Record<string, string> }).annotations = {
      'deployment.kubernetes.io/revision': '2'
    }
  // Pod chạy trên node-1 (drain), có requests (tổng quan).
  for (const pod of store.get('pods')?.values() ?? []) {
    pod.spec = {
      ...pod.spec,
      nodeName: 'node-1',
      containers: [
        {
          name: 'app',
          image: 'nginx:1.27',
          ports: [{ containerPort: 8080, name: 'http' }],
          resources: { requests: { cpu: '250m', memory: '128Mi' } }
        }
      ]
    }
  }
  // Pod cần nhãn để service tìm thấy; pod web-* thuộc ReplicaSet mới nhất của deployment web.
  for (const p of store.get('pods')?.values() ?? []) {
    p.metadata.labels = { app: p.metadata.name.startsWith('web') ? 'web' : 'tool' }
    if (p.metadata.name.startsWith('web'))
      (p.metadata as Obj['metadata'] & { ownerReferences?: unknown[] }).ownerReferences = [
        { kind: 'ReplicaSet', name: 'web-rs2', controller: true }
      ]
  }
  const requests: string[] = []
  const accepts: string[] = []
  let stalled: RegExp | null = null
  let blockedEvictions = 0
  let failingWatches = 0
  const logStreams = new Set<ServerResponse>()
  const watchers = new Set<{ plural: string; namespace: string | undefined; res: ServerResponse }>()
  let expired = false
  let metricsDisabled = false
  let caretta: { forbidden: boolean; start: number; idle: boolean } | null = null
  let prometheus = false
  /** Kết nối giả (byte / giây): Internet → Service web; web → pod tool; web → DB bên ngoài. */
  const CARETTA_LINKS: { labels: string; rate: number; base?: number }[] = [
    {
      labels:
        'client_kind="external",client_name="203.0.113.7",client_namespace="",server_kind="Service",server_name="web",server_namespace="shop",server_port="80"',
      rate: 51_200
    },
    {
      labels:
        'client_kind="Deployment",client_name="web",client_namespace="shop",server_kind="Pod",server_name="tool",server_namespace="default",server_port="8080"',
      rate: 307_200
    },
    {
      labels:
        'client_kind="Deployment",client_name="web",client_namespace="shop",server_kind="external",server_name="db.example.com",server_namespace="",server_port="5432"',
      rate: 2_097_152
    }
  ]

  const kindOf: Record<string, { apiVersion: string; kind: string; namespaced: boolean }> = {
    namespaces: { apiVersion: 'v1', kind: 'Namespace', namespaced: false },
    pods: { apiVersion: 'v1', kind: 'Pod', namespaced: true },
    services: { apiVersion: 'v1', kind: 'Service', namespaced: true },
    secrets: { apiVersion: 'v1', kind: 'Secret', namespaced: true },
    events: { apiVersion: 'v1', kind: 'Event', namespaced: true },
    deployments: { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
    replicasets: { apiVersion: 'apps/v1', kind: 'ReplicaSet', namespaced: true },
    nodes: { apiVersion: 'v1', kind: 'Node', namespaced: false },
    cronjobs: { apiVersion: 'batch/v1', kind: 'CronJob', namespaced: true },
    jobs: { apiVersion: 'batch/v1', kind: 'Job', namespaced: true },
    configmaps: { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
    persistentvolumeclaims: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', namespaced: true },
    serviceaccounts: { apiVersion: 'v1', kind: 'ServiceAccount', namespaced: true },
    ingresses: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', namespaced: true },
    horizontalpodautoscalers: {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      namespaced: true
    },
    poddisruptionbudgets: {
      apiVersion: 'policy/v1',
      kind: 'PodDisruptionBudget',
      namespaced: true
    },
    applications: { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', namespaced: true },
    persistentvolumes: { apiVersion: 'v1', kind: 'PersistentVolume', namespaced: false },
    roles: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', namespaced: true },
    rolebindings: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      namespaced: true
    },
    clusterroles: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      namespaced: false
    },
    clusterrolebindings: {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      namespaced: false
    },
    networkpolicies: {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      namespaced: true
    },
    gateways: { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway', namespaced: true },
    httproutes: {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      namespaced: true
    },
    widgets: { apiVersion: 'example.com/v1', kind: 'Widget', namespaced: true },
    statefulsets: { apiVersion: 'apps/v1', kind: 'StatefulSet', namespaced: true },
    daemonsets: { apiVersion: 'apps/v1', kind: 'DaemonSet', namespaced: true },
    endpointslices: {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      namespaced: true
    }
  }

  /** Trả `true` để các nhánh viết gọn `return json(...)`. */
  const json = (res: ServerResponse, status: number, body: unknown): true => {
    const data = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    })
    res.end(data)
    return true
  }
  const statusBody = (code: number, reason: string, message: string): unknown => ({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message,
    reason,
    code
  })
  const notify = (plural: string, type: string, obj: Obj): void => {
    for (const w of watchers)
      if (w.plural === plural && (!w.namespace || w.namespace === obj.metadata.namespace))
        w.res.write(`${JSON.stringify({ type, object: obj })}\n`)
  }
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c)
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<true> => {
      const url = new URL(req.url ?? '/', 'http://x')
      requests.push(`${req.method ?? ''} ${url.pathname}${url.search}`)
      accepts.push(`${url.pathname} ${req.headers.accept ?? ''}`)
      if (stalled?.test(url.pathname)) return true
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        json(res, 401, statusBody(401, 'Unauthorized', 'Unauthorized'))
        return true
      }
      const p = url.pathname
      if (p === '/version') return json(res, 200, { gitVersion: 'v1.31.2' })
      if (p === '/apis')
        return json(res, 200, {
          groups: [
            { name: 'apps', preferredVersion: { groupVersion: 'apps/v1', version: 'v1' } },
            {
              name: 'example.com',
              preferredVersion: { groupVersion: 'example.com/v1', version: 'v1' }
            }
          ]
        })
      if (p === '/apis/example.com/v1')
        return json(res, 200, {
          resources: [
            { name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['list', 'get', 'watch'] },
            { name: 'widgets/status', kind: 'Widget', namespaced: true, verbs: ['get'] }
          ]
        })
      // Discovery theo group/version (server-side apply tìm loại theo apiVersion + kind).
      const discovery: Record<string, string[]> = {
        '/api/v1': [
          'pods',
          'services',
          'secrets',
          'events',
          'namespaces',
          'nodes',
          'configmaps',
          'persistentvolumeclaims',
          'serviceaccounts'
        ],
        '/apis/apps/v1': ['deployments', 'replicasets'],
        '/apis/batch/v1': ['cronjobs', 'jobs'],
        '/apis/networking.k8s.io/v1': ['ingresses'],
        '/apis/autoscaling/v2': ['horizontalpodautoscalers'],
        '/apis/policy/v1': ['poddisruptionbudgets']
      }
      const group = discovery[p]
      if (group)
        return json(res, 200, {
          resources: group.flatMap((r) => {
            const meta = kindOf[r]
            return meta
              ? [{ name: r, kind: meta.kind, namespaced: meta.namespaced, verbs: ['list'] }]
              : []
          })
        })
      // Prometheus giả qua services proxy: CPU ~ 120–180m, RAM ~ 64–80 Mi mỗi pod, dao động theo thời gian.
      if (
        prometheus &&
        p.startsWith(
          '/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy/api/v1/'
        )
      ) {
        if (p.endsWith('/query'))
          return json(res, 200, {
            status: 'success',
            data: { resultType: 'scalar', result: [0, '1'] }
          })
        const q = url.searchParams.get('query') ?? ''
        const start = Number(url.searchParams.get('start'))
        const end = Number(url.searchParams.get('end'))
        const step = Number(url.searchParams.get('step'))
        const pods = (/pod=~"([^"]*)"/.exec(q)?.[1] ?? '')
          .replace(/\\/g, '')
          .split('|')
          .filter(Boolean)
        const cpu = q.includes('cpu_usage')
        return json(res, 200, {
          status: 'success',
          data: {
            resultType: 'matrix',
            result: pods.map((pod, i) => {
              const values: [number, string][] = []
              for (let t = start; t <= end; t += step) {
                const wave = Math.sin(t / 300 + i)
                values.push([t, String(cpu ? 0.15 + 0.03 * wave : (72 + 8 * wave) * 1024 * 1024)])
              }
              return { metric: { pod }, values }
            })
          }
        })
      }
      if (p.startsWith('/apis/metrics.k8s.io/v1beta1/')) {
        if (metricsDisabled)
          return json(
            res,
            404,
            statusBody(404, 'NotFound', 'the server could not find the requested resource')
          )
        if (p.endsWith('/nodes'))
          return json(res, 200, {
            items: [...(store.get('nodes')?.values() ?? [])].map((n) => ({
              metadata: { name: n.metadata.name },
              usage: { cpu: '1500m', memory: '2Gi' }
            }))
          })
        const nsMatch = /\/namespaces\/([^/]+)\/pods$/.exec(p)
        return json(res, 200, {
          items: [...(store.get('pods')?.values() ?? [])]
            .filter((x) => !nsMatch || x.metadata.namespace === nsMatch[1])
            .map((x) => ({
              metadata: { name: x.metadata.name, namespace: x.metadata.namespace },
              containers: [{ name: 'app', usage: { cpu: '120000000n', memory: '64Mi' } }]
            }))
        })
      }
      if (p === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews' && req.method === 'POST') {
        const body = (await readBody(req)) as {
          spec: { resourceAttributes: { resource: string; namespace?: string } }
        }
        const attrs = body.spec.resourceAttributes
        const allowed = !(attrs.resource === 'secrets' && attrs.namespace === 'restricted')
        return json(res, 201, { status: { allowed } })
      }
      // Caretta: proxy tới /metrics của pod agent.
      if (/^\/api\/v1\/namespaces\/caretta\/pods\/caretta-agent-1:7117\/proxy\/metrics$/.test(p)) {
        if (!caretta) return json(res, 404, statusBody(404, 'NotFound', 'no caretta'))
        if (caretta.forbidden)
          return json(res, 403, statusBody(403, 'Forbidden', 'cannot get pods/proxy'))
        const secs = caretta.idle ? 60 : (Date.now() - caretta.start) / 1000 + 60
        const body = [
          '# HELP caretta_links_observed total bytes_sent value of links observed by caretta',
          '# TYPE caretta_links_observed gauge',
          ...CARETTA_LINKS.flatMap((l, i) => [
            `caretta_links_observed{link_id="${String(i)}",${l.labels},role="1"} ${String(Math.round((l.base ?? 0) + l.rate * secs))}`,
            // Cùng kết nối thấy từ phía server (ít hơn chút) — không được đếm hai lần.
            `caretta_links_observed{link_id="${String(i)}",${l.labels},role="2"} ${String(Math.round(((l.base ?? 0) + l.rate * secs) * 0.98))}`
          ]),
          'go_goroutines 12'
        ].join('\n')
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(body)
        return true
      }
      const m =
        /^\/(?:api\/v1|apis\/([^/]+)\/v[0-9a-z]+)(?:\/namespaces\/([^/]+))?\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z]+))?$/.exec(
          p
        )
      if (!m)
        return json(
          res,
          404,
          statusBody(404, 'NotFound', `the server could not find the requested resource ${p}`)
        )
      const [, , namespace, plural = '', name, sub] = m
      // /api/v1/namespaces/<name> (không phải namespace của tài nguyên con)
      const table = store.get(plural)
      const meta = kindOf[plural]
      if (!table || !meta)
        return json(res, 404, statusBody(404, 'NotFound', `no resource ${plural}`))
      if (plural === 'secrets' && namespace === 'restricted')
        return json(
          res,
          403,
          statusBody(
            403,
            'Forbidden',
            `secrets is forbidden: User "dev" cannot list resource "secrets" in API group "" in the namespace "restricted"`
          )
        )
      const key = (ns: string | undefined, n: string): string =>
        meta.namespaced ? `${ns ?? ''}/${n}` : n

      if (!name && req.method === 'POST') {
        const body = (await readBody(req)) as Obj
        const created = {
          ...body,
          metadata: {
            ...body.metadata,
            namespace,
            uid: `uid-${body.metadata.name}`,
            resourceVersion: nextRv(),
            creationTimestamp: new Date().toISOString()
          }
        }
        // Pod debug (Shellhouse tạo): chạy ngay như kubelet đã kéo image xong.
        if (plural === 'pods' && body.metadata.labels?.['shellhouse.dev/debug'] && !created.status)
          created.status = {
            phase: 'Running',
            containerStatuses: (
              (body.spec?.['containers'] as { name: string }[] | undefined) ?? []
            ).map((c) => ({ name: c.name, ready: true, restartCount: 0, state: { running: {} } }))
          }
        table.set(key(namespace, body.metadata.name), created)
        notify(plural, 'ADDED', created)
        return json(res, 201, created)
      }
      if (!name) {
        if (url.searchParams.get('watch') === 'true') {
          if (failingWatches > 0) {
            failingWatches--
            return json(res, 503, statusBody(503, 'ServiceUnavailable', 'try again'))
          }
          if (expired) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              `${JSON.stringify({ type: 'ERROR', object: statusBody(410, 'Expired', 'too old resource version') })}\n`
            )
            return true
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.flushHeaders()
          const w = { plural, namespace, res }
          watchers.add(w)
          res.on('close', () => watchers.delete(w))
          return true
        }
        let items = [...table.values()].filter(
          (o) => !namespace || o.metadata.namespace === namespace
        )
        const field = url.searchParams.get('fieldSelector')
        const nameField = /involvedObject\.name=([^,]+)/.exec(field ?? '')?.[1]
        if (nameField)
          items = items.filter(
            (o) => (o['involvedObject'] as { name?: string } | undefined)?.name === nameField
          )
        if (/status\.phase=Running/.test(field ?? ''))
          items = items.filter(
            (o) => (o.status as { phase?: string } | undefined)?.phase === 'Running'
          )
        const nodeField = /spec\.nodeName=([^,]+)/.exec(field ?? '')?.[1]
        if (nodeField)
          items = items.filter(
            (o) => (o.spec as { nodeName?: string } | undefined)?.nodeName === nodeField
          )
        const typeField = /(?:^|,)type=([^,]+)/.exec(field ?? '')?.[1]
        if (typeField) items = items.filter((o) => o['type'] === typeField)
        const selector = url.searchParams.get('labelSelector')
        if (selector)
          for (const pair of selector.split(',')) {
            const [k, v] = pair.split('=')
            items = items.filter((o) => o.metadata.labels?.[k ?? ''] === v)
          }
        const limit = Number(url.searchParams.get('limit') ?? '0') || items.length
        const start = Number(url.searchParams.get('continue') ?? '0')
        // Accept: …;as=PartialObjectMetadataList → chỉ metadata (như API server thật).
        const metaOnly = /as=PartialObjectMetadataList/.test(req.headers.accept ?? '')
        const page = items.slice(start, start + limit).map((o) =>
          metaOnly
            ? {
                apiVersion: 'meta.k8s.io/v1',
                kind: 'PartialObjectMetadata',
                metadata: o.metadata
              }
            : o
        )
        return json(res, 200, {
          kind: `${meta.kind}List`,
          apiVersion: meta.apiVersion,
          metadata: {
            resourceVersion: String(rv),
            ...(start + limit < items.length
              ? {
                  continue: String(start + limit),
                  remainingItemCount: items.length - start - limit
                }
              : {})
          },
          items: page
        })
      }
      const k = key(namespace, name)
      const current = table.get(k)
      if (sub === 'log') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        // Theo dõi tiếp (sinceTime): không gửi lại phần đầu.
        res.write(
          url.searchParams.get('sinceTime')
            ? `resumed ${name}\n`
            : `log line 1 from ${name}\nlog line 2 (container ${url.searchParams.get('container') ?? '-'})\n`
        )
        if (url.searchParams.get('follow') !== 'true') res.end()
        else {
          logStreams.add(res)
          res.on('close', () => logStreams.delete(res))
          const t = setInterval(() => {
            res.write(`tick ${Date.now()}\n`)
          }, 200)
          res.on('close', () => {
            clearInterval(t)
          })
        }
        return true
      }
      if (sub === 'scale' && req.method === 'PATCH') {
        if (!current) return json(res, 404, statusBody(404, 'NotFound', 'not found'))
        const body = (await readBody(req)) as { spec: { replicas: number } }
        current.spec = { ...current.spec, replicas: body.spec.replicas }
        current.metadata.resourceVersion = nextRv()
        notify(plural, 'MODIFIED', current)
        return json(res, 200, { spec: { replicas: body.spec.replicas } })
      }
      // Container debug tạm thời: image có "missing" → kéo image hỏng (ErrImagePull).
      if (sub === 'ephemeralcontainers' && req.method === 'PATCH') {
        if (!current) return json(res, 404, statusBody(404, 'NotFound', 'not found'))
        const body = (await readBody(req)) as {
          spec: { ephemeralContainers: { name: string; image: string }[] }
        }
        const spec = (current.spec ?? {}) as { ephemeralContainers?: unknown[] }
        const status = (current.status ?? {}) as { ephemeralContainerStatuses?: unknown[] }
        current.spec = {
          ...spec,
          ephemeralContainers: [
            ...(spec.ephemeralContainers ?? []),
            ...body.spec.ephemeralContainers
          ]
        }
        current.status = {
          ...status,
          ephemeralContainerStatuses: [
            ...(status.ephemeralContainerStatuses ?? []),
            ...body.spec.ephemeralContainers.map((c) => ({
              name: c.name,
              state: c.image.includes('missing')
                ? { waiting: { reason: 'ErrImagePull', message: `pull ${c.image}: not found` } }
                : { running: { startedAt: new Date().toISOString() } }
            }))
          ]
        }
        current.metadata.resourceVersion = nextRv()
        notify(plural, 'MODIFIED', current)
        return json(res, 200, current)
      }
      if (sub === 'eviction' && req.method === 'POST') {
        if (!current) return json(res, 404, statusBody(404, 'NotFound', 'not found'))
        if (blockedEvictions > 0) {
          blockedEvictions--
          return json(
            res,
            429,
            statusBody(
              429,
              'TooManyRequests',
              "Cannot evict pod as it would violate the pod's disruption budget."
            )
          )
        }
        table.delete(k)
        notify(plural, 'DELETED', current)
        return json(res, 201, { kind: 'Status', status: 'Success' })
      }
      // Server-side apply: tạo nếu chưa có, không thì gộp.
      if (
        req.method === 'PATCH' &&
        req.headers['content-type'] === 'application/apply-patch+yaml'
      ) {
        const body = (await readBody(req)) as Obj
        const next: Obj = {
          ...(current ?? {}),
          ...body,
          metadata: {
            ...(current?.metadata ?? {
              uid: `uid-${body.metadata.name}`,
              creationTimestamp: new Date().toISOString()
            }),
            ...body.metadata,
            resourceVersion: nextRv()
          }
        }
        // dryRun=All: trả kết quả, không lưu (xem trước thay đổi).
        if (url.searchParams.get('dryRun') === 'All') return json(res, current ? 200 : 201, next)
        table.set(k, next)
        notify(plural, current ? 'MODIFIED' : 'ADDED', next)
        return json(res, current ? 200 : 201, next)
      }
      if (!current)
        return json(res, 404, statusBody(404, 'NotFound', `${plural} "${name}" not found`))
      if (req.method === 'GET') return json(res, 200, current)
      if (req.method === 'DELETE') {
        table.delete(k)
        notify(plural, 'DELETED', current)
        return json(res, 200, statusBody(200, '', 'deleted'))
      }
      if (req.method === 'PUT') {
        const body = (await readBody(req)) as Obj
        if (body.metadata.resourceVersion !== current.metadata.resourceVersion)
          return json(
            res,
            409,
            statusBody(
              409,
              'Conflict',
              `Operation cannot be fulfilled on ${plural} "${name}": the object has been modified; please apply your changes to the latest version and try again`
            )
          )
        const next = { ...body, metadata: { ...body.metadata, resourceVersion: nextRv() } }
        if (url.searchParams.get('dryRun') === 'All') return json(res, 200, next)
        table.set(k, next)
        notify(plural, 'MODIFIED', next)
        return json(res, 200, next)
      }
      if (req.method === 'PATCH') {
        // Merge patch (rút gọn): spec gộp nông; trường cấp trên khác (operation…) gán thẳng;
        // annotations gộp.
        const body = (await readBody(req)) as Obj & { spec?: Record<string, unknown> }
        const { spec, metadata, ...rest } = body
        if (spec) current.spec = { ...current.spec, ...spec }
        Object.assign(current, rest)
        const anns = (metadata as { annotations?: Record<string, string> } | undefined)?.annotations
        if (anns) {
          const meta = current.metadata as Obj['metadata'] & {
            annotations?: Record<string, string>
          }
          meta.annotations = { ...meta.annotations, ...anns }
        }
        current.metadata.resourceVersion = nextRv()
        notify(plural, 'MODIFIED', current)
        return json(res, 200, current)
      }
      return json(res, 405, statusBody(405, 'MethodNotAllowed', 'nope'))
    })()
  }

  const server =
    options.tls === false
      ? createHttpServer(handler)
      : createHttpsServer(
          {
            key: readFileSync(join(FIXTURES, 'server.key')),
            cert: readFileSync(join(FIXTURES, 'server.crt'))
          },
          handler
        )
  // exec / portforward qua WebSocket (kênh v4: byte đầu = số kênh).
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    requests.push(`WS ${url.pathname}${url.search}`)
    // Pod không còn (bị xoá / thay) → 404 như API server thật.
    const target = /\/namespaces\/([^/]+)\/pods\/([^/]+)\/(exec|portforward)$/.exec(url.pathname)
    if (target && !store.get('pods')?.has(`${target[1] ?? ''}/${target[2] ?? ''}`)) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      if (url.pathname.endsWith('/attach')) {
        // Gắn vào container (debug): báo container, dội stdin.
        ws.send(
          Buffer.concat([
            Buffer.from([1]),
            Buffer.from(`attached: ${url.searchParams.get('container') ?? '-'}\r\n`)
          ])
        )
        ws.on('message', (data: Buffer) => {
          if (data[0] === 0) ws.send(Buffer.concat([Buffer.from([1]), data.subarray(1)]))
        })
        return
      }
      if (url.pathname.endsWith('/exec')) {
        // "Shell" giả: in lệnh đã chạy, dội stdin, báo kích thước terminal; "exit" → kết thúc.
        ws.send(
          Buffer.concat([
            Buffer.from([1]),
            Buffer.from(`exec: ${url.searchParams.getAll('command').join(' ')}\r\n`)
          ])
        )
        let line = ''
        ws.on('message', (data: Buffer) => {
          const ch = data[0]
          const payload = data.subarray(1).toString('utf8')
          if (ch === 4)
            ws.send(Buffer.concat([Buffer.from([1]), Buffer.from(`[resize ${payload}]\r\n`)]))
          if (ch !== 0) return
          ws.send(Buffer.concat([Buffer.from([1]), Buffer.from(payload)]))
          line += payload
          if (line.includes('exit\r')) {
            ws.send(
              Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify({ status: 'Success' }))])
            )
            ws.close()
          }
          if (line.includes('\r')) line = ''
        })
        return
      }
      // portforward: dội lại mọi byte, có tiền tố cổng ở khung đầu mỗi kênh.
      const port = Number(url.searchParams.get('ports'))
      const prefix = Buffer.alloc(2)
      prefix.writeUInt16LE(port)
      ws.send(Buffer.concat([Buffer.from([0]), prefix]))
      ws.send(Buffer.concat([Buffer.from([1]), prefix]))
      ws.on('message', (data: Buffer) => {
        if (data[0] === 0)
          ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(`echo:${port}:`), data.subarray(1)]))
      })
    })
  })
  let connections = 0
  server.on('connection', () => {
    connections++
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  /**
   * Traffic giống cluster thật (Caretta) cho service map: ingress-nginx gọi các service của
   * console-stg, console-stg gọi qua lại / kube-system / monitoring scrape, hàng chục địa chỉ ngoài
   * cluster (RDS, S3, Stripe…), client Internet vào ingress, vài kết nối idle. Thêm workload /
   * namespace tương ứng để mở được chi tiết.
   */
  const seedTraffic = (): void => {
    const table = (plural: string): Map<string, Obj> => {
      let t = store.get(plural)
      if (!t) {
        t = new Map()
        store.set(plural, t)
      }
      return t
    }
    for (const n of ['console-stg', 'ingress-nginx', 'kube-system', 'monitoring'])
      if (!table('namespaces').has(n))
        table('namespaces').set(
          n,
          make('v1', 'Namespace', n, undefined, { status: { phase: 'Active' } })
        )
    const workload = (plural: string, kind: string, ns: string, name: string): void => {
      if (table(plural).has(`${ns}/${name}`)) return
      table(plural).set(
        `${ns}/${name}`,
        make('apps/v1', kind, name, ns, {
          spec: {
            replicas: 2,
            selector: { matchLabels: { app: name } },
            template: { metadata: { labels: { app: name } }, spec: POD_SPEC }
          },
          status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 }
        })
      )
    }
    const deps = [
      'console-web',
      'console-api',
      'auth-service',
      'user-service',
      'billing-service',
      'notification-service',
      'report-worker',
      'file-service'
    ]
    for (const d of deps) workload('deployments', 'Deployment', 'console-stg', d)
    for (const s of ['redis', 'rabbitmq']) workload('statefulsets', 'StatefulSet', 'console-stg', s)
    workload('deployments', 'Deployment', 'ingress-nginx', 'ingress-nginx-controller')
    workload('deployments', 'Deployment', 'kube-system', 'coredns')
    workload('statefulsets', 'StatefulSet', 'monitoring', 'prometheus')
    const KIND: Record<string, string> = { redis: 'StatefulSet', rabbitmq: 'StatefulSet' }
    const peer = (side: 'client' | 'server', ref: string): string => {
      // "ns/name" = workload; còn lại = địa chỉ / tên DNS ngoài cluster.
      const [ns, name] = ref.includes('/') ? ref.split('/') : ['', ref]
      const kind = !ns
        ? 'external'
        : ns === 'monitoring'
          ? 'StatefulSet'
          : (KIND[name ?? ''] ?? 'Deployment')
      return `${side}_kind="${kind}",${side}_name="${name ?? ''}",${side}_namespace="${ns ?? ''}"`
    }
    const link = (from: string, to: string, port: number, kbps: number): void => {
      CARETTA_LINKS.push({
        labels: `${peer('client', from)},${peer('server', to)},server_port="${String(port)}"`,
        rate: Math.round(kbps * 1024),
        base: 4_096_000
      })
    }
    const C = (n: string): string => `console-stg/${n}`
    const ING = 'ingress-nginx/ingress-nginx-controller'
    const RDS = 'console-stg.cluster-c9x2.ap-southeast-1.rds.amazonaws.com'
    const S3 = 's3.ap-southeast-1.amazonaws.com'
    // Internet → ingress (không thuộc console-stg: không được làm rối service map của nó).
    for (let i = 0; i < 60; i++)
      link(
        `${String(100 + (i % 7))}.${String(20 + i)}.${String(i * 3)}.${String(10 + i)}`,
        ING,
        443,
        2 + (i % 9) * 6
      )
    link(ING, C('console-web'), 3000, 820)
    link(ING, C('console-api'), 8080, 1650)
    link(ING, C('auth-service'), 8080, 64)
    link(ING, C('file-service'), 8080, 3100)
    link(C('console-web'), C('console-api'), 8080, 210)
    link(C('console-api'), C('auth-service'), 8080, 42)
    link(C('console-api'), C('user-service'), 8080, 120)
    link(C('console-api'), C('billing-service'), 8080, 31)
    link(C('console-api'), C('notification-service'), 8080, 5)
    link(C('console-api'), C('redis'), 6379, 410)
    link(C('console-api'), RDS, 5432, 930)
    link(C('auth-service'), C('redis'), 6379, 52)
    link(C('auth-service'), C('user-service'), 8080, 18)
    link(C('user-service'), RDS, 5432, 150)
    link(C('user-service'), C('billing-service'), 8080, 0)
    link(C('billing-service'), 'api.stripe.com', 443, 3)
    link(C('billing-service'), 'hooks.stripe.com', 443, 0)
    link(C('notification-service'), C('rabbitmq'), 5672, 8)
    link(C('notification-service'), 'smtp.sendgrid.net', 587, 0)
    link(C('notification-service'), 'fcm.googleapis.com', 443, 2)
    link(C('report-worker'), C('rabbitmq'), 5672, 1)
    link(C('report-worker'), S3, 443, 520)
    link(C('report-worker'), RDS, 5432, 0)
    link(C('report-worker'), C('user-service'), 8080, 0)
    link(C('file-service'), S3, 443, 2600)
    for (let i = 0; i < 12; i++)
      link(C('file-service'), `52.219.${String(130 + i)}.${String(20 + i * 7)}`, 443, 40 + i * 25)
    for (let i = 0; i < 8; i++)
      link(C('console-api'), `13.250.${String(i * 11)}.${String(5 + i)}`, 443, 1 + i * 2)
    // Client Internet gọi thẳng console-api qua LoadBalancer.
    for (let i = 0; i < 6; i++)
      link(`113.161.${String(40 + i)}.${String(9 + i)}`, C('console-api'), 8443, 12 + i * 4)
    for (const d of [...deps, 'redis', 'rabbitmq']) {
      link(C(d), 'kube-system/coredns', 53, d.length % 3 === 0 ? 0 : 0.3)
      link('monitoring/prometheus', C(d), 9090, 1.5)
    }
    link('monitoring/prometheus', 'kube-system/coredns', 9153, 1)
  }

  /** Cluster mẫu (xem `seedDemo` trong ApiTestServer). */
  const seedDemo = (): void => {
    const put = (plural: string, obj: Obj): void => {
      let table = store.get(plural)
      if (!table) {
        table = new Map()
        store.set(plural, table)
      }
      const ns = obj.metadata.namespace
      table.set(ns ? `${ns}/${obj.metadata.name}` : obj.metadata.name, obj)
    }
    const meta = (o: Obj, extra: Record<string, unknown>): Obj => {
      Object.assign(o.metadata, extra)
      return o
    }
    for (const n of ['payments', 'monitoring'])
      put(
        'namespaces',
        meta(make('v1', 'Namespace', n, undefined, { status: { phase: 'Active' } }), {
          labels: {
            'kubernetes.io/metadata.name': n,
            team: n === 'payments' ? 'commerce' : 'platform'
          }
        })
      )
    let ip = 10
    const running = (restarts = 0): Record<string, unknown> => ({
      phase: 'Running',
      podIP: `10.42.0.${String(++ip)}`,
      startTime: new Date(Date.now() - 5_400_000).toISOString(),
      containerStatuses: [
        { name: 'app', ready: true, restartCount: restarts, state: { running: {} } }
      ]
    })
    const waiting = (reason: string, restarts = 0): Record<string, unknown> => ({
      phase: reason === 'Pending' ? 'Pending' : 'Running',
      ...(reason === 'Pending'
        ? {
            conditions: [
              {
                type: 'PodScheduled',
                status: 'False',
                reason: 'Unschedulable',
                message:
                  '0/2 nodes are available: pod has unbound immediate PersistentVolumeClaims.'
              }
            ]
          }
        : {}),
      containerStatuses:
        reason === 'Pending'
          ? []
          : [{ name: 'app', ready: false, restartCount: restarts, state: { waiting: { reason } } }]
    })
    const container = (
      image: string,
      ports: { name?: string; containerPort: number }[],
      extra: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
      name: 'app',
      image,
      ports,
      resources: { requests: { cpu: '100m', memory: '128Mi' } },
      ...extra
    })
    /** Deployment + ReplicaSet + pod (trạng thái từng pod). */
    const deployment = (
      ns: string,
      name: string,
      spec: {
        replicas: number
        ready: number
        containers: Record<string, unknown>[]
        volumes?: unknown[]
        pods: Record<string, unknown>[]
        labels?: Record<string, string>
      }
    ): void => {
      const labels = { app: name, ...spec.labels }
      put(
        'deployments',
        make('apps/v1', 'Deployment', name, ns, {
          spec: {
            replicas: spec.replicas,
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels },
              spec: {
                containers: spec.containers,
                ...(spec.volumes ? { volumes: spec.volumes } : {})
              }
            }
          },
          status: {
            replicas: spec.pods.length,
            readyReplicas: spec.ready,
            availableReplicas: spec.ready,
            updatedReplicas: spec.pods.length
          }
        })
      )
      const rs = `${name}-6f9c7`
      put(
        'replicasets',
        meta(
          make('apps/v1', 'ReplicaSet', rs, ns, {
            spec: { replicas: spec.replicas, template: { metadata: { labels } } },
            status: { replicas: spec.pods.length, readyReplicas: spec.ready }
          }),
          {
            labels: { ...labels, 'pod-template-hash': '6f9c7' },
            ownerReferences: [{ kind: 'Deployment', name, controller: true }]
          }
        )
      )
      spec.pods.forEach((status, i) => {
        const pod = make(
          'v1',
          'Pod',
          `${rs}-${['x2k4p', 'b8n1q', 'm3v7d', 'r5t9w'][i] ?? String(i)}`,
          ns,
          {
            spec: { containers: spec.containers, nodeName: i % 2 ? 'node-2' : 'node-1' },
            status
          }
        )
        put(
          'pods',
          meta(pod, {
            labels: { ...labels, 'pod-template-hash': '6f9c7' },
            ownerReferences: [{ kind: 'ReplicaSet', name: rs, controller: true }]
          })
        )
      })
    }
    const service = (
      ns: string,
      name: string,
      spec: Record<string, unknown>,
      status?: Record<string, unknown>
    ): void => {
      put('services', make('v1', 'Service', name, ns, { spec, ...(status ? { status } : {}) }))
    }
    const slice = (ns: string, svc: string, pods: { name: string; ready: boolean }[]): void => {
      put(
        'endpointslices',
        meta(
          make('discovery.k8s.io/v1', 'EndpointSlice', `${svc}-abcde`, ns, {
            addressType: 'IPv4',
            endpoints: pods.map((p, i) => ({
              addresses: [`10.42.0.${String(20 + i)}`],
              conditions: { ready: p.ready },
              targetRef: { kind: 'Pod', name: p.name, namespace: ns }
            }))
          }),
          { labels: { 'kubernetes.io/service-name': svc } }
        )
      )
    }
    const ingress = (
      ns: string,
      name: string,
      spec: Record<string, unknown>,
      address?: string
    ): void => {
      put(
        'ingresses',
        make('networking.k8s.io/v1', 'Ingress', name, ns, {
          spec,
          ...(address ? { status: { loadBalancer: { ingress: [{ ip: address }] } } } : {})
        })
      )
    }
    const rule = (host: string, paths: [string, string, number | string][]): unknown => ({
      host,
      http: {
        paths: paths.map(([path, svc, port]) => ({
          path,
          pathType: 'Prefix',
          backend: {
            service: {
              name: svc,
              port: typeof port === 'number' ? { number: port } : { name: port }
            }
          }
        }))
      }
    })

    // Deployment web của fixture: khai báo cổng "http" như pod của nó (Service trỏ targetPort: http).
    const webTpl = (
      store.get('deployments')?.get('shop/web')?.spec as
        { template?: { spec?: { containers?: Record<string, unknown>[] } } } | undefined
    )?.template?.spec?.containers?.[0]
    if (webTpl) webTpl['ports'] = [{ name: 'http', containerPort: 8080 }]
    // Prometheus (nếu đã bật): Service không selector, endpoint do operator quản lý.
    if (store.get('services')?.has('monitoring/prometheus-operated'))
      slice('monitoring', 'prometheus-operated', [{ name: 'prometheus-0', ready: true }])
    // ServiceAccount "default" có sẵn ở mọi namespace (như cluster thật).
    for (const n of ['shop', 'payments', 'monitoring'])
      put('serviceaccounts', make('v1', 'ServiceAccount', 'default', n))
    // ——— shop: cửa hàng — Ingress nhiều host / path / TLS ———
    // Pod web thật của fixture: endpoint web-1 sẵn sàng, web-2 CrashLoop.
    slice('shop', 'web', [
      { name: 'web-1', ready: true },
      { name: 'web-2', ready: false }
    ])
    ingress(
      'shop',
      'storefront',
      {
        ingressClassName: 'nginx',
        tls: [
          { hosts: ['shop.example.com'], secretName: 'shop-tls' },
          { hosts: ['admin.example.com'], secretName: 'admin-tls' }
        ],
        rules: [
          rule('shop.example.com', [
            ['/', 'web', 80],
            ['/api', 'api', 'http'],
            ['/legacy', 'legacy-api', 80]
          ]),
          rule('admin.example.com', [['/', 'admin', 80]])
        ]
      },
      '203.0.113.10'
    )
    put(
      'secrets',
      make('v1', 'Secret', 'shop-tls', 'shop', { type: 'kubernetes.io/tls', data: {} })
    )
    put('secrets', make('v1', 'Secret', 'db-credentials', 'shop', { type: 'Opaque', data: {} }))
    put(
      'configmaps',
      make('v1', 'ConfigMap', 'api-config', 'shop', { data: { LOG_LEVEL: 'info' } })
    )
    deployment('shop', 'api', {
      replicas: 3,
      ready: 3,
      labels: { tier: 'backend' },
      containers: [
        container('ghcr.io/example/shop-api:2.4.1', [{ name: 'http', containerPort: 8080 }], {
          envFrom: [
            { configMapRef: { name: 'api-config' } },
            { secretRef: { name: 'db-credentials' } }
          ]
        })
      ],
      pods: [running(), running(1), running()]
    })
    service('shop', 'api', {
      type: 'ClusterIP',
      clusterIP: '10.43.12.7',
      selector: { app: 'api' },
      ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }]
    })
    slice('shop', 'api', [
      { name: 'api-6f9c7-x2k4p', ready: true },
      { name: 'api-6f9c7-b8n1q', ready: true },
      { name: 'api-6f9c7-m3v7d', ready: true }
    ])
    put(
      'horizontalpodautoscalers',
      make('autoscaling/v2', 'HorizontalPodAutoscaler', 'api', 'shop', {
        spec: {
          minReplicas: 2,
          maxReplicas: 3,
          scaleTargetRef: { kind: 'Deployment', name: 'api' }
        },
        status: { currentReplicas: 3, desiredReplicas: 3 }
      })
    )
    deployment('shop', 'admin', {
      replicas: 1,
      ready: 0,
      containers: [
        container('ghcr.io/example/shop-admin:1.9.0-rc1', [{ name: 'http', containerPort: 3000 }])
      ],
      pods: [waiting('ImagePullBackOff')]
    })
    service('shop', 'admin', {
      type: 'ClusterIP',
      clusterIP: '10.43.12.9',
      selector: { app: 'admin' },
      ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }]
    })
    slice('shop', 'admin', [{ name: 'admin-6f9c7-x2k4p', ready: false }])
    service(
      'shop',
      'web-public',
      {
        type: 'LoadBalancer',
        clusterIP: '10.43.12.20',
        selector: { app: 'web' },
        ports: [{ name: 'https', port: 443, targetPort: 'http', nodePort: 31443, protocol: 'TCP' }]
      },
      { loadBalancer: { ingress: [{ ip: '198.51.100.20' }] } }
    )
    slice('shop', 'web-public', [
      { name: 'web-1', ready: true },
      { name: 'web-2', ready: false }
    ])
    put(
      'statefulsets',
      make('apps/v1', 'StatefulSet', 'postgres', 'shop', {
        spec: {
          replicas: 1,
          serviceName: 'postgres',
          selector: { matchLabels: { app: 'postgres' } },
          template: {
            metadata: { labels: { app: 'postgres', tier: 'data' } },
            spec: {
              containers: [
                container('postgres:16.4', [{ name: 'pg', containerPort: 5432 }], {
                  env: [
                    {
                      name: 'POSTGRES_PASSWORD',
                      valueFrom: { secretKeyRef: { name: 'db-credentials', key: 'password' } }
                    }
                  ]
                })
              ]
            }
          },
          volumeClaimTemplates: [{ metadata: { name: 'data' } }]
        },
        status: { replicas: 1, readyReplicas: 1 }
      })
    )
    put(
      'pods',
      meta(
        make('v1', 'Pod', 'postgres-0', 'shop', {
          spec: {
            containers: [container('postgres:16.4', [{ name: 'pg', containerPort: 5432 }])],
            nodeName: 'node-1'
          },
          status: running()
        }),
        {
          labels: { app: 'postgres', tier: 'data' },
          ownerReferences: [{ kind: 'StatefulSet', name: 'postgres', controller: true }]
        }
      )
    )
    put(
      'persistentvolumeclaims',
      make('v1', 'PersistentVolumeClaim', 'data-postgres-0', 'shop', {
        spec: { storageClassName: 'standard', volumeName: 'pv-7c1e' },
        status: { phase: 'Bound', capacity: { storage: '20Gi' } }
      })
    )
    service('shop', 'postgres', {
      type: 'ClusterIP',
      clusterIP: 'None',
      selector: { app: 'postgres' },
      ports: [{ name: 'pg', port: 5432, targetPort: 'pg', protocol: 'TCP' }]
    })
    slice('shop', 'postgres', [{ name: 'postgres-0', ready: true }])
    // Service trỏ tới workload đã xoá: selector không khớp pod nào.
    service('shop', 'redis', {
      type: 'ClusterIP',
      clusterIP: '10.43.12.30',
      selector: { app: 'redis' },
      ports: [{ port: 6379, targetPort: 6379, protocol: 'TCP' }]
    })
    slice('shop', 'redis', [])
    service('shop', 'stripe', { type: 'ExternalName', externalName: 'api.stripe.com' })
    // Upload: PVC chưa cấp được (Pending) → pod Pending.
    put(
      'persistentvolumeclaims',
      make('v1', 'PersistentVolumeClaim', 'uploads', 'shop', {
        spec: { storageClassName: 'fast-ssd' },
        status: { phase: 'Pending' }
      })
    )
    deployment('shop', 'media', {
      replicas: 1,
      ready: 0,
      containers: [
        container('ghcr.io/example/media:0.8.2', [{ name: 'http', containerPort: 8080 }])
      ],
      volumes: [{ name: 'uploads', persistentVolumeClaim: { claimName: 'uploads' } }],
      pods: [waiting('Pending')]
    })
    put(
      'jobs',
      meta(
        make('batch/v1', 'Job', 'db-migrate-42', 'shop', {
          spec: {
            completions: 1,
            template: { spec: { containers: [container('ghcr.io/example/shop-api:2.4.1', [])] } }
          },
          status: { succeeded: 1, completionTime: new Date().toISOString() }
        }),
        {}
      )
    )
    put(
      'networkpolicies',
      make('networking.k8s.io/v1', 'NetworkPolicy', 'allow-same-namespace', 'shop', {
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                { podSelector: {} },
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' }
                  }
                }
              ]
            }
          ]
        }
      })
    )

    // ——— payments: NodePort, Ingress, worker chạy nền ———
    deployment('payments', 'checkout', {
      replicas: 2,
      ready: 2,
      labels: { tier: 'frontend' },
      containers: [
        container('ghcr.io/example/checkout:5.2.0', [{ name: 'http', containerPort: 8080 }])
      ],
      pods: [running(), running()]
    })
    service('payments', 'checkout', {
      type: 'NodePort',
      clusterIP: '10.43.40.2',
      selector: { app: 'checkout' },
      ports: [{ name: 'http', port: 8080, targetPort: 'http', nodePort: 30080, protocol: 'TCP' }]
    })
    slice('payments', 'checkout', [
      { name: 'checkout-6f9c7-x2k4p', ready: true },
      { name: 'checkout-6f9c7-b8n1q', ready: true }
    ])
    ingress('payments', 'pay', {
      ingressClassName: 'nginx',
      tls: [{ hosts: ['pay.example.com'], secretName: 'pay-tls' }],
      rules: [rule('pay.example.com', [['/', 'checkout', 8080]])]
    })
    put(
      'secrets',
      make('v1', 'Secret', 'pay-tls', 'payments', { type: 'kubernetes.io/tls', data: {} })
    )
    deployment('payments', 'fraud-worker', {
      replicas: 2,
      ready: 1,
      containers: [container('ghcr.io/example/fraud:3.0.1', [])],
      pods: [running(), waiting('CrashLoopBackOff', 12)]
    })
    put(
      'networkpolicies',
      make('networking.k8s.io/v1', 'NetworkPolicy', 'deny-all', 'payments', {
        spec: {
          podSelector: { matchLabels: { app: 'fraud-worker' } },
          policyTypes: ['Ingress', 'Egress']
        }
      })
    )

    // ——— monitoring: DaemonSet, Grafana ———
    put(
      'daemonsets',
      make('apps/v1', 'DaemonSet', 'node-exporter', 'monitoring', {
        spec: {
          selector: { matchLabels: { app: 'node-exporter' } },
          template: {
            metadata: { labels: { app: 'node-exporter' } },
            spec: {
              containers: [
                container('quay.io/prometheus/node-exporter:v1.8.2', [
                  { name: 'metrics', containerPort: 9100 }
                ])
              ]
            }
          }
        },
        status: { desiredNumberScheduled: 2, numberReady: 1 }
      })
    )
    ;['node-1', 'node-2'].forEach((node, i) => {
      put(
        'pods',
        meta(
          make('v1', 'Pod', `node-exporter-${node}`, 'monitoring', {
            spec: {
              containers: [container('quay.io/prometheus/node-exporter:v1.8.2', [])],
              nodeName: node
            },
            status: i ? waiting('Pending') : running()
          }),
          {
            labels: { app: 'node-exporter' },
            ownerReferences: [{ kind: 'DaemonSet', name: 'node-exporter', controller: true }]
          }
        )
      )
    })
    deployment('monitoring', 'grafana', {
      replicas: 1,
      ready: 1,
      containers: [container('grafana/grafana:11.2.0', [{ name: 'http', containerPort: 3000 }])],
      pods: [running()]
    })
    service('monitoring', 'grafana', {
      type: 'ClusterIP',
      clusterIP: '10.43.50.3',
      selector: { app: 'grafana' },
      ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }]
    })
    slice('monitoring', 'grafana', [{ name: 'grafana-6f9c7-x2k4p', ready: true }])
    ingress('monitoring', 'grafana', {
      ingressClassName: 'nginx',
      rules: [rule('grafana.example.com', [['/', 'grafana', 80]])]
    })
  }

  return {
    url: `${options.tls === false ? 'http' : 'https'}://127.0.0.1:${port}`,
    port,
    requests,
    accepts,
    connections: () => connections,
    stall: (path) => {
      stalled = path
    },
    blockEvictions: (n) => {
      blockedEvictions = n
    },
    upsert: (plural, partial) => {
      const table = store.get(plural)
      const meta = kindOf[plural]
      if (!table || !meta) throw new Error(plural)
      const key = meta.namespaced
        ? `${partial.metadata.namespace ?? ''}/${partial.metadata.name}`
        : partial.metadata.name
      const existing = table.get(key)
      const obj: Obj = {
        ...make(meta.apiVersion, meta.kind, partial.metadata.name, partial.metadata.namespace),
        ...partial,
        metadata: {
          ...make(meta.apiVersion, meta.kind, partial.metadata.name, partial.metadata.namespace)
            .metadata,
          ...partial.metadata,
          resourceVersion: nextRv()
        }
      }
      table.set(key, obj)
      notify(plural, existing ? 'MODIFIED' : 'ADDED', obj)
      return obj
    },
    remove: (plural, namespace, name) => {
      const table = store.get(plural)
      const key = kindOf[plural]?.namespaced ? `${namespace ?? ''}/${name}` : name
      const obj = table?.get(key)
      if (!obj) return
      table?.delete(key)
      notify(plural, 'DELETED', obj)
    },
    seedDemo,
    enablePrometheus: () => {
      prometheus = true
      store
        .get('namespaces')
        ?.set(
          'monitoring',
          make('v1', 'Namespace', 'monitoring', undefined, { status: { phase: 'Active' } })
        )
      store.get('services')?.set(
        'monitoring/prometheus-operated',
        make('v1', 'Service', 'prometheus-operated', 'monitoring', {
          spec: { clusterIP: 'None', ports: [{ name: 'web', port: 9090 }] }
        })
      )
    },
    enableCaretta: (options = {}) => {
      caretta = {
        forbidden: options.forbidden ?? false,
        start: Date.now(),
        idle: options.idle ?? false
      }
      if (options.realistic) seedTraffic()
      const pods = store.get('pods')
      if (!store.get('namespaces')?.has('caretta'))
        store
          .get('namespaces')
          ?.set(
            'caretta',
            make('v1', 'Namespace', 'caretta', undefined, { status: { phase: 'Active' } })
          )
      pods?.set(
        'caretta/caretta-agent-1',
        make('v1', 'Pod', 'caretta-agent-1', 'caretta', {
          spec: {
            nodeName: 'node-1',
            containers: [
              {
                name: 'caretta',
                image: 'quay.io/groundcover/caretta:v0.0.4',
                ports: [{ name: 'prom-metric', containerPort: 7117 }]
              }
            ]
          },
          status: RUNNING
        })
      )
      const agent = pods?.get('caretta/caretta-agent-1')
      if (agent) agent.metadata.labels = { 'app.kubernetes.io/name': 'caretta' }
    },
    disableMetrics: () => {
      metricsDisabled = true
    },
    get: (plural, namespace, name) => {
      const meta = kindOf[plural]
      return store.get(plural)?.get(meta?.namespaced ? `${namespace ?? ''}/${name}` : name)
    },
    list: (plural) => [...(store.get(plural)?.values() ?? [])],
    expireWatches: () => {
      expired = true
      for (const w of watchers) w.res.end()
    },
    cutLogs: () => {
      for (const r of logStreams) r.socket?.destroy()
    },
    cutWatches: () => {
      for (const w of watchers) w.res.socket?.destroy()
    },
    failWatches: (n) => {
      failingWatches = n
      for (const w of watchers) w.res.end()
    },
    close: async () => {
      for (const w of watchers) w.res.destroy()
      for (const c of wss.clients) c.terminate()
      server.closeAllConnections()
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        })
      )
    }
  }
}
