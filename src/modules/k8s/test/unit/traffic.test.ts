import { describe, expect, it } from 'vitest'
import {
  bandOf,
  BANDS,
  byPair,
  formatRate,
  mergeLinks,
  parseCaretta,
  trafficGraph,
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

  it('service map: cột theo hướng gọi, đích ngoài cluster ở cột cuối, chịu được vòng', () => {
    const peer = (kind: string, ns: string, name: string) => ({ kind, ns, name })
    const ing = peer('Deployment', 'ingress-nginx', 'ingress-nginx-controller')
    const fe = peer('Deployment', 'console-stg', 'console-frontend')
    const be = peer('Deployment', 'console-stg', 'console-backend')
    const db = peer('external', '', 'pg.rds.amazonaws.com')
    const g = trafficGraph([
      { client: ing, server: fe, port: '80', rate: 100 },
      { client: ing, server: be, port: '8000', rate: 50 },
      { client: fe, server: be, port: '8000', rate: 20 },
      { client: be, server: db, port: '5432', rate: 10 },
      // Vòng: backend gọi ngược frontend.
      { client: be, server: fe, port: '80', rate: 1 }
    ])
    const col = (p: { kind: string; ns: string; name: string }) =>
      g.nodes.find((n) => n.peer.name === p.name)?.col
    expect(col(ing)).toBe(0)
    expect((col(fe) ?? 0) > 0 && (col(be) ?? 0) > 0).toBe(true)
    expect(col(db)).toBe(Math.max(...g.nodes.map((n) => n.col)))
    expect(g.nodes.find((n) => n.peer.name === ing.name)?.outRate).toBe(150)
    expect(g.edges).toHaveLength(5)
    // Không chồng nhau trong cùng cột.
    for (const a of g.nodes)
      for (const b of g.nodes)
        if (a !== b && a.col === b.col) expect(Math.abs(a.y - b.y) >= a.h).toBe(true)
  })

  it('service map: mesh gọi qua lại dày đặc vẫn gọn (cột = số bước từ điểm vào)', () => {
    const peer = (name: string) => ({ kind: 'Deployment', ns: 'app', name })
    const names = Array.from({ length: 30 }, (_, i) => `svc-${String(i)}`)
    const rates = names.flatMap((n, i) =>
      names
        .filter((_, j) => j !== i && (j + i) % 3 === 0)
        .map((m) => ({ client: peer(n), server: peer(m), port: '80', rate: 10 }))
    )
    const nginx = { kind: 'Deployment', ns: 'ingress', name: 'nginx' }
    const g = trafficGraph([
      { client: nginx, server: peer('svc-0'), port: '80', rate: 5 },
      ...rates,
      {
        client: peer('svc-1'),
        server: { kind: 'external', ns: '', name: 'db' },
        port: '5432',
        rate: 1
      }
    ])
    expect(new Set(g.nodes.map((n) => n.col)).size).toBeLessThanOrEqual(6)
    expect(g.nodes.find((n) => n.peer.name === 'nginx')?.col).toBe(0)
    expect(g.nodes.find((n) => n.peer.name === 'db')?.col).toBe(
      Math.max(...g.nodes.map((n) => n.col))
    )
    // Không có điểm vào (toàn vòng) vẫn xếp đủ node.
    const ring = trafficGraph(
      names.map((n, i) => ({
        client: peer(n),
        server: peer(names[(i + 1) % 30] ?? n),
        port: '80',
        rate: 1
      }))
    )
    expect(ring.nodes).toHaveLength(30)
  })
})
