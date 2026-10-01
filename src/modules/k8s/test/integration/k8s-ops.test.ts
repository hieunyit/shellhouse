import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import type {
  ApplyResult,
  DrainResult,
  MetricsResult,
  OverviewResult,
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
