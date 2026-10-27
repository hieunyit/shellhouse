import { connect, createServer, type Socket } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { tempDir } from '../../../../../test/unit/helpers'
import type { LimitedSpawn } from '../../../registry/host-types'
import { KubeClient, requestTimeout } from '../../session-host/client'
import { drainRetry } from '../../session-host/operations'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import type { DiscoveredKind, DrainResult, OverviewResult, PortForwardInfo } from '../../shared/ops'
import type { TrafficSample } from '../../shared/traffic'
import { startApiTestServer, TEST_CA, TOKEN, type ApiTestServer } from '../api-test-server'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
const noSpawn: LimitedSpawn = {
  exec: () => Promise.reject(new Error('unused')),
  spawn: () => Promise.reject(new Error('unused')),
  openPty: () => Promise.reject(new Error('unused')),
  available: () => false
}
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture')
  return value
}
async function api(): Promise<ApiTestServer> {
  const server = await startApiTestServer()
  cleanups.push(() => server.close())
  return server
}
const ref = { source: 'file:/audit', context: 'a' }
async function setup(a: ApiTestServer, b = a) {
  const events: { event: string; data: unknown }[] = []
  const service = new K8sService({
    resolve: (target) =>
      Promise.resolve<ResolvedClusterConfig>({
        name: target.context,
        server: (target.context === 'a' ? a : b).url,
        ca: TEST_CA,
        insecure: false,
        namespace: 'shop',
        auth: { token: TOKEN }
      }),
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
    log: () => undefined,
    checkEditFile: () => Promise.resolve(true)
  })
  cleanups.push(() => {
    service.dispose()
  })
  const run = <T>(op: unknown): Promise<T> =>
    service.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref, readOnly: false })
  return {
    service,
    run,
    events,
    switchContext: () => run({ op: 'connect', ref: { ...ref, context: 'b' }, readOnly: false })
  }
}
function onlyWeb(server: ApiTestServer): void {
  server.remove('pods', 'shop', 'web-2')
  server.remove('pods', 'default', 'tool')
  const saved = drainRetry.pollMs
  drainRetry.pollMs = 20
  cleanups.push(() => {
    drainRetry.pollMs = saved
  })
}
async function echo(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error('echo timed out'))
    })
    socket.once('connect', () => socket.write('audit'))
    socket.once('error', reject)
    socket.once('data', (data) => {
      resolve(data.toString())
      socket.destroy()
    })
  })
}

it('drain waits for graceful deletion after the eviction API accepts the request', async () => {
  const server = await api()
  onlyWeb(server)
  server.delayEvictions(400)
  const { run } = await setup(server)
  let finished = false
  const pending = run<DrainResult>({ op: 'drain', node: 'node-1', timeoutSeconds: 3 }).then(
    (result) => {
      finished = true
      return result
    }
  )
  await expect
    .poll(() => server.get('pods', 'shop', 'web-1')?.metadata.deletionTimestamp)
    .toBeTruthy()
  expect(finished).toBe(false)
  const result = await pending
  expect(result).toEqual({ evicted: ['shop/web-1'], skipped: [], failed: [] })
  expect(server.get('pods', 'shop', 'web-1')).toBeUndefined()
})

it('drain waits for pods already Terminating without evicting them again or requiring force', async () => {
  const server = await api()
  onlyWeb(server)
  const pod = must(server.get('pods', 'shop', 'web-1'))
  pod.metadata.deletionTimestamp = new Date().toISOString()
  Reflect.deleteProperty(pod.metadata, 'ownerReferences')
  const { run } = await setup(server)
  const pending = run<DrainResult>({ op: 'drain', node: 'node-1', timeoutSeconds: 3 })
  await expect
    .poll(() => server.requests.some((r) => r.startsWith('GET ') && r.includes('/pods/web-1')))
    .toBe(true)
  expect(server.requests.some((r) => r.includes('/eviction'))).toBe(false)
  server.remove('pods', 'shop', 'web-1')
  expect((await pending).evicted).toEqual(['shop/web-1'])
})

it('drain recognises a replacement UID and leaves the new pod alone', async () => {
  const server = await api()
  onlyWeb(server)
  server.delayEvictions(2000)
  const { run } = await setup(server)
  const pending = run<DrainResult>({ op: 'drain', node: 'node-1', timeoutSeconds: 3 })
  await expect
    .poll(() => server.get('pods', 'shop', 'web-1')?.metadata.deletionTimestamp)
    .toBeTruthy()
  const old = must(server.get('pods', 'shop', 'web-1'))
  const metadata = { ...old.metadata, uid: 'replacement-uid' }
  delete metadata.deletionTimestamp
  server.upsert('pods', {
    ...old,
    metadata
  })
  expect((await pending).evicted).toEqual(['shop/web-1'])
  expect(server.get('pods', 'shop', 'web-1')?.metadata.uid).toBe('replacement-uid')
  expect(
    server.requests.filter((r) => r.startsWith('POST ') && r.includes('/eviction'))
  ).toHaveLength(1)
})

