import { describe, expect, it } from 'vitest'
import {
  containerApplies,
  containerBulkOp,
  mapLimit,
  pullRefs,
  runBulk,
  selectAllState,
  splitTargets,
  toggleAll,
  toggleKey,
  type BulkResult
} from '../../shared/bulk'
import { DockerOp, type ContainerRow } from '../../shared/ops'
import { groupProjects, worstHealth } from '../../shared/view-model'

function row(name: string, extra: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: `${name}-id`,
    name,
    image: 'nginx',
    state: 'running',
    status: 'Up',
    health: null,
    created: 0,
    ports: [],
    project: null,
    service: null,
    composeDir: null,
    composeFiles: null,
    ...extra
  }
}

const KEYS = ['a', 'b', 'c', 'd', 'e']

describe('chọn nhiều dòng', () => {
  it('ô chọn tất cả: ba trạng thái theo các dòng đang hiện (dòng bị lọc ẩn không tính)', () => {
    expect(selectAllState(KEYS, new Set())).toBe('none')
    expect(selectAllState(KEYS, new Set(['b']))).toBe('some')
    expect(selectAllState(KEYS, new Set(KEYS))).toBe('all')
    // "z" đã chọn nhưng bị lọc ẩn → vẫn tính là chọn hết các dòng đang hiện.
    expect(selectAllState(['a', 'b'], new Set(['a', 'b', 'z']))).toBe('all')
    expect(selectAllState([], new Set(['a']))).toBe('none')
  })

  it('bấm chọn tất cả: chọn hết → bỏ hết; một phần → chọn hết', () => {
    expect([...toggleAll(KEYS, new Set(['a']))]).toEqual(KEYS)
    expect(toggleAll(KEYS, new Set(KEYS)).size).toBe(0)
  })

  it('bấm một ô: bật / tắt riêng dòng đó', () => {
    expect([...toggleKey(KEYS, new Set(['a']), 'c', null, false)].sort()).toEqual(['a', 'c'])
    expect([...toggleKey(KEYS, new Set(['a', 'c']), 'c', 'a', false)]).toEqual(['a'])
  })

  it('Shift+bấm: cả khoảng từ mốc nhận trạng thái mới của dòng được bấm (hai chiều)', () => {
    expect([...toggleKey(KEYS, new Set(['b']), 'd', 'b', true)].sort()).toEqual(['b', 'c', 'd'])
    expect([...toggleKey(KEYS, new Set(['d']), 'a', 'd', true)].sort()).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
    // Dòng được bấm đang chọn → bỏ chọn cả khoảng, ngoài khoảng giữ nguyên.
    expect([...toggleKey(KEYS, new Set(KEYS), 'd', 'b', true)].sort()).toEqual(['a', 'e'])
    // Mốc không còn hiện (bị lọc) → chỉ dòng được bấm.
    expect([...toggleKey(KEYS, new Set(), 'c', 'zz', true)]).toEqual(['c'])
  })
})

describe('thao tác hàng loạt trên container', () => {
  const running = row('web')
  const exited = row('job', { state: 'exited' })
  const paused = row('cache', { state: 'paused' })
  const created = row('new', { state: 'created' })

  it('chỉ áp dụng cho container ở trạng thái hợp lệ', () => {
    const states = (kind: Parameters<typeof containerApplies>[0]): string[] =>
      [running, exited, paused, created].filter((c) => containerApplies(kind, c)).map((c) => c.name)
    expect(states('start')).toEqual(['job', 'new'])
    expect(states('stop')).toEqual(['web'])
    expect(states('restart')).toEqual(['web', 'job', 'new'])
    expect(states('pause')).toEqual(['web'])
    expect(states('unpause')).toEqual(['cache'])
    expect(states('kill')).toEqual(['web', 'cache'])
    expect(states('remove')).toEqual(['web', 'job', 'cache', 'new'])
  })

  it('tách mục chạy / bỏ qua, giữ thứ tự', () => {
    const { targets, skipped } = splitTargets([running, exited, paused], (c) =>
      containerApplies('stop', c)
    )
    expect(targets.map((c) => c.name)).toEqual(['web'])
    expect(skipped.map((c) => c.name)).toEqual(['job', 'cache'])
  })

  it('lệnh gửi Session Host hợp lệ; xoá container còn chạy / pause → force; -v tuỳ chọn', () => {
    const op = containerBulkOp('remove', running, { volumes: true })
    expect(op).toEqual({ op: 'action', id: 'web-id', action: 'remove', force: true, volumes: true })
    expect(DockerOp.safeParse(op).success).toBe(true)
    expect(containerBulkOp('remove', paused)).toMatchObject({ force: true })
    expect(containerBulkOp('remove', exited)).toEqual({
      op: 'action',
      id: 'job-id',
      action: 'remove',
      force: false
    })
    expect(containerBulkOp('unpause', paused)).toEqual({
      op: 'action',
      id: 'cache-id',
      action: 'unpause'
    })
  })

  it('pull: mọi tag không trùng, bỏ image không tag', () => {
    expect(
      pullRefs([{ tags: ['a:1', 'a:latest'] }, { tags: [] }, { tags: ['a:1', 'b:2'] }])
    ).toEqual(['a:1', 'a:latest', 'b:2'])
  })
})

