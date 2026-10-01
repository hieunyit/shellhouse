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
  get(plural: string, namespace: string | undefined, name: string): Obj | undefined
  list(plural: string): Obj[]
  /** Làm các watch sau nhận 410 Gone. */
  expireWatches(): void
  /** Ngắt các watch đang mở; `n` lần watch tiếp theo trả 503 (mạng / API server chập chờn). */
  failWatches(n: number): void
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
        ['default', 'shop', 'restricted'].map((n) => [
          n,
          make('v1', 'Namespace', n, undefined, { status: { phase: 'Active' } })
        ])
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
                spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] }
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
    ['configmaps', new Map()]
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
  // Pod cần nhãn để service tìm thấy.
  for (const p of store.get('pods')?.values() ?? [])
    p.metadata.labels = { app: p.metadata.name.startsWith('web') ? 'web' : 'tool' }
  const requests: string[] = []
  let failingWatches = 0
  const watchers = new Set<{ plural: string; namespace: string | undefined; res: ServerResponse }>()
  let expired = false
  let metricsDisabled = false

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
    widgets: { apiVersion: 'example.com/v1', kind: 'Widget', namespaced: true }
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
        '/api/v1': ['pods', 'services', 'secrets', 'events', 'namespaces', 'nodes', 'configmaps'],
        '/apis/apps/v1': ['deployments', 'replicasets'],
        '/apis/batch/v1': ['cronjobs', 'jobs']
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
      const m =
        /^\/(?:api\/v1|apis\/([^/]+)\/v1)(?:\/namespaces\/([^/]+))?\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z]+))?$/.exec(
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
        const selector = url.searchParams.get('labelSelector')
        if (selector) {
          const [k, v] = selector.split('=')
          items = items.filter((o) => o.metadata.labels?.[k ?? ''] === v)
        }
        const limit = Number(url.searchParams.get('limit') ?? '0') || items.length
        const start = Number(url.searchParams.get('continue') ?? '0')
        const page = items.slice(start, start + limit)
        return json(res, 200, {
          kind: `${meta.kind}List`,
          apiVersion: meta.apiVersion,
          metadata: {
            resourceVersion: String(rv),
            ...(start + limit < items.length ? { continue: String(start + limit) } : {})
          },
          items: page
        })
      }
      const k = key(namespace, name)
      const current = table.get(k)
      if (sub === 'log') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.write(
          `log line 1 from ${name}\nlog line 2 (container ${url.searchParams.get('container') ?? '-'})\n`
        )
        if (url.searchParams.get('follow') !== 'true') res.end()
        else {
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
      if (sub === 'eviction' && req.method === 'POST') {
        if (!current) return json(res, 404, statusBody(404, 'NotFound', 'not found'))
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
        table.set(k, next)
        notify(plural, 'MODIFIED', next)
        return json(res, 200, next)
      }
      if (req.method === 'PATCH') {
        const body = (await readBody(req)) as { spec?: Record<string, unknown> }
        current.spec = { ...current.spec, ...body.spec }
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
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `${options.tls === false ? 'http' : 'https'}://127.0.0.1:${port}`,
    port,
    requests,
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
