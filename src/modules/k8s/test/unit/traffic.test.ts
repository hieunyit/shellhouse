import { describe, expect, it } from 'vitest'
import {
  bandOf,
  BANDS,
  byPair,
  formatRate,
  windowRates,
  mergeLinks,
  parseCaretta,
  externalGroup,
  flowGraph,
  layoutFlow,
  trafficRates,
  type TrafficSample
} from '../../shared/traffic'

const TEXT = `# HELP caretta_links_observed total bytes
# TYPE caretta_links_observed gauge
caretta_links_observed{client_kind="Deployment",client_name="web",client_namespace="shop",link_id="1",role="1",server_kind="Deployment",server_name="api",server_namespace="shop",server_port="8080"} 1000
caretta_links_observed{client_kind="Deployment",client_name="web",client_namespace="shop",link_id="1",role="2",server_kind="Deployment",server_name="api",server_namespace="shop",server_port="8080"} 990
caretta_links_observed{client_kind="Deployment",client_name="web",client_namespace="shop",link_id="2",role="1",server_kind="Deployment",server_name="api",server_namespace="shop",server_port="8080"} 500
caretta_links_observed{client_kind="Deployment",client_name="web",client_namespace="shop",link_id="3",role="1",server_kind="external",server_name="1.2.3.4",server_namespace="",server_port="443"} 2e3
go_goroutines 12
caretta_links_observed{broken
`