it.each(['terminating', 'stalled eviction'] as const)(
  'drain enforces the overall deadline for %s',
  async (mode) => {
    const server = await api()
    onlyWeb(server)
    if (mode === 'terminating')
      must(server.get('pods', 'shop', 'web-1')).metadata.deletionTimestamp =
        new Date().toISOString()
    else server.stall(/\/eviction$/)
    const { run } = await setup(server)
    const result = await run<DrainResult>({ op: 'drain', node: 'node-1', timeoutSeconds: 1 })
    expect(result.evicted).toEqual([])
    expect(result.failed).toEqual(['shop/web-1: pod did not finish terminating within 1 s'])
  }
)

it('switching context closes the old listener, watch, logs and editor, and emits an empty forward list', async () => {
  const a = await api()
  const b = await api()
  const { run, events, switchContext } = await setup(a, b)
  const [forward] = await run<PortForwardInfo[]>({
    op: 'portForward',
    namespace: 'shop',
    target: 'pod/web-1',
    ports: [[0, 8080]]
  })
  expect(await echo(must(forward).localPort)).toContain('audit')
  await run({ op: 'watch', kind: 'pods', namespace: 'shop', resourceVersion: '1' })
  await run({
    op: 'logs.subscribe',
    namespace: 'shop',
    pod: 'web-1',
    previous: false,
    tail: 10,
    timestamps: false
  })
  const dir = tempDir()
  const path = join(dir, 'config.yml')
  writeFileSync(path, '')
  await run({
    op: 'edit',
    kind: 'configmaps',
    namespace: 'shop',
    name: 'web-config',
    localPath: path
  })
  await expect.poll(() => a.watching('pods')).toBe(1)
  await switchContext()
  expect(await run({ op: 'portForwards' })).toEqual([])
  expect(events.filter((e) => e.event === 'forwards').at(-1)?.data).toEqual([])
  await expect.poll(() => a.watching('pods')).toBe(0)
  await expect(echo(must(forward).localPort)).rejects.toThrow(/ECONNREFUSED/)
  a.requests.length = 0
  const logCount = events.filter((e) => e.event === 'logs').length
  writeFileSync(path, 'invalid edit after context switch')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  expect(a.requests).toEqual([])
  expect(events.filter((e) => e.event === 'logs')).toHaveLength(logCount)
  expect(b.requests.some((r) => r.startsWith('WS '))).toBe(false)
})

it('reconnecting the same context for read-only mode preserves forwards and watches', async () => {
  const server = await api()
  const { run } = await setup(server)
  const [forward] = await run<PortForwardInfo[]>({
    op: 'portForward',
    namespace: 'shop',
    target: 'pod/web-1',
    ports: [[0, 8080]]
  })
  await run({ op: 'discover', namespace: 'shop' })
  await run({ op: 'watch', kind: 'pods', namespace: 'shop', resourceVersion: '1' })
  await expect.poll(() => server.watching('pods')).toBe(1)
  await run({ op: 'connect', ref, readOnly: true })
  expect(await run<PortForwardInfo[]>({ op: 'portForwards' })).toHaveLength(1)
  expect(server.watching('pods')).toBe(1)
  expect(await echo(must(forward).localPort)).toContain('audit')
  expect(
    (await run<DiscoveredKind[]>({ op: 'discover', namespace: 'shop' })).some(
      (k) => k.id === 'widgets.example.com'
    )
  ).toBe(true)
})

it('failed multi-port creation rolls back new listeners and preserves existing forwards', async () => {
  const { run, events } = await setup(await api())
  const existing = await run<PortForwardInfo[]>({
    op: 'portForward',
    namespace: 'shop',
    target: 'pod/web-1',
    ports: [[0, 8080]]
  })
  const busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        busy.close(() => {
          resolve()
        })
      })
  )
  const port = (busy.address() as { port: number }).port
  await expect(
    run({
      op: 'portForward',
      namespace: 'shop',
      target: 'pod/web-1',
      ports: [
        [0, 8080],
        [port, 8080]
      ]
    })
  ).rejects.toThrow(/EADDRINUSE/)
  expect(await run({ op: 'portForwards' })).toEqual(existing)
  expect(events.filter((e) => e.event === 'forwards').at(-1)?.data).toEqual(existing)
  expect(await echo(must(existing[0]).localPort)).toContain('audit')
})

it('switching context reloads discovery and RBAC and drops old custom kinds', async () => {
  const a = await api()
  const b = await api()
  b.forbid(/^\/apis\/example.com\/v1$/)
  const { run, switchContext } = await setup(a, b)
  expect(
    (await run<DiscoveredKind[]>({ op: 'discover', namespace: 'shop' })).some(
      (k) => k.id === 'widgets.example.com'
    )
  ).toBe(true)
  await switchContext()
  const kinds = await run<DiscoveredKind[]>({ op: 'discover', namespace: 'shop' })
  expect(kinds.some((k) => k.id === 'widgets.example.com')).toBe(false)
  expect(b.requests).toContain('GET /apis')
  expect(b.requests.some((r) => r.includes('selfsubjectaccessreviews'))).toBe(true)
  await expect(
    run({ op: 'list', kind: 'widgets.example.com', namespace: 'shop', limit: 1 })
  ).rejects.toThrow(/Unknown resource type/)
})

