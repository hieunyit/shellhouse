import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LimitedSpawn } from '../../../registry/host-types'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { createModuleDb, migrateModule } from '../../../registry/main-db'
import { k8sMain } from '../../main'
import { EventStore } from '../../main/events'
import { K8sService, type ResolvedClusterConfig } from '../../session-host/service'
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

async function setup() {
  const server = await startApiTestServer()
  cleanups.push(() => server.close())
  const db = openDatabase(':memory:')
  cleanups.push(() => {
    db.close()
  })
  await migrate(db, MIGRATIONS)
  migrateModule(db, 'k8s', k8sMain.migrations)
  const store = new EventStore(createModuleDb('k8s', db))
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
    log: () => undefined,
    recordEvents: (cluster, events) => {
      store.record(cluster, events)
      return Promise.resolve()
    },
    queryEvents: (q) => Promise.resolve(store.query(q))
  })
  cleanups.push(() => {
    s.dispose()
  })
  const run = <T>(op: unknown): Promise<T> => s.run(op, new AbortController().signal) as Promise<T>
  await run({ op: 'connect', ref: { source: 'file:/x', context: 't' }, readOnly: true })
  const until = async (pred: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const stored = (): string[] =>
    store
      .query({
        cluster: 'file:/x#t',
        namespace: 'shop',
        names: ['web-2'],
        prefixes: [],
        nodes: [],
        since: 0
      })
      .events.map((e) => e.reason)
  return { server, run, until, stored }
}

describe('Timeline + ghi event về máy', () => {
  it('ghi event (list rồi watch), Timeline gộp rollout / container chết / event — cả event cluster đã xoá', async () => {
    const { server, run, until, stored } = await setup()
    const crashedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    server.upsert('pods', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-2', namespace: 'shop', labels: { app: 'web' } },
      spec: { containers: [{ name: 'app', image: 'nginx:1.27' }], nodeName: 'node-1' },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'app',
            ready: false,
            restartCount: 7,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: {
              terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: crashedAt }
            }
          }
        ]
      }
    })

    // Bật ghi: event có sẵn (list) vào kho; event mới (watch) cũng vào.
    await run({ op: 'events.record', on: true })
    await until(() => stored().includes('BackOff'))
    // Event mới phải tới SAU khi watch đã mở: server giả không phát lại theo resourceVersion (máy bận
    // thì watch mở chậm hơn lần upsert → event bị lỡ, test chập chờn).
    await until(() => server.watching('events') > 0)
    server.upsert('events', {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: 'ev2', namespace: 'shop' },
      type: 'Warning',
      reason: 'Unhealthy',
      message: 'Readiness probe failed: connection refused',
      involvedObject: { kind: 'Pod', name: 'web-2', namespace: 'shop' },
      count: 3,
      lastTimestamp: new Date().toISOString()
    })
    await until(() => stored().includes('Unhealthy'))
    // Cluster xoá event cũ (hết hạn ~1 giờ) — bản ghi trên máy vẫn còn.
    server.remove('events', 'shop', 'ev1')

    const r = await run<TimelineResult>({
      op: 'timeline',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web'
    })
    expect(r.recording).toBe(true)
    // ReplicaSet giả tạo cùng lúc — xếp theo revision để so.
    const rollouts = r.entries
      .filter((e) => e.type === 'rollout')
      .sort((x, y) => Number(y.revision) - Number(x.revision))
    expect(rollouts.map((e) => [e.revision, e.images, e.previousImages])).toEqual([
      ['2', ['nginx:1.27'], ['nginx:1.26']],
      ['1', ['nginx:1.26'], undefined]
    ])
    const crash = r.entries.find((e) => e.type === 'container-terminated')
    expect(crash).toMatchObject({
      object: { kind: 'Pod', name: 'web-2' },
      container: 'app',
      reason: 'OOMKilled',
      exitCode: 137,
      severity: 'danger',
      at: Date.parse(crashedAt)
    })
    const events = r.entries.filter((e) => e.type === 'event')
    expect(events.find((e) => e.reason === 'BackOff')).toMatchObject({
      recorded: true,
      severity: 'danger'
    })
    expect(events.find((e) => e.reason === 'Unhealthy')).toMatchObject({ count: 3 })
    expect(events.find((e) => e.reason === 'Unhealthy')?.recorded).toBeUndefined()
    // Mới nhất trước.
    const times = r.entries.map((e) => e.at)
    expect([...times].sort((a, b) => b - a)).toEqual(times)

    // Tắt ghi → main không còn coi là đang ghi sau một lúc (ở đây: kiểm op trả về).
    expect(await run<{ recording: boolean }>({ op: 'events.record', on: false })).toEqual({
      recording: false
    })
  }, 30_000)

  it('không bật ghi: Timeline vẫn có dữ liệu sống, báo chưa ghi', async () => {
    const { run } = await setup()
    const r = await run<TimelineResult>({
      op: 'timeline',
      kind: 'deployments.apps',
      namespace: 'shop',
      name: 'web'
    })
    expect(r.recording).toBe(false)
    expect(r.entries.some((e) => e.type === 'rollout')).toBe(true)
    expect(r.entries.some((e) => e.type === 'event' && e.reason === 'BackOff')).toBe(true)
  })
})
