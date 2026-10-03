import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { layoutMap, type MapData } from '../../shared/map'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import type {
  MetricsRange,
  ApplyResult,
  DrainResult,
  MetricsResult,
  HelmRelease,
  HelmReleaseDetail,
  OverviewResult,
  RbacReach,
  RelatedResult,
  TopologyResult,
  RolloutRevision
} from '../../shared/ops'
import type { TrafficSample } from '../../shared/traffic'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const noSpawn: LimitedSpawn = {
  exec: () => Promise.reject(new Error('no')),
  spawn: () => Promise.reject(new Error('no')),
  openPty: () => Promise.reject(new Error('no')),
  available: () => false
}

async function setup(existing?: ApiTestServer): Promise<{
  server: ApiTestServer
  run: <T>(op: unknown) => Promise<T>
  events: { event: string; data: unknown }[]
  until: (pred: () => boolean) => Promise<void>
}> {
  const server = existing ?? (await startApiTestServer())
  if (!existing) cleanups.push(() => server.close())
  const config: ResolvedClusterConfig = {
    name: 't',
    server: server.url,
    ca: TEST_CA,
    insecure: false,
    namespace: 'shop',
    auth: { token: TOKEN }
  }
  const events: { event: string; data: unknown }[] = []
  const s = new K8sService({
    resolve: () => Promise.resolve(config),
    rawConnect: (host, port) =>
      new Promise((resolve, reject) => {
        const socket: Socket = connect({ host, port })
        socket.once('connect', () => {
          resolve(socket)
        })
        socket.once('error', reject)
      }),
    spawn: noSpawn,
    emit: (event, data) => events.push({ event, data }),
    log: () => undefined
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: false })
  const until = async (pred: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { server, run, events, until }
}

describe('K8s — thao tác kiểu k9s / Lens', () => {
  it('metrics: pod (cộng các container) và node; không có metrics-server → available = false', async () => {
    const { server, run } = await setup()
    const pods = await run<MetricsResult>({ op: 'metrics', scope: 'pods', namespace: 'shop' })
    expect(pods.available).toBe(true)
    expect(pods.items['shop/web-1']).toEqual({ cpu: 120, memory: 64 * 1024 * 1024 })
    expect(pods.items['default/tool']).toBeUndefined()
    const nodes = await run<MetricsResult>({ op: 'metrics', scope: 'nodes' })
    expect(nodes.items['node-1']).toEqual({ cpu: 1500, memory: 2 * 1024 ** 3 })
    server.disableMetrics()
    expect(await run<MetricsResult>({ op: 'metrics', scope: 'pods' })).toEqual({
      available: false,
      items: {}
    })
  })

  it('tổng quan: node sẵn sàng, pod theo trạng thái, requests / allocatable / mức dùng, cảnh báo', async () => {
    const { run } = await setup()
    const o = await run<OverviewResult>({ op: 'overview', namespaces: ['shop'] })
    expect(o.version).toBe('v1.31.2')
    expect(o.nodes).toEqual({ total: 2, ready: 1, cordoned: 0 })
    expect(o.capacity).toEqual({ cpu: 8000, memory: 16 * 1024 ** 3 })
    expect(o.pods).toMatchObject({ running: 2, restarting: 1 })
    expect(o.requests).toEqual({ cpu: 500, memory: 256 * 1024 ** 2 })
    expect(o.usage).toEqual({ cpu: 3000, memory: 4 * 1024 ** 3 })
    expect(o.workloads.find((w) => w.kind === 'Deployments')).toEqual({
      kind: 'Deployments',
      total: 1,
      ready: 0
    })
    expect(o.warnings[0]).toMatchObject({ object: 'pod/web-2', reason: 'BackOff' })
  })

  it('liên quan (kiểu Rancher): workload → pod / service / ingress / ConfigMap / Secret (thiếu → báo) / PVC / HPA / PDB / owner; ConfigMap → used by; Service → workload', async () => {
    const { server, run } = await setup()
    const ns = 'shop'
    const meta = (name: string, labels?: Record<string, string>) => ({
      name,
      namespace: ns,
      ...(labels ? { labels } : {})
    })
    server.upsert('configmaps', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: meta('api-config'),
      data: { A: '1', B: '2' }
    })
    server.upsert('secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: meta('api-creds'),
      type: 'Opaque',
      data: { pw: 'eA==' }
    })
    server.upsert('persistentvolumeclaims', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: meta('api-data'),
      spec: { storageClassName: 'fast' },
      status: { phase: 'Bound', capacity: { storage: '10Gi' } }
    })
    server.upsert('deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta('api'),
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'api' } },
        template: {
          metadata: { labels: { app: 'api', tier: 'backend' } },
          spec: {
            serviceAccountName: 'api-sa',
            imagePullSecrets: [{ name: 'regcred' }],
            volumes: [
              { name: 'cfg', configMap: { name: 'api-config' } },
              { name: 'data', persistentVolumeClaim: { claimName: 'api-data' } }
            ],
            containers: [
              {
                name: 'app',
                image: 'api:1',
                env: [
                  { name: 'PW', valueFrom: { secretKeyRef: { name: 'api-creds', key: 'pw' } } }
                ],
                envFrom: [{ secretRef: { name: 'gone' } }]
              }
            ]
          }
        }
      },
      status: { readyReplicas: 2 }
    })
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        ...meta('api-1', { app: 'api', tier: 'backend' }),
        ownerReferences: [{ kind: 'ReplicaSet', name: 'api-rs', controller: true }]
      },
      spec: { containers: [{ name: 'app' }] },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }]
      }
    } as never)
    server.upsert('services', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('api'),
      spec: {
        type: 'ClusterIP',
        clusterIP: '10.0.0.20',
        selector: { app: 'api' },
        ports: [{ port: 80, protocol: 'TCP' }]
      }
    })
    server.upsert('ingresses', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: meta('api'),
      spec: {
        rules: [
          {
            host: 'api.example.com',
            http: {
              paths: [{ path: '/', backend: { service: { name: 'api', port: { number: 80 } } } }]
            }
          }
        ]
      }
    })
    server.upsert('horizontalpodautoscalers', {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: meta('api'),
      spec: { minReplicas: 2, maxReplicas: 6, scaleTargetRef: { kind: 'Deployment', name: 'api' } },
      status: { currentReplicas: 2 }
    })
    server.upsert('poddisruptionbudgets', {
      apiVersion: 'policy/v1',
      kind: 'PodDisruptionBudget',
      metadata: meta('api'),
      spec: {
        minAvailable: 1,
        selector: { matchExpressions: [{ key: 'tier', operator: 'In', values: ['backend'] }] }
      },
      status: { disruptionsAllowed: 1 }
    })

    const r = await run<RelatedResult>({
      op: 'related',
      kind: 'deployments.apps',
      namespace: ns,
      name: 'api'
    })
    const g = (id: string) => r.groups.find((x) => x.id === id)
    expect(g('pods')?.items.map((i) => i.name)).toEqual(['api-1'])
    expect(g('services')?.items).toMatchObject([
      { name: 'api', summary: 'ClusterIP · 10.0.0.20 · 80/TCP' }
    ])
    expect(g('ingresses')?.items).toMatchObject([{ name: 'api', summary: 'api.example.com' }])
    expect(g('configmaps')?.items).toMatchObject([
      { name: 'api-config', summary: '2 keys', tone: 'ok' }
    ])
    expect(g('secrets')?.items).toEqual([
      { kind: 'secrets', name: 'api-creds', summary: 'Opaque · 1 key', tone: 'ok' },
      {
        kind: 'secrets',
        name: 'gone',
        summary: 'Not found in this namespace',
        tone: 'bad',
        missing: true
      },
      {
        kind: 'secrets',
        name: 'regcred',
        summary: 'Not found in this namespace',
        tone: 'bad',
        missing: true
      }
    ])
    expect(g('pvcs')?.items).toMatchObject([{ name: 'api-data', summary: 'Bound · 10Gi · fast' }])
    expect(g('hpas')?.items).toMatchObject([{ name: 'api', summary: '2–6 replicas · now 2' }])
    expect(g('pdbs')?.items).toMatchObject([
      { name: 'api', summary: 'min available 1 · 1 disruptions allowed' }
    ])
    expect(g('sa')?.items).toMatchObject([{ name: 'api-sa' }])
    // Không bao giờ có giá trị Secret trong kết quả.
    expect(JSON.stringify(r)).not.toContain('eA==')

    const pod = await run<RelatedResult>({
      op: 'related',
      kind: 'pods',
      namespace: ns,
      name: 'api-1'
    })
    expect(pod.groups.find((x) => x.id === 'owners')?.items).toMatchObject([
      { kind: 'replicasets.apps', name: 'api-rs', missing: true }
    ])

    const cm = await run<RelatedResult>({
      op: 'related',
      kind: 'configmaps',
      namespace: ns,
      name: 'api-config'
    })
    expect(cm.groups[0]?.items).toMatchObject([
      { kind: 'deployments.apps', name: 'api', summary: 'Deployment · 2/2 ready' }
    ])

    const svc = await run<RelatedResult>({
      op: 'related',
      kind: 'services',
      namespace: ns,
      name: 'api'
    })
    expect(svc.groups.map((x) => [x.id, x.items.map((i) => i.name)])).toEqual([
      ['pods', ['api-1']],
      ['workloads', ['api']],
      ['ingresses', ['api']]
    ])
  })

  it('số đối tượng cho thanh điều hướng (remainingItemCount), Helm releases từ Secret, Argo CD Sync / Refresh', async () => {
    const { server, run } = await setup()
    const counts = await run<Record<string, number | null>>({
      op: 'counts',
      kinds: ['pods', 'services', 'nodes', 'deployments.apps'],
      namespaces: ['shop']
    })
    expect(counts).toEqual({
      pods: server.list('pods').filter((p) => p.metadata.namespace === 'shop').length,
      services: 1,
      nodes: server.list('nodes').length,
      'deployments.apps': 1
    })

    // Helm 3: data.release = base64(base64(gzip(JSON))); mỗi revision một Secret.
    const { gzipSync } = await import('node:zlib')
    const helmSecret = (revision: number, status: string, chartVersion: string) => {
      const record = {
        name: 'shop-db',
        namespace: 'shop',
        version: revision,
        info: {
          status,
          last_deployed: '2026-09-30T10:00:00Z',
          description: `Rev ${revision}`,
          notes: 'Thanks!'
        },
        chart: { metadata: { name: 'postgresql', version: chartVersion, appVersion: '16.4' } },
        config: { auth: { database: 'shop' } },
        manifest: '---\nkind: StatefulSet\n'
      }
      const inner = gzipSync(Buffer.from(JSON.stringify(record))).toString('base64')
      server.upsert('secrets', {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'helm.sh/release.v1',
        metadata: {
          name: `sh.helm.release.v1.shop-db.v${revision}`,
          namespace: 'shop',
          labels: { owner: 'helm', name: 'shop-db', version: String(revision), status }
        },
        data: { release: Buffer.from(inner).toString('base64') }
      })
    }
    helmSecret(1, 'superseded', '15.0.0')
    helmSecret(2, 'deployed', '15.1.0')
    const releases = await run<HelmRelease[]>({ op: 'helm.releases', namespaces: [] })
    expect(releases).toEqual([
      {
        name: 'shop-db',
        namespace: 'shop',
        revision: 2,
        status: 'deployed',
        chart: 'postgresql',
        chartVersion: '15.1.0',
        appVersion: '16.4',
        updated: Date.parse('2026-09-30T10:00:00Z'),
        description: 'Rev 2'
      }
    ])
    const detail = await run<HelmReleaseDetail>({
      op: 'helm.release',
      namespace: 'shop',
      name: 'shop-db'
    })
    expect(detail.values).toContain('database: shop')
    expect(detail.notes).toBe('Thanks!')
    expect(detail.history.map((h) => [h.revision, h.status])).toEqual([
      [2, 'deployed'],
      [1, 'superseded']
    ])

    // Argo CD: Sync ghi `operation`, Refresh ghi annotation; đang sync → không chồng lên.
    server.upsert('applications', {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'shop', namespace: 'shop' },
      spec: {
        project: 'default',
        source: { repoURL: 'https://git/x', path: 'k8s', targetRevision: 'main' }
      }
    })
    await run({ op: 'argoRefresh', namespace: 'shop', name: 'shop', hard: true })
    expect(server.get('applications', 'shop', 'shop')?.metadata).toMatchObject({
      annotations: { 'argocd.argoproj.io/refresh': 'hard' }
    })
    await run({ op: 'argoSync', namespace: 'shop', name: 'shop', prune: true })
    expect(server.get('applications', 'shop', 'shop')).toMatchObject({
      operation: {
        initiatedBy: { username: 'shellhouse' },
        sync: { revision: 'main', prune: true }
      }
    })
    await expect(
      run({ op: 'argoSync', namespace: 'shop', name: 'shop', prune: false })
    ).rejects.toThrow(/already syncing/)
  })

  it('bản đồ: pod quy về workload gốc (qua ReplicaSet / Job → CronJob), service, ingress, PVC, HPA, policy; Gateway API chưa cài → bỏ qua', async () => {
    const { server, run } = await setup()
    const meta = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      namespace: 'shop',
      ...extra
    })
    server.upsert('deployments', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: meta('api'),
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: 'api' } },
        template: {
          metadata: { labels: { app: 'api' } },
          spec: {
            volumes: [{ name: 'd', persistentVolumeClaim: { claimName: 'api-data' } }],
            containers: [{ name: 'c' }]
          }
        }
      },
      status: { readyReplicas: 1 }
    })
    server.upsert('replicasets', {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: meta('api-7d9', {
        ownerReferences: [{ kind: 'Deployment', name: 'api', controller: true }]
      })
    })
    for (const n of ['api-7d9-a', 'api-7d9-b'])
      server.upsert('pods', {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: meta(n, {
          ownerReferences: [{ kind: 'ReplicaSet', name: 'api-7d9', controller: true }]
        }),
        spec: { containers: [{ name: 'c' }], nodeName: 'node-1' },
        status: {
          phase: 'Running',
          containerStatuses: [{ name: 'c', ready: true, restartCount: 1, state: { running: {} } }]
        }
      })
    server.upsert('jobs', {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: meta('nightly-123', {
        ownerReferences: [{ kind: 'CronJob', name: 'nightly', controller: true }]
      }),
      spec: { template: { spec: { containers: [{ name: 'j' }] } } }
    })
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: meta('nightly-123-x', {
        ownerReferences: [{ kind: 'Job', name: 'nightly-123', controller: true }]
      }),
      status: { phase: 'Succeeded' }
    })
    server.upsert('services', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta('api'),
      spec: { selector: { app: 'api' }, ports: [{ port: 80, protocol: 'TCP' }] }
    })
    server.upsert('ingresses', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: meta('api'),
      spec: {
        rules: [
          { host: 'api.example.com', http: { paths: [{ backend: { service: { name: 'api' } } }] } }
        ]
      }
    })
    server.upsert('persistentvolumeclaims', {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: meta('api-data'),
      status: { phase: 'Bound', capacity: { storage: '5Gi' } }
    })
    server.upsert('horizontalpodautoscalers', {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: meta('api'),
      spec: { minReplicas: 2, maxReplicas: 5, scaleTargetRef: { kind: 'Deployment', name: 'api' } },
      status: { currentReplicas: 2 }
    })

    const d = await run<MapData>({ op: 'map', namespaces: ['shop'] })
    // Namespace đang xem đọc kèm nhãn (gom vùng theo nhãn); node kèm cấp phát / dùng thật.
    expect(d.namespaces).toEqual([
      {
        name: 'shop',
        active: true,
        labels: { 'kubernetes.io/metadata.name': 'shop', team: 'commerce' }
      }
    ])
    expect(d.nodeList?.map((n) => [n.name, n.ready])).toEqual([
      ['node-1', true],
      ['node-2', false]
    ])
    expect(d.nodeList?.[0]).toMatchObject({
      allocatable: { cpu: 4000, memory: 8 * 1024 ** 3 },
      usage: { cpu: 1500, memory: 2 * 1024 ** 3 },
      kubelet: 'v1.31.2'
    })
    const api = d.workloads.find((w) => w.name === 'api')
    expect(api).toMatchObject({
      kind: 'deployments.apps',
      ready: 1,
      desired: 2,
      labels: { app: 'api' },
      pvcs: ['api-data']
    })
    // Job của CronJob không thành thẻ riêng; pod của nó thuộc CronJob.
    expect(d.workloads.some((w) => w.name === 'nightly-123')).toBe(false)
    expect(d.pods.find((p) => p.name === 'api-7d9-a')).toMatchObject({
      owner: { kind: 'Deployment', name: 'api' },
      restarts: 1,
      tone: 'ok'
    })
    expect(d.pods.find((p) => p.name === 'nightly-123-x')?.owner).toEqual({
      kind: 'CronJob',
      name: 'nightly'
    })
    expect(d.services.find((x) => x.name === 'api')).toMatchObject({
      selector: { app: 'api' },
      ports: '80/TCP'
    })
    expect(d.routes).toEqual([
      {
        kind: 'ingresses.networking.k8s.io',
        ns: 'shop',
        name: 'api',
        hosts: ['api.example.com'],
        backends: ['api'],
        paths: { api: ['api.example.com/'] },
        // Từng luật host + path → service (Topology: mỗi luật một dòng có đường nối riêng).
        rules: [{ host: 'api.example.com', path: '/', service: 'api' }]
      },
      {
        kind: 'httproutes.gateway.networking.k8s.io',
        ns: 'shop',
        name: 'web',
        hosts: ['shop.example.com'],
        backends: ['web'],
        parents: [{ ns: 'shop', name: 'public' }],
        rules: [{ host: 'shop.example.com', path: '/', service: 'web', port: '80' }]
      }
    ])
    expect(d.gateways).toEqual([
      { ns: 'shop', name: 'public', className: 'nginx', listeners: 'HTTP:80' }
    ])
    // Nhận diện công nghệ theo image (nginx:1.27).
    expect(d.workloads.find((w) => w.name === 'web')?.tech).toBe('nginx')
    expect(d.pvcs).toEqual([
      { ns: 'shop', name: 'api-data', status: 'Bound', capacity: '5Gi', tone: 'ok' }
    ])
    expect(d.hpas[0]).toMatchObject({ target: { kind: 'Deployment', name: 'api' }, min: 2, max: 5 })
    expect(d.nodes.total).toBeGreaterThan(0)
    expect(d.truncated).toBe(false)
    // Đưa thẳng vào bố cục: ingress → service → deployment → PVC.
    const layout = layoutMap(d, { hideSystem: false })
    expect(layout.edges.map((e) => `${e.kind}:${e.from}>${e.to}`)).toEqual(
      expect.arrayContaining([
        'route:r:ingresses.networking.k8s.io:shop/api>s:shop/api',
        'select:s:shop/api>w:deployments.apps:shop/api',
        'storage:w:deployments.apps:shop/api>v:shop/api-data',
        // Gateway → HTTPRoute → Service; NetworkPolicy (podSelector rỗng) áp lên mọi workload.
        'attach:gw:shop/public>r:httproutes.gateway.networking.k8s.io:shop/web',
        'route:r:httproutes.gateway.networking.k8s.io:shop/web>s:shop/web',
        'policy:w:deployments.apps:shop/web>np:shop/default-deny',
        'policy:w:deployments.apps:shop/api>np:shop/default-deny'
      ])
    )
  })

  it('topology: Deployment → ReplicaSet → Pod → Node, traffic, ConfigMap, ServiceAccount → RBAC; mở rộng / người dùng', async () => {
    const { run } = await setup()
    const g = await run<TopologyResult>({
      op: 'topology',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web'
    })
    const id = (kind: string, name: string, ns = 'shop'): string => `${kind}|${ns}|${name}`
    expect(g.root).toBe(id('deployments.apps', 'web'))
    const edges = g.edges.map(
      (e) => `${e.type}:${e.from.split('|')[2] ?? ''}>${e.to.split('|')[2] ?? ''}`
    )
    expect(edges).toEqual(
      expect.arrayContaining([
        'owns:web>web-rs2',
        'owns:web>web-rs1',
        'owns:web-rs2>web-1',
        'owns:web-rs2>web-2',
        'runs-on:web-1>node-1',
        'selects:web>web',
        'routes:web>web',
        'attaches:public>web',
        'uses:web>web-config',
        'identity:web>web-sa',
        'subject:web-sa>web-reader',
        'grants:web-reader>secret-reader',
        'isolates:default-deny>web'
      ])
    )
    // Pod lỗi (CrashLoopBackOff) đứng trước trong nhóm pod; node dùng chung không tự bung ra.
    const node = g.nodes.find((n) => n.id === id('nodes', 'node-1', ''))
    expect(node).toMatchObject({ kindLabel: 'Node', tone: 'ok', expandable: true })
    expect(g.nodes.find((n) => n.id === g.root)?.expandable).toBeUndefined()
    // Role đọc Secret → đỏ.
    expect(g.nodes.find((n) => n.name === 'secret-reader')).toMatchObject({
      tone: 'bad',
      summary: 'Can read secrets (tokens, passwords)'
    })

    // Pod: owner đi lên (ReplicaSet → Deployment) + node.
    const pod = await run<TopologyResult>({
      op: 'topology',
      kind: 'pods',
      namespace: 'shop',
      name: 'web-2'
    })
    expect(
      pod.edges.map((e) => `${e.type}:${e.from.split('|')[2] ?? ''}>${e.to.split('|')[2] ?? ''}`)
    ).toEqual(
      expect.arrayContaining(['owns:web-rs2>web-2', 'owns:web>web-rs2', 'runs-on:web-2>node-1'])
    )

    // ConfigMap: ai dùng nó (sửa thì ảnh hưởng tới đâu).
    const cm = await run<TopologyResult>({
      op: 'topology',
      kind: 'configmaps',
      namespace: 'shop',
      name: 'web-config'
    })
    expect(cm.edges).toEqual([
      { from: id('deployments.apps', 'web'), to: id('configmaps', 'web-config'), type: 'uses' }
    ])

    // Node: workload có pod trên node (gộp theo Deployment nhờ pod-template-hash).
    const n1 = await run<TopologyResult>({ op: 'topology', kind: 'nodes', name: 'node-1' })
    expect(n1.nodes.map((n) => n.name).sort()).toEqual(['node-1', 'tool', 'web-rs2'].sort())

    // RBAC: web-sa đọc được Secret (nhạy cảm), không có quyền khác.
    const reach = await run<RbacReach>({
      op: 'rbacReach',
      namespace: 'shop',
      serviceAccount: 'web-sa'
    })
    expect(reach.bindings).toEqual([
      {
        kind: 'RoleBinding',
        name: 'web-reader',
        namespace: 'shop',
        role: 'secret-reader',
        roleKind: 'Role'
      }
    ])
    expect(reach.grants.map((x) => [x.resource, x.verbs.join(','), x.risk, x.scope])).toEqual([
      ['secrets', 'get,list', 'high', 'shop'],
      ['configmaps', 'get', 'low', 'shop']
    ])
    // Không bao giờ có giá trị Secret.
    expect(JSON.stringify(g)).not.toContain(Buffer.from('s3cr3t').toString('base64'))
  })

  it('traffic (Caretta): không cài → unavailable; không được đọc → lý do; có → link, Service quy về Deployment', async () => {
    const { server, run } = await setup()
    const none = await run<TrafficSample>({ op: 'traffic' })
    expect(none).toMatchObject({
      status: 'unavailable',
      reason: 'Caretta is not installed in this cluster'
    })

    server.enableCaretta({ forbidden: true })
    const denied = await run<TrafficSample>({ op: 'traffic' })
    expect(denied.status).toBe('unavailable')
    expect(denied.reason).toMatch(/not allowed to read its metrics/)

    const t0 = Date.now()
    server.enableCaretta()
    const s = await run<TrafficSample>({ op: 'traffic' })
    const elapsed = (Date.now() - t0) / 1000
    expect(s.status).toBe('ok')
    expect(s.agents).toBe(1)
    const pairs = s.links.map(
      (l) => `${l.client.kind}/${l.client.name}>${l.server.kind}/${l.server.name}:${l.port}`
    )
    // Internet → Service web → quy về Deployment web (selector app=web).
    expect(pairs.sort()).toEqual(
      [
        'external/203.0.113.7>Deployment/web:80',
        'Deployment/web>Pod/tool:8080',
        'Deployment/web>external/db.example.com:5432'
      ].sort()
    )
    // Phía client (role 1) lớn hơn phía server — lấy một, không cộng.
    const toTool = s.links.find((l) => l.server.name === 'tool')
    // Agent giả báo byte = tốc độ × (60 s + thời gian từ lúc cài); cộng hai phía sẽ gần gấp đôi.
    expect(toTool?.bytes).toBeGreaterThan(307_200 * 59)
    expect(toTool?.bytes).toBeLessThanOrEqual(307_200 * (61 + elapsed))
  })

  it('lịch sử rollout + rollback về revision cũ (bỏ pod-template-hash)', async () => {
    const { server, run } = await setup()
    const history = await run<RolloutRevision[]>({
      op: 'rolloutHistory',
      namespace: 'shop',
      name: 'web'
    })
    expect(history.map((h) => [h.revision, h.images[0], h.current])).toEqual([
      [2, 'nginx:1.27', true],
      [1, 'nginx:1.26', false]
    ])
    await run({ op: 'rollback', namespace: 'shop', name: 'web', revision: 1 })
    const template = server.get('deployments', 'shop', 'web')?.spec?.['template'] as {
      metadata: { labels: Record<string, string> }
      spec: { containers: { image: string }[] }
    }
    expect(template.spec.containers[0]?.image).toBe('nginx:1.26')
    expect(template.metadata.labels).toEqual({ app: 'web' })
    await expect(
      run({ op: 'rollback', namespace: 'shop', name: 'web', revision: 9 })
    ).rejects.toThrow(/not found/)
  })

  it('cordon / drain node: evict pod, bỏ qua pod DaemonSet', async () => {
    const { server, run } = await setup()
    await run({ op: 'cordon', node: 'node-2', unschedulable: true })
    expect(server.get('nodes', undefined, 'node-2')?.spec?.['unschedulable']).toBe(true)
    const tool = server.get('pods', 'default', 'tool')
    if (tool)
      (tool.metadata as { ownerReferences?: unknown[] }).ownerReferences = [
        { kind: 'DaemonSet', name: 'agent' }
      ]
    const r = await run<DrainResult>({ op: 'drain', node: 'node-1' })
    expect(r.evicted.sort()).toEqual(['shop/web-1', 'shop/web-2'])
    expect(r.skipped).toEqual(['default/tool'])
    expect(server.get('nodes', undefined, 'node-1')?.spec?.['unschedulable']).toBe(true)
    expect(server.list('pods').map((p) => p.metadata.name)).toEqual(['tool'])
  })

  it('CronJob: chạy ngay (Job thuộc CronJob), tạm dừng', async () => {
    const { server, run } = await setup()
    const job = await run<string>({ op: 'cronTrigger', namespace: 'shop', name: 'nightly' })
    expect(job).toMatch(/^nightly-manual-[0-9a-f]{6}$/)
    const created = server.get('jobs', 'shop', job)
    expect(created?.metadata.labels).toEqual({ job: 'nightly' })
    expect(
      (created?.metadata as { ownerReferences?: { kind: string }[] }).ownerReferences?.[0]?.kind
    ).toBe('CronJob')
    await run({ op: 'cronSuspend', namespace: 'shop', name: 'nightly', suspend: true })
    expect(server.get('cronjobs', 'shop', 'nightly')?.spec?.['suspend']).toBe(true)
  })

  it('server-side apply nhiều tài liệu: tạo mới + cập nhật; tài liệu lỗi không chặn tài liệu khác', async () => {
    const { server, run } = await setup()
    const r = await run<ApplyResult[]>({
      op: 'serverApply',
      yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  mode: prod
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 4
---
apiVersion: nope/v1
kind: Thing
metadata:
  name: x
---
kind: Broken
`
    })
    expect(r.map((x) => [x.object, x.action])).toEqual([
      ['shop/configmap/app-config', 'configured'],
      ['shop/deployment/web', 'configured'],
      ['thing/x', 'error'],
      ['broken/?', 'error']
    ])
    expect(server.get('configmaps', 'shop', 'app-config')?.['data']).toEqual({ mode: 'prod' })
    expect(server.get('deployments', 'shop', 'web')?.spec?.['replicas']).toBe(4)
    expect(server.requests.some((q) => q.includes('fieldManager=shellhouse'))).toBe(true)
  })

  it('log cả workload (theo selector) và mọi container: mỗi dòng có tiền tố pod/container', async () => {
    const { run, events, until } = await setup()
    await run({
      op: 'logs.subscribe',
      namespace: 'shop',
      selector: 'app=web',
      previous: true,
      tail: 10,
      timestamps: false
    })
    await until(() => {
      const text = events
        .filter((e) => e.event === 'logs')
        .map((e) => (e.data as { text: string }).text)
        .join('')
      return (
        text.includes('[web-1/app] log line 1 from web-1') &&
        text.includes('[web-2/app] log line 1 from web-2')
      )
    })
    // Xoá ngay (k9s "kill").
    await run({ op: 'delete', kind: 'pods', namespace: 'shop', name: 'web-1', force: true })
  })

  it('metrics.range: lịch sử CPU / RAM từ Prometheus trong cluster; không có → source none', async () => {
    const { run, server } = await setup()
    const none = await run<MetricsRange>({
      op: 'metrics.range',
      namespace: 'shop',
      pods: ['web-1'],
      minutes: 60
    })
    expect(none.source).toBe('none')
    server.enablePrometheus()
    // Lần dò trước nhớ "không có" 5 phút → phiên mới dò lại.
    const { run: run2 } = await setup(server)
    const r = await run2<MetricsRange>({
      op: 'metrics.range',
      namespace: 'shop',
      pods: ['web-1', 'web-2'],
      minutes: 60
    })
    if (r.source !== 'prometheus') throw new Error(JSON.stringify(r))
    expect(r.via).toBe('monitoring/prometheus-operated')
    expect(r.cpu.map((x) => x.pod).sort()).toEqual(['web-1', 'web-2'])
    expect(r.cpu[0]?.points.length).toBeGreaterThan(100)
    // CPU đổi sang millicore, RAM byte; giá trị thay đổi theo thời gian (không phẳng).
    const cpu = r.cpu[0]?.points.map((x) => x[1]) ?? []
    expect(Math.min(...cpu)).toBeGreaterThan(100)
    expect(Math.max(...cpu) - Math.min(...cpu)).toBeGreaterThan(20)
    expect(r.memory[0]?.points[0]?.[1]).toBeGreaterThan(60 * 1024 * 1024)
  })
})