describe('chạy hàng loạt', () => {
  it('mapLimit: không quá giới hạn việc cùng lúc, kết quả đúng thứ tự', async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, n * 2))
      active--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBe(2)
    expect(await mapLimit([], 4, () => Promise.resolve(1))).toEqual([])
  })

  it('lỗi một mục không dừng mục khác; báo kết quả từng mục ngay khi xong', async () => {
    const seen: BulkResult[] = []
    const results = await runBulk(['a', 'b', 'c'], {
      key: (x) => x,
      run: (x) => (x === 'b' ? Promise.reject(new Error('conflict: in use')) : Promise.resolve()),
      onResult: (r) => seen.push(r)
    })
    expect(results).toEqual([
      { key: 'a', ok: true },
      { key: 'b', ok: false, error: 'conflict: in use' },
      { key: 'c', ok: true }
    ])
    expect(seen).toHaveLength(3)
  })

  it('huỷ giữa chừng: mục chưa bắt đầu bị bỏ qua, không gửi lệnh', async () => {
    let cancelled = false
    const ran: string[] = []
    const results = await runBulk(['a', 'b', 'c', 'd'], {
      key: (x) => x,
      parallel: 1,
      isCancelled: () => cancelled,
      run: (x) => {
        ran.push(x)
        if (x === 'b') cancelled = true
        return Promise.resolve()
      }
    })
    expect(ran).toEqual(['a', 'b'])
    expect(results.filter((r) => r.skipped).map((r) => r.key)).toEqual(['c', 'd'])
  })
})

describe('Compose project', () => {
  it('service, replica, healthcheck gộp, thư mục / file cấu hình, lần cập nhật, trạng thái', () => {
    const list = [
      row('shop-web-1', {
        project: 'shop',
        service: 'web',
        health: 'healthy',
        created: 1000,
        composeDir: '/srv/shop',
        composeFiles: '/srv/shop/compose.yaml, /srv/shop/compose.prod.yaml',
        ports: [{ ip: '0.0.0.0', privatePort: 80, publicPort: 8080, type: 'tcp' }]
      }),
      row('shop-web-2', { project: 'shop', service: 'web', health: 'unhealthy', created: 3000 }),
      row('shop-db-1', { project: 'shop', service: 'db', state: 'exited', image: 'postgres:16' })
    ]
    const [p] = groupProjects(list, '')
    expect(p).toMatchObject({
      name: 'shop',
      services: 2,
      running: 2,
      workingDir: '/srv/shop',
      configFiles: ['/srv/shop/compose.yaml', '/srv/shop/compose.prod.yaml'],
      updated: 3000,
      unhealthy: 1,
      status: 'partial'
    })
    expect(p?.serviceList.map((s) => [s.name, s.image, s.running, s.containers.length])).toEqual([
      ['db', 'postgres:16', 0, 1],
      ['web', 'nginx', 2, 2]
    ])
    expect(p?.serviceList[1]).toMatchObject({ health: 'unhealthy', ports: '8080→80/tcp' })
    // Lọc theo tên service / image.
    expect(groupProjects(list, 'postgres').map((x) => x.name)).toEqual(['shop'])
    expect(groupProjects(list, 'nope')).toEqual([])
  })

  it('healthcheck xấu nhất', () => {
    expect(worstHealth(['healthy', 'starting'])).toBe('starting')
    expect(worstHealth(['healthy', 'unhealthy', 'starting'])).toBe('unhealthy')
    expect(worstHealth([null, 'healthy'])).toBe('healthy')
    expect(worstHealth([null])).toBe(null)
  })
})
