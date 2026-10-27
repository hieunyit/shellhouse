import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { templateRefs } from '../../session-host/map'
import { buildTopology } from '../../shared/appTopology'
import type { TrafficSample } from '../../shared/traffic'
import { writeMessage } from '../../session-host/protobuf'
import { hubbleFlow } from '../hubble-flows'
import type { TopologyResult } from '../../shared/ops'
import type { MapData } from '../../shared/map'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

/**
 * Topology tĩnh đi trọn đường: API server giả (cluster mẫu) → Session Host (op "map") → đồ thị +
 * vấn đề + bố cục. Kiểm dữ liệu mới (cổng, EndpointSlice, luật Ingress, TLS, tham chiếu config) và
 * các lỗi cấu hình được chỉ ra bằng lời.
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
    emit: () => undefined,
    log: () => undefined
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: false })
  return { server, run }
}

const OPTS = {
  hideSystem: true,
  showDeps: true,
  expanded: new Set<string>(),
  collapsed: () => false,
  showAll: new Set<string>()
}

describe('Map and collector coverage regressions', () => {
  it('keeps denied Services, Nodes and PVCs unknown on the application map', async () => {
    const { server, run } = await setup()
    server.seedDemo()
    server.forbid(/\/(services|nodes|persistentvolumeclaims)$/)
    const d = await run<MapData>({ op: 'map', namespaces: ['shop'] })
    expect(d.nodes.known).toBe(false)
    expect(d.nodeList).toBeUndefined()
    expect(
      d.coverage
        ?.filter((c) => c.reason === 'forbidden')
        .map((c) => c.kind)
        .sort()
    ).toEqual(['nodes', 'persistentvolumeclaims', 'services'])
    const graph = buildTopology(d, OPTS)
    expect(
      graph.problems.some((p) =>
        ['ing-missing-svc', 'svc-missing', 'pvc-missing'].includes(p.problem.code)
      )
    ).toBe(false)
    expect(graph.nodes.some((n) => n.kind === 'service' && n.missing)).toBe(false)
    expect(graph.nodes.find((n) => n.name === 'web' && n.kind === 'service')?.tone).toBe('muted')
    expect(graph.edges.some((e) => e.kind === 'route' && e.broken)).toBe(false)
  })
  it('does not call a forbidden owner GET a missing resource', async () => {
    const { server, run } = await setup()
    server.forbid(/\/replicasets\//)
    const graph = await run<TopologyResult>({
      op: 'topology',
      kind: 'pods',
      namespace: 'shop',
      name: 'web-1'
    })
    const parent = graph.nodes.find((n) => n.kind === 'replicasets.apps')
    expect(parent?.tone).toBe('muted')
    expect(parent?.missing).toBeUndefined()
    expect(graph.notes.join(' ')).toContain('Not allowed')
  })
  it('preserves measured Caretta Service totals without fabricating per-workload shares', async () => {
    const { server, run } = await setup()
    const web = server.get('deployments', 'shop', 'web')
    if (!web) throw new Error('fixture')
    server.upsert('deployments', { ...web, metadata: { ...web.metadata, name: 'web-canary' } })
    server.enableCaretta()
    const sample = await run<TrafficSample>({ op: 'traffic' })
    const incoming = sample.links.filter((l) => l.client.kind === 'external')
    expect(incoming).toHaveLength(1)
    expect(incoming[0]?.server).toEqual({ kind: 'Service', ns: 'shop', name: 'web' })
  })
  it('exposes lost events and unavailable Hubble nodes, handles stream EOF', async () => {
    const { server, run } = await setup()
    server.enableHubble()
    const first = await run<TrafficSample>({ op: 'traffic' })
    expect(first.status).toBe('connecting')
    expect(first.unit).toBe('observations')
    await expect.poll(() => server.hubbleStreams()).toBe(1)
    server.emitHubbleResponse(
      writeMessage([
        [
          3,
          [
            [1, 3],
            [2, 100]
          ]
        ]
      ])
    )
    server.emitHubbleResponse(
      writeMessage([
        [
          2,
          [
            [1, 2],
            [2, 'node-2']
          ]
        ]
      ])
    )
    await expect
      .poll(async () => (await run<TrafficSample>({ op: 'traffic' })).quality?.lostEvents)
      .toBe(100)
    const sample = await run<TrafficSample>({ op: 'traffic' })
    expect(sample.quality?.partial).toBe(true)
    expect(sample.quality?.unavailableNodes).toEqual(['node-2'])
    server.emitHubbleResponse(
      writeMessage([
        [
          2,
          [
            [1, 1],
            [2, 'node-2']
          ]
        ]
      ])
    )
    await expect
      .poll(async () => (await run<TrafficSample>({ op: 'traffic' })).quality?.unavailableNodes)
      .toEqual([])
    server.endHubbleStreams()
    await expect
      .poll(async () => (await run<TrafficSample>({ op: 'traffic' })).status)
      .toBe('unavailable')
    expect((await run<TrafficSample>({ op: 'traffic' })).reason).toContain('stream ended')
    const resumedAt = Date.now() + 31_000
    vi.spyOn(Date, 'now').mockReturnValue(resumedAt)
    await run<TrafficSample>({ op: 'traffic' })
    await expect.poll(() => server.hubbleStreams()).toBe(1)
    await expect.poll(async () => (await run<TrafficSample>({ op: 'traffic' })).status).toBe('ok')
  })
  it('reports incomplete Caretta agent coverage while retaining positive measurements', async () => {
    const { server, run } = await setup()
    server.enableCaretta()
    const agent = server.get('pods', 'caretta', 'caretta-agent-1')
    if (!agent) throw new Error('fixture')
    server.upsert('pods', { ...agent, metadata: { ...agent.metadata, name: 'caretta-agent-2' } })
    const sample = await run<TrafficSample>({ op: 'traffic' })
    expect(sample.status).toBe('ok')
    expect(sample.agents).toBe(1)
    expect(sample.quality?.partial).toBe(true)
    expect(sample.quality?.expectedAgents).toBe(2)
    expect(sample.links.length).toBeGreaterThan(0)
  })
  it('counts UDP as observations and deduplicates replayed UUIDs', async () => {
    const { server, run } = await setup()
    server.enableHubble()
    await run({ op: 'traffic' })
    await expect.poll(() => server.hubbleStreams()).toBe(1)
    const flow = hubbleFlow({
      from: { ns: 'shop', pod: 'web-1' },
      to: { ip: '1.1.1.1' },
      port: 53,
      packet: 'udp'
    })
    for (let i = 0; i < 5; i++) server.emitFlow(flow)
    const identified = Buffer.concat([flow, writeMessage([[34, 'unique-uuid']])])
    server.emitFlow(identified)
    server.emitFlow(identified)
    await expect
      .poll(async () => (await run<TrafficSample>({ op: 'traffic' })).links[0]?.bytes)
      .toBe(6)
  })
})

it('ignores completed init-container ports but accepts restartable sidecar ports', () => {
  const refs = templateRefs({
    spec: {
      initContainers: [
        { name: 'migrate', ports: [{ name: 'db', containerPort: 5432 }] },
        { name: 'proxy', restartPolicy: 'Always', ports: [{ name: 'proxy', containerPort: 8081 }] }
      ],
      containers: [{ name: 'app', ports: [{ name: 'http', containerPort: 8080 }] }]
    }
  })
  expect(refs.ports.map((p) => p.name).sort()).toEqual(['http', 'proxy'])
})

it('preserves Gateway API backend namespace and weight in map data', async () => {
  const { server, run } = await setup()
  server.upsert('httproutes', {
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: { namespace: 'shop', name: 'cross' },
    spec: {
      hostnames: ['shop.example.com'],
      rules: [{ backendRefs: [{ name: 'api', namespace: 'backend', port: 80, weight: 25 }] }]
    }
  })
  const map = await run<MapData>({ op: 'map', namespaces: ['shop'] })
  expect(map.routes.find((r) => r.name === 'cross')?.rules).toEqual([
    {
      host: 'shop.example.com',
      path: '/',
      service: 'api',
      namespace: 'backend',
      port: '80',
      weight: 25
    }
  ])
})

it('does not report optional volume and projected references as missing dependencies', () => {
  const refs = templateRefs({
    spec: {
      volumes: [
        { configMap: { name: 'optional-cm', optional: true } },
        { secret: { secretName: 'optional-secret', optional: true } },
        {
          projected: {
            sources: [
              { configMap: { name: 'optional-projected-cm', optional: true } },
              { secret: { name: 'required-secret' } }
            ]
          }
        }
      ]
    }
  })
  expect(refs.configMaps).toEqual([])
  expect(refs.secrets).toEqual(['required-secret'])
})