it('a forward still resolving its service cannot open a listener after a context switch', async () => {
  const { run, switchContext } = await setup(await api(), await api())
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original receiver via apply below.
  const original = KubeClient.prototype.json
  let release!: () => void
  let held = false
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(KubeClient.prototype, 'json').mockImplementation(async function <T>(
    this: KubeClient,
    ...args: Parameters<KubeClient['json']>
  ): Promise<T> {
    const value = (await original.apply(this, args)) as T
    if (args[1] === '/api/v1/namespaces/shop/services/web') {
      held = true
      await delayed
    }
    return value
  })
  const pending = run({
    op: 'portForward',
    namespace: 'shop',
    target: 'service/web',
    ports: [[0, 80]]
  })
  const rejected = expect(pending).rejects.toThrow(/Cancelled|connection changed/)
  await expect.poll(() => held).toBe(true)
  await switchContext()
  release()
  await rejected
  expect(await run({ op: 'portForwards' })).toEqual([])
})

it('discovery finishing after a context switch cannot repopulate the new catalog', async () => {
  const a = await api()
  const b = await api()
  b.forbid(/^\/apis\/example.com\/v1$/)
  const { run, switchContext } = await setup(a, b)
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original receiver via apply below.
  const original = KubeClient.prototype.json
  let release!: (value: unknown) => void
  let held = false
  const delayed = new Promise((resolve) => {
    release = resolve
  })
  vi.spyOn(KubeClient.prototype, 'json').mockImplementation(async function <T>(
    this: KubeClient,
    ...args: Parameters<KubeClient['json']>
  ): Promise<T> {
    if (!held && args[1] === '/apis/example.com/v1') {
      held = true
      return (await delayed) as T
    }
    return original.apply(this, args) as Promise<T>
  })
  const old = run({ op: 'discover', namespace: 'shop' })
  await expect.poll(() => held).toBe(true)
  await switchContext()
  expect(
    (await run<DiscoveredKind[]>({ op: 'discover', namespace: 'shop' })).some(
      (k) => k.id === 'widgets.example.com'
    )
  ).toBe(false)
  release({ resources: [{ name: 'widgets', kind: 'Widget', namespaced: true, verbs: ['list'] }] })
  await old.catch(() => undefined)
  expect(
    (await run<DiscoveredKind[]>({ op: 'discover', namespace: 'shop' })).some(
      (k) => k.id === 'widgets.example.com'
    )
  ).toBe(false)
})

it('traffic does not reuse Caretta agents and counters from the previous cluster', async () => {
  const a = await api()
  const b = await api()
  a.enableCaretta()
  const { run, switchContext } = await setup(a, b)
  expect((await run<TrafficSample>({ op: 'traffic' })).status).toBe('ok')
  await switchContext()
  expect((await run<TrafficSample>({ op: 'traffic' })).status).toBe('unavailable')
  expect(b.requests.some((r) => r.includes('caretta-agent-1:7117'))).toBe(false)
})

it('Overview distinguishes forbidden resource groups from empty lists and recovers on refresh', async () => {
  const server = await api()
  const { run } = await setup(server)
  server.forbid(/\/(deployments|events|persistentvolumeclaims)$/)
  const partial = await run<OverviewResult>({ op: 'overview', namespaces: ['shop'] })
  expect(partial.workloads.find((w) => w.kind === 'Deployments')).toMatchObject({ known: false })
  expect(partial.unavailable?.map((u) => [u.resource, u.reason]).sort()).toEqual([
    ['deployments', 'forbidden'],
    ['events', 'forbidden'],
    ['pvcs', 'forbidden']
  ])
  server.forbid(null)
  const full = await run<OverviewResult>({ op: 'overview', namespaces: ['shop'] })
  expect(full.unavailable).toBeUndefined()
  expect(full.workloads.find((w) => w.kind === 'Deployments')?.total).toBe(1)
})

it('Overview reports a failing API as unavailable rather than empty or forbidden', async () => {
  const server = await api()
  const { run } = await setup(server)
  const saved = requestTimeout.idleMs
  requestTimeout.idleMs = 300
  cleanups.push(() => {
    requestTimeout.idleMs = saved
  })
  server.stall(/\/deployments$/)
  const data = await run<OverviewResult>({ op: 'overview', namespaces: ['shop'] })
  expect(data.unavailable).toHaveLength(1)
  expect(data.unavailable?.[0]).toMatchObject({ resource: 'deployments', reason: 'error' })
  expect(data.unavailable?.[0]?.message).toContain('did not answer')
  expect(data.workloads.find((w) => w.kind === 'Deployments')?.known).toBe(false)
})
