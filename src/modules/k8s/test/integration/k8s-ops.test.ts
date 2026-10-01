import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import type {
  ApplyResult,
  DrainResult,
  MetricsResult,
  HelmRelease,
  HelmReleaseDetail,
  OverviewResult,
  RelatedResult,
  RolloutRevision
} from '../../shared/ops'
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

async function setup(): Promise<{
  server: ApiTestServer
  run: <T>(op: unknown) => Promise<T>
  events: { event: string; data: unknown }[]
  until: (pred: () => boolean) => Promise<void>
}> {
  const server = await startApiTestServer()
  cleanups.push(() => server.close())
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
})
