import { describe, expect, it } from 'vitest'
import {
  bandOf,
  BANDS,
  byPair,
  formatRate,
  mergeLinks,
  parseCaretta,
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
    expect(formatRate(0.2)).toBe('0 B/s')
    expect(formatRate(2048)).toBe('2.0 KB/s')
    expect(formatRate(2_097_152)).toBe('2.0 MB/s')
  })
})