describe('Caretta — parse, gộp, tốc độ, băng cố định', () => {
  it('parse dòng metric, bỏ dòng khác / hỏng', () => {
    const rows = parseCaretta(TEXT)
    expect(rows).toHaveLength(4)
    expect(rows[3]).toMatchObject({
      server: { kind: 'external', name: '1.2.3.4' },
      port: '443',
      bytes: 2000
    })
  })

  it('gộp: cộng các agent cùng vai trò, lấy phía lớn hơn giữa client / server (không đếm hai lần)', () => {
    const links = mergeLinks(parseCaretta(TEXT))
    const api = links.find((l) => l.server.name === 'api')
    expect(api?.bytes).toBe(1500)
    expect(links).toHaveLength(2)
  })

  it('tốc độ giữa hai lần đọc; counter giảm (agent khởi động lại) → bỏ', () => {
    const link = (bytes: number) => ({
      client: { ns: 'shop', name: 'web', kind: 'Deployment' },
      server: { ns: 'shop', name: 'api', kind: 'Deployment' },
      port: '80',
      bytes
    })
    const a: TrafficSample = { status: 'ok', at: 0, agents: 1, links: [link(1000)] }
    const b: TrafficSample = { status: 'ok', at: 10_000, agents: 1, links: [link(21_480)] }
    expect(trafficRates(a, b)[0]?.rate).toBe(2048)
    expect(trafficRates(b, { ...a, at: 20_000 })).toEqual([])
    expect(byPair([...trafficRates(a, b), ...trafficRates(a, b)])[0]?.rate).toBe(4096)
  })

  it('băng tuyệt đối (so được giữa các cluster) và định dạng', () => {
    expect(bandOf(10)).toBe(0)
    expect(bandOf(50_000)).toBe(2)
    expect(bandOf(5_000_000)).toBe(4)
    expect(bandOf(1e12)).toBe(BANDS.length - 1)
    expect(formatRate(0.2)).toBe('idle')
    expect(formatRate(2048)).toBe('2.0 KB/s')
    expect(formatRate(2_097_152)).toBe('2.0 MB/s')
  })

  const P = (kind: string, ns: string, name: string) => ({ kind, ns, name })
  const ing = P('Deployment', 'ingress-nginx', 'ingress-nginx-controller')
  const fe = P('Deployment', 'console-stg', 'console-frontend')
  const be = P('Deployment', 'console-stg', 'console-backend')
  const dns = P('Deployment', 'kube-system', 'coredns')
  const prom = P('StatefulSet', 'monitoring', 'prometheus')
  const ext = (name: string) => P('external', '', name)
  const R = (
    client: ReturnType<typeof P>,
    server: ReturnType<typeof P>,
    rate: number,
    port = '80'
  ) => ({ client, server, port, rate })
  const LAYOUT = { nodeW: 200, nodeH: 50, colGap: 80, rowGap: 10, maxRows: 6 }

  it('service map: theo phạm vi — ngoài phạm vi gộp theo namespace, bỏ cặp không dính phạm vi', () => {
    const rates = [
      R(ing, fe, 100),
      R(ing, be, 50, '8000'),
      R(fe, be, 20, '8000'),
      R(be, dns, 5, '53'),
      R(prom, fe, 2, '9090'),
      // Không dính console-stg: không vẽ (đây là "mớ bùi nhùi" trên cluster thật).
      R(ext('203.0.113.7'), ing, 9000, '443'),
      R(prom, dns, 3, '9153')
    ]
    const g = flowGraph(rates, { scope: ['console-stg'] })
    const ids = g.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(
      [
        'n:ingress-nginx',
        'n:kube-system',
        'n:monitoring',
        'p:Deployment|console-stg|console-backend',
        'p:Deployment|console-stg|console-frontend'
      ].sort()
    )
    const nsNode = g.nodes.find((n) => n.id === 'n:ingress-nginx')
    expect(nsNode?.kind).toBe('namespace')
    expect(nsNode?.scoped).toBe(false)
    expect(nsNode?.expandable).toBe(true)
    expect(nsNode?.outRate).toBe(150)
    expect(
      g.edges.find((e) => e.id.startsWith('n:ingress-nginx>p:') && e.to.endsWith('backend'))?.ports
    ).toEqual(['8000'])
    // Mở namespace → từng workload (nhớ node cha để gập lại).
    const open = flowGraph(rates, {
      scope: ['console-stg'],
      expanded: new Set(['n:ingress-nginx'])
    })
    const ctl = open.nodes.find((n) => n.peer?.name === 'ingress-nginx-controller')
    expect(ctl?.parent).toBe('n:ingress-nginx')
    // Mọi namespace: không gộp, cặp ngoài cluster → workload cũng có.
    const all = flowGraph(rates, { scope: [] })
    expect(all.nodes.some((n) => n.kind === 'namespace')).toBe(false)
    expect(all.nodes.some((n) => n.peer?.name === '203.0.113.7')).toBe(true)
  })

  it('service map: External gộp theo hướng, mở theo /16 · tên miền rồi từng địa chỉ', () => {
    expect(externalGroup('52.95.110.1')).toBe('52.95.0.0/16')
    expect(externalGroup('s3.ap-southeast-1.amazonaws.com')).toBe('amazonaws.com')
    expect(externalGroup('api.momo.com.vn')).toBe('momo.com.vn')
    expect(externalGroup('2001:db8::1')).toBe('2001:db8::/32')
    const outs = [
      ...Array.from({ length: 6 }, (_, i) => ext(`52.95.0.${String(i)}`)),
      ext('3.1.2.3'),
      ext('api.stripe.com'),
      ext('hooks.stripe.com')
    ]
    const rates = [
      ...outs.map((x) => R(be, x, 10, '443')),
      ...Array.from({ length: 3 }, (_, i) => R(ext(`198.51.100.${String(i)}`), fe, 5, '443'))
    ]
    const g = flowGraph(rates, { scope: ['console-stg'] })
    const out = g.nodes.find((n) => n.id === 'x:out')
    expect(out?.members).toHaveLength(9)
    expect(out?.side).toBe('out')
    // Ít địa chỉ (≤ EXTERNAL_INLINE) phía gọi tới: vẽ riêng từng cái.
    expect(g.nodes.filter((n) => n.id.startsWith('x:in:'))).toHaveLength(3)
    const lv1 = flowGraph(rates, { scope: ['console-stg'], expanded: new Set(['x:out']) })
    const labels = lv1.nodes
      .filter((n) => n.side === 'out')
      .map((n) => n.label)
      .sort()
    // Nhóm một địa chỉ (3.1.2.3) vẽ thẳng địa chỉ.
    expect(labels).toEqual(['3.1.2.3', '52.95.0.0/16', 'stripe.com'])
    const lv2 = flowGraph(rates, {
      scope: ['console-stg'],
      expanded: new Set(['x:out', 'x:out:g:stripe.com'])
    })
    expect(lv2.nodes.find((n) => n.label === 'api.stripe.com')?.parent).toBe('x:out:g:stripe.com')
  })

  it('service map: ẩn idle (trừ khi tất cả idle — vẫn vẽ cấu trúc), top-N', () => {
    const rates = [R(ing, fe, 100), R(fe, be, 0), R(be, dns, 0.4)]
    const g = flowGraph(rates, { scope: ['console-stg'] })
    expect(g.edges).toHaveLength(1)
    expect(g.hiddenIdle).toBe(2)
    expect(g.allIdle).toBe(false)
    expect(flowGraph(rates, { scope: ['console-stg'], showIdle: true }).edges).toHaveLength(3)
    // Mọi thứ idle: không trống — vẫn có đường (mờ).
    const idle = flowGraph(
      rates.map((r) => ({ ...r, rate: 0 })),
      { scope: ['console-stg'] }
    )
    expect(idle.allIdle).toBe(true)
    expect(idle.edges).toHaveLength(3)
    expect(idle.nodes.every((n) => !n.active)).toBe(true)
    // Top-N: giữ đường lớn nhất; tốc độ node vẫn là tổng thật.
    const many = Array.from({ length: 10 }, (_, i) =>
      R(fe, P('Deployment', 'console-stg', `svc-${String(i)}`), (i + 1) * 100)
    )
    const top = flowGraph(many, { scope: ['console-stg'], limit: 3 })
    expect(top.edges.map((e) => e.rate)).toEqual([1000, 900, 800])
    expect(top.hiddenMore).toBe(7)
    expect(top.nodes.find((n) => n.peer?.name === 'console-frontend')?.outRate).toBe(5500)
    expect(top.allEdges).toHaveLength(10)
  })

  it('service map: focus — bên gọi trái, workload giữa, bên được gọi phải, "+N" mỗi bên', () => {
    const callees = Array.from({ length: 7 }, (_, i) =>
      R(be, P('Deployment', 'console-stg', `dep-${String(i)}`), 100 - i)
    )
    const g = flowGraph([R(ing, be, 50), R(fe, be, 20), R(dns, fe, 1), ...callees], {
      scope: [],
      focus: be,
      perSide: 4,
      showIdle: true
    })
    // Chỉ các đường của workload trung tâm.
    expect(g.nodes.some((n) => n.peer?.name === 'coredns')).toBe(false)
    const more = g.nodes.find((n) => n.id === 'm:out')
    expect(more?.members).toHaveLength(4)
    expect(g.edges.find((e) => e.to === 'm:out')?.rate).toBe(94 + 95 + 96 + 97)
    const l = layoutFlow(g, LAYOUT)
    const col = (id: string) => l.nodes.get(id)?.col
    expect(col('p:Deployment|console-stg|console-backend')).toBe(1)
    expect(col('p:Deployment|ingress-nginx|ingress-nginx-controller')).toBe(0)
    expect(col('m:out')).toBe(2)
    // "+N" cuối cột.
    const right = [...l.nodes.values()].filter((n) => n.col === 2).sort((a, b) => a.y - b.y)
    expect(right.at(-1)?.id).toBe('m:out')
  })

  it('layout: trái → phải theo đường gọi dài nhất; ngoài phạm vi chỉ nhận ở cột cuối; vòng / mesh gọn', () => {
    const g = flowGraph(
      [
        R(ing, fe, 100),
        R(fe, be, 20),
        // Prometheus scrape mọi thứ: không kéo backend về cột 1.
        R(prom, be, 2),
        R(prom, fe, 2),
        R(be, dns, 5),
        R(be, ext('db.example.com'), 10),
        // Vòng: backend gọi ngược frontend.
        R(be, fe, 1)
      ],
      { scope: ['console-stg'] }
    )
    const l = layoutFlow(g, LAYOUT)
    const col = (id: string) => l.nodes.get(id)?.col ?? -1
    const last = Math.max(...[...l.nodes.values()].map((n) => n.col))
    expect(col('n:ingress-nginx')).toBe(0)
    expect(col('p:Deployment|console-stg|console-frontend')).toBe(1)
    expect(col('p:Deployment|console-stg|console-backend')).toBe(2)
    expect(col('n:kube-system')).toBe(last)
    expect(col('x:out:external||db.example.com')).toBe(last)
    // Không chồng nhau.
    const placed = [...l.nodes.values()]
    for (const a of placed)
      for (const b of placed)
        if (a !== b && a.x === b.x) expect(Math.abs(a.y - b.y) >= a.h).toBe(true)
    // Cùng dữ liệu → cùng chỗ (ổn định).
    expect([...layoutFlow(g, LAYOUT).nodes.values()]).toEqual(placed)

    // Mesh dày + vòng kín: số cột có giới hạn, cột dài chia cột con (không cao vô tận).
    const names = Array.from({ length: 30 }, (_, i) => `svc-${String(i)}`)
    const peer = (n: string) => P('Deployment', 'app', n)
    const mesh = names.flatMap((n, i) =>
      names.filter((_, j) => j !== i && (j + i) % 3 === 0).map((m) => R(peer(n), peer(m), 10))
    )
    const ml = layoutFlow(flowGraph(mesh, { scope: [] }), LAYOUT)
    expect(new Set([...ml.nodes.values()].map((n) => n.col)).size).toBeLessThanOrEqual(5)
    expect(ml.height).toBeLessThanOrEqual(LAYOUT.maxRows * (LAYOUT.nodeH + LAYOUT.rowGap))
    const ring = flowGraph(
      names.map((n, i) => R(peer(n), peer(names[(i + 1) % 30] ?? n), 1)),
      { scope: [] }
    )
    expect(layoutFlow(ring, LAYOUT).nodes.size).toBe(30)
  })

  it('tốc độ trên cửa sổ: kết nối mới có số ngay, counter đặt lại không gây vọt / âm', () => {
    const peer = (name: string) => ({ kind: 'Deployment', ns: 'a', name })
    const link = (name: string, bytes: number) => ({
      client: peer('c'),
      server: peer(name),
      port: '80',
      bytes
    })
    const sample = (at: number, links: ReturnType<typeof link>[]): TrafficSample => ({
      status: 'ok',
      at,
      agents: 1,
      links
    })
    const rates = windowRates([
      sample(0, [link('old', 0), link('reset', 50_000)]),
      sample(10_000, [link('old', 10_240), link('reset', 1_000), link('new', 0)]),
      sample(20_000, [link('old', 20_480), link('reset', 11_240), link('new', 5_120)])
    ])
    const by = new Map(rates.map((r) => [r.server.name, r.rate]))
    // Cả cửa sổ: 20 KB / 20 s.
    expect(by.get('old')).toBe(1024)
    // Counter giảm ở mẫu 2 (agent khởi động lại): chỉ tính từ sau lần đặt lại.
    expect(by.get('reset')).toBe(1024)
    // Mới xuất hiện ở mẫu 2: có số ngay ở mẫu 3.
    expect(by.get('new')).toBe(512)
    expect(rates.every((r) => r.rate >= 0)).toBe(true)
    // Một mẫu / hai mẫu quá sát nhau → chưa có tốc độ.
    expect(windowRates([sample(0, [link('x', 1)])])).toEqual([])
    expect(windowRates([sample(0, [link('x', 1)]), sample(500, [link('x', 9)])])).toEqual([])
  })
})
