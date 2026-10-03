import { describe, expect, it } from 'vitest'
import { cellTone, filterRows, sortRows, type Row } from '../../shared/rows'
import { relabelLayout, topologyStructureKey } from '../../shared/topologyView'
import { applyWatchEvents, mapLimit } from '../../shared/watch'
import type { TopologyEdge, TopologyNode } from '../../shared/ops'
import { layoutTopology } from '../../shared/topology'
import type { K8sObject } from '../../shared/resources'

const obj = (name: string, namespace?: string): K8sObject => ({
  metadata: { name, ...(namespace ? { namespace } : {}) }
})

const row = (name: string, namespace: string, created: number, cells = {}): Row => ({
  obj: obj(name, namespace),
  row: {
    key: `${namespace}/${name}`,
    name,
    namespace,
    cells,
    tone: 'ok',
    created
  }
})

describe('bảng tài nguyên: màu ô, lọc, sắp xếp', () => {
  it('Restarts > 0 cảnh báo, > 5 nguy hiểm; Ready thiếu → cảnh báo / 0 → nguy hiểm', () => {
    expect(cellTone('restarts', '0', 'ok')).toBeNull()
    expect(cellTone('restarts', '1', 'ok')).toBe('warn')
    expect(cellTone('restarts', '5', 'ok')).toBe('warn')
    expect(cellTone('restarts', '6', 'ok')).toBe('bad')
    expect(cellTone('ready', '1/1', 'ok')).toBeNull()
    expect(cellTone('ready', '1/3', 'ok')).toBe('warn')
    expect(cellTone('ready', '0/1', 'bad')).toBe('bad')
    // Pod Job đã xong: 0/1 là bình thường.
    expect(cellTone('ready', '0/1', 'muted')).toBeNull()
    expect(cellTone('status', 'Running', 'ok')).toBeNull()
  })

  it('lọc theo tên, namespace, ô (không phân biệt hoa thường — q đã chữ thường)', () => {
    const rows = [
      row('web-1', 'shop', 1, { status: 'Running' }),
      row('db-0', 'data', 2, { status: 'CrashLoopBackOff' })
    ]
    expect(filterRows(rows, '')).toBe(rows)
    expect(filterRows(rows, 'web').map((r) => r.row.name)).toEqual(['web-1'])
    expect(filterRows(rows, 'data').map((r) => r.row.name)).toEqual(['db-0'])
    expect(filterRows(rows, 'crashloop').map((r) => r.row.name)).toEqual(['db-0'])
  })

  it('xếp theo tên rồi namespace (không theo "ns/tên"), số tự nhiên', () => {
    const rows = [
      row('web-10', 'a', 1),
      row('api', 'z', 2),
      row('web-2', 'a', 3),
      row('api', 'b', 4)
    ]
    const names = sortRows(rows, { key: 'name', dir: 'asc' }, () => undefined).map((r) => r.row.key)
    expect(names).toEqual(['b/api', 'z/api', 'a/web-2', 'a/web-10'])
    const desc = sortRows(rows, { key: 'name', dir: 'desc' }, () => undefined)
    expect(desc[0]?.row.key).toBe('a/web-10')
    // Không đổi mảng gốc.
    expect(rows[0]?.row.key).toBe('a/web-10')
  })

  it('xếp theo CPU: thiếu số liệu đứng cuối khi giảm dần', () => {
    const rows = [row('a', 'x', 1), row('b', 'x', 2), row('c', 'x', 3)]
    const cpu: Record<string, number> = { a: 50, c: 200 }
    const sorted = sortRows(rows, { key: 'cpu', dir: 'desc' }, (o) =>
      cpu[o.metadata.name] !== undefined ? { cpu: cpu[o.metadata.name] ?? 0, memory: 0 } : undefined
    )
    expect(sorted.map((r) => r.row.name)).toEqual(['c', 'a', 'b'])
  })
})

describe('watch: áp sự kiện theo lô', () => {
  it('thêm / sửa / xoá; lô rỗng giữ nguyên bản đồ', () => {
    const map = new Map([['shop/a', obj('a', 'shop')]])
    expect(applyWatchEvents(map, [])).toBe(map)
    const b = obj('b', 'shop')
    const next = applyWatchEvents(map, [
      { type: 'ADDED', object: b },
      { type: 'DELETED', object: obj('a', 'shop') }
    ])
    expect(next).not.toBe(map)
    expect([...next.keys()]).toEqual(['shop/b'])
    expect(map.size).toBe(1)
  })

  it('mapLimit giữ thứ tự và không chạy quá giới hạn cùng lúc', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, n))
      running--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBe(2)
    expect(await mapLimit([], 4, () => Promise.resolve(1))).toEqual([])
  })
})

describe('topology: giữ bố cục khi chỉ nhãn traffic đổi', () => {
  const node = (kind: string, name: string): TopologyNode => ({
    id: `${kind}|shop|${name}`,
    kind,
    kindLabel: kind,
    name,
    namespace: 'shop',
    summary: '',
    tone: 'ok'
  })
  const nodes = [node('deployments.apps', 'web'), node('services', 'web'), node('pods', 'web-1')]
  const edges: TopologyEdge[] = [
    { from: nodes[1]?.id ?? '', to: nodes[0]?.id ?? '', type: 'selects' },
    { from: nodes[0]?.id ?? '', to: nodes[2]?.id ?? '', type: 'owns' },
    { from: nodes[1]?.id ?? '', to: nodes[0]?.id ?? '', type: 'calls', label: '1 KB/s' }
  ]

  it('khoá cấu trúc không phụ thuộc nhãn / thứ tự', () => {
    const relabeled = edges.map((e) => (e.type === 'calls' ? { ...e, label: '9 MB/s' } : e))
    expect(topologyStructureKey({ nodes, edges })).toBe(
      topologyStructureKey({ nodes: [...nodes].reverse(), edges: relabeled })
    )
    expect(topologyStructureKey({ nodes, edges })).not.toBe(
      topologyStructureKey({ nodes, edges: edges.slice(0, 2) })
    )
  })

  it('relabelLayout giữ vị trí, lấy nhãn / tóm tắt mới', () => {
    const base = layoutTopology(nodes, edges, 'lr')
    const fresh = {
      nodes: nodes.map((n) => (n.kind === 'pods' ? { ...n, summary: 'Running' } : n)),
      edges: edges.map((e) => (e.type === 'calls' ? { ...e, label: '9 MB/s' } : e))
    }
    const next = relabelLayout(base, fresh)
    for (const p of base.nodes) {
      const q = next.nodes.find((n) => n.id === p.id)
      expect(q).toMatchObject({ x: p.x, y: p.y })
    }
    expect(next.nodes.find((n) => n.kind === 'pods')?.summary).toBe('Running')
    expect(next.edges.find((e) => e.type === 'calls')?.label).toBe('9 MB/s')
    expect(next.width).toBe(base.width)
  })
})
