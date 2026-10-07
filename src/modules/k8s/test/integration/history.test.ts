import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
import type { HistoryProbe, TrafficRange, TrafficSeries } from '../../shared/history'
import type { TimelineResult } from '../../shared/timeline'
import { startApiTestServer, TEST_CA, TOKEN } from '../api-test-server'

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

async function setup(history?: boolean) {
  const server = await startApiTestServer()
  cleanups.push(() => server.close())
  if (history !== undefined) server.enablePrometheus({ history })
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
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: true })
  return { server, run }
}

const HOUR = 3_600_000

describe('Lịch sử qua Prometheus', () => {
  it('không có Prometheus / Prometheus không thu traffic → lý do rõ ràng, không lỗi', async () => {
    const none = await setup()
    expect(await none.run<HistoryProbe>({ op: 'history.probe' })).toEqual({
      prometheus: null,
      traffic: null,
      events: null
    })
    const end = Date.now()
    const r = await none.run<TrafficRange>({ op: 'traffic.range', start: end - HOUR, end })
    expect(r).toMatchObject({ source: 'none' })
    expect(r.source === 'none' && r.reason).toContain('No Prometheus')

    const bare = await setup(false)
    const probe = await bare.run<HistoryProbe>({ op: 'history.probe' })
    expect(probe).toMatchObject({ prometheus: 'monitoring/prometheus-operated', traffic: null })
    const r2 = await bare.run<TrafficRange>({ op: 'traffic.range', start: end - HOUR, end })
    expect(r2.source === 'none' && r2.reason).toContain('Caretta')
  })

  it('traffic trung bình theo khoảng (Caretta — hai phía không cộng đôi), chuỗi vào / ra của workload', async () => {
    const { run } = await setup(true)
    expect(await run<HistoryProbe>({ op: 'history.probe' })).toEqual({
      prometheus: 'monitoring/prometheus-operated',
      traffic: 'caretta',
      events: { metric: 'kube_events_total', byName: false }
    })
    const end = Date.now()
    const r = await run<TrafficRange>({ op: 'traffic.range', start: end - HOUR, end })
    if (r.source !== 'prometheus') throw new Error(r.reason)
    expect(r.unit).toBe('bytes')
    expect(r.rates).toEqual([
      {
        client: { ns: 'shop', name: 'web', kind: 'Deployment' },
        server: { ns: 'shop', name: 'api', kind: 'Deployment' },
        port: '8080',
        rate: 2048
      }
    ])

    const s = await run<TrafficSeries>({
      op: 'traffic.series',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web',
      start: end - 6 * HOUR,
      end
    })
    if (s.source !== 'prometheus') throw new Error(s.reason)
    expect(s.step).toBe(180_000)
    expect(s.inbound.length).toBeGreaterThan(100)
    // Mỗi thời điểm: phía lớn hơn (client 2048…), không cộng hai phía.
    expect(s.inbound.every(([, v]) => v >= 2048 && v < 2048 + 600)).toBe(true)
    expect(s.outbound.length).toBe(s.inbound.length)
  })

  it('Timeline: số event theo lý do từ Prometheus lấp phần trước event cluster còn giữ', async () => {
    const { run } = await setup(true)
    const r = await run<TimelineResult>({
      op: 'timeline',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web'
    })
    const fromProm = r.entries.filter((e) => e.fromPrometheus)
    expect(fromProm.length).toBeGreaterThan(0)
    expect(fromProm[0]).toMatchObject({
      lane: 'events',
      reason: 'BackOff',
      count: 6,
      severity: 'danger',
      object: { kind: 'Pod', name: '' }
    })
    // Cũ hơn mọi event có nội dung (không trùng với event cluster còn giữ).
    const live = r.entries.filter((e) => e.type === 'event' && !e.fromPrometheus)
    expect(Math.max(...fromProm.map((e) => e.at))).toBeLessThan(Math.min(...live.map((e) => e.at)))
  })
})
