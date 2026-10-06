import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { createModuleDb, migrateModule } from '../../../registry/main-db'
import { k8sMain } from '../../main'
import { EventStore } from '../../main/events'
import { ownedNamePattern, slimEvent, type RecordedEvent } from '../../shared/timeline'

describe('Event thu gọn để ghi', () => {
  it('series / lastTimestamp / eventTime; count tối thiểu 1; thiếu uid hoặc thời điểm → bỏ', () => {
    expect(
      slimEvent({
        metadata: { uid: 'u1', namespace: 'shop', creationTimestamp: '2026-10-06T10:00:00Z' },
        involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'shop' },
        reason: 'BackOff',
        type: 'Warning',
        message: 'Back-off restarting failed container',
        count: 4,
        firstTimestamp: '2026-10-06T10:00:00Z',
        lastTimestamp: '2026-10-06T10:05:00Z'
      })
    ).toEqual({
      uid: 'u1',
      namespace: 'shop',
      kind: 'Pod',
      name: 'web-1',
      reason: 'BackOff',
      type: 'Warning',
      message: 'Back-off restarting failed container',
      count: 4,
      first: Date.parse('2026-10-06T10:00:00Z'),
      last: Date.parse('2026-10-06T10:05:00Z')
    })
    // events.k8s.io kiểu mới: eventTime + series.
    expect(
      slimEvent({
        metadata: { uid: 'u2' },
        involvedObject: { kind: 'Node', name: 'n1' },
        reason: 'NodeNotReady',
        eventTime: '2026-10-06T09:00:00Z',
        series: { count: 9, lastObservedTime: '2026-10-06T09:30:00Z' }
      })
    ).toMatchObject({ count: 9, first: Date.parse('2026-10-06T09:00:00Z'), type: 'Normal' })
    expect(slimEvent({ metadata: {}, lastTimestamp: '2026-10-06T09:00:00Z' })).toBeNull()
    expect(slimEvent({ metadata: { uid: 'x' } })).toBeNull()
  })

  it('tên của pod / ReplicaSet đã xoá thuộc workload', () => {
    const d = ownedNamePattern('deployments.apps', 'web')
    expect(d.test('web-7d9f8c6b5')).toBe(true)
    expect(d.test('web-7d9f8c6b5-x2k4p')).toBe(true)
    expect(d.test('web-admin-7d9f8c6b5-x2k4p')).toBe(false)
    expect(ownedNamePattern('statefulsets.apps', 'db').test('db-0')).toBe(true)
    expect(ownedNamePattern('statefulsets.apps', 'db').test('db-x')).toBe(false)
    expect(ownedNamePattern('daemonsets.apps', 'agent').test('agent-x2k4p')).toBe(true)
    // Tên có ký tự đặc biệt của regex không làm hỏng mẫu.
    expect(ownedNamePattern('daemonsets.apps', 'a.b').test('axb-x2k4p')).toBe(false)
  })
})

describe('Kho event trên máy', () => {
  async function store(now: { t: number }) {
    const db = openDatabase(':memory:')
    await migrate(db, MIGRATIONS)
    migrateModule(db, 'k8s', k8sMain.migrations)
    return { db, events: new EventStore(createModuleDb('k8s', db), () => now.t) }
  }
  const ev = (uid: string, name: string, last: number, over: Partial<RecordedEvent> = {}) => ({
    uid,
    namespace: 'shop',
    kind: 'Pod',
    name,
    reason: 'BackOff',
    type: 'Warning',
    message: 'm',
    count: 1,
    first: last,
    last,
    ...over
  })
  const DAY = 86_400_000

  it('ghi đè theo uid, lọc theo tên / tiền tố / node, cluster tách riêng, giữ 7 ngày', async () => {
    const now = { t: 100 * DAY }
    const { db, events } = await store(now)
    events.record('c1', [ev('a', 'web-1', now.t - DAY), ev('b', 'web-7d9f8c6b5-x2k4p', now.t)])
    events.record('c1', [ev('a', 'web-1', now.t, { count: 5, message: 'new' })])
    events.record('c2', [ev('z', 'web-1', now.t)])
    events.record('c1', [ev('n', 'node-1', now.t, { kind: 'Node', namespace: '' })])
    // Cũ hơn 7 ngày → không ghi.
    events.record('c1', [ev('old', 'web-1', now.t - 8 * DAY)])
    const q = (over: Partial<Parameters<EventStore['query']>[0]> = {}) =>
      events.query({
        cluster: 'c1',
        namespace: 'shop',
        names: ['web-1'],
        prefixes: [],
        nodes: [],
        since: 0,
        ...over
      })
    expect(q().events.map((e) => [e.uid, e.count, e.message])).toEqual([['a', 5, 'new']])
    expect(
      q({ names: [], prefixes: ['web-'] })
        .events.map((e) => e.uid)
        .sort()
    ).toEqual(['a', 'b'])
    // Ký tự đặc biệt của LIKE trong tiền tố không khớp lung tung.
    expect(q({ names: [], prefixes: ['we_'] }).events).toEqual([])
    expect(q({ names: [], nodes: ['node-1'] }).events.map((e) => e.uid)).toEqual(['n'])
    expect(q().recording).toBe(true)
    // 11 phút không có lô / nhịp → không còn coi là đang ghi.
    now.t += 11 * 60_000
    expect(q().recording).toBe(false)
    // 8 ngày sau: dọn hết.
    now.t += 8 * DAY
    events.prune()
    expect(q({ since: 0, names: [], prefixes: ['web-'] }).events).toEqual([])
    events.forget('c2')
    expect((db.prepare('SELECT COUNT(*) AS n FROM k8s_events').get() as { n: number }).n).toBe(0)
    db.close()
  })
})
