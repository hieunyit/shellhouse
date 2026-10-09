import { describe, expect, it } from 'vitest'
import { buildConnections, isPublicHostname } from '../../shared/connections'
import { egressRows, type EgressItem } from '../../shared/egress'
import type { MapData } from '../../shared/map'
import type { TrafficPeer, TrafficRate } from '../../shared/traffic'

const web = { kind: 'deployments.apps', ns: 'shop', name: 'web' }
const peer = (kind: string, ns: string, name: string): TrafficPeer => ({ kind, ns, name })
const client = peer('Deployment', 'shop', 'web')
const ext = (ip: string): TrafficPeer => peer('external', '', ip)
const rate = (server: TrafficPeer, port: string, r: number): TrafficRate => ({
  client,
  server,
  port,
  rate: r
})

const item = (key: string, host: string, port?: number): EgressItem => ({
  workload: web,
  source: 'env',
  via: '',
  key,
  host,
  ...(port !== undefined ? { port } : {})
})

const noData: Pick<MapData, 'services' | 'pods'> = { services: [], pods: [] }
const rows = (items: EgressItem[], data: Pick<MapData, 'services' | 'pods'> = noData) =>
  egressRows(items, data)
const status = (r: ReturnType<typeof buildConnections>): string[] =>
  r.map((x) => `${x.label}=${x.status}`).sort()

describe('buildConnections — ghép khai báo với quan sát', () => {
  it('tên máy phân giải ra IP khớp kết nối quan sát → active; yên → idle', () => {
    const declared = rows([item('API', 'api.stripe.com', 443), item('DB', 'pg.example.com', 5432)])
    const resolved = new Map([
      ['api.stripe.com', ['104.26.12.64']],
      ['pg.example.com', ['34.1.2.3']]
    ])
    const r = buildConnections({
      declared,
      resolved,
      observed: [rate(ext('104.26.12.64'), '443', 2048), rate(ext('34.1.2.3'), '5432', 0)]
    })
    expect(status(r)).toEqual(['api.stripe.com:443=active', 'pg.example.com:5432=idle'])
    expect(r.find((x) => x.label === 'api.stripe.com:443')?.matchedBy).toBe('ip')
    expect(r.find((x) => x.label === 'api.stripe.com:443')?.observed?.peers).toEqual([
      '104.26.12.64'
    ])
  })

  it('khai báo mà không thấy kết nối → declared; tên không phân giải được → unknown (không kết luận)', () => {
    const declared = rows([item('A', 'a.example.com', 443), item('B', 'b.example.com', 443)])
    const r = buildConnections({
      declared,
      resolved: new Map([['a.example.com', ['1.1.1.1']]]),
      observed: [rate(ext('9.9.9.9'), '443', 10)]
    })
    expect(r.find((x) => x.label === 'a.example.com:443')?.status).toBe('declared')
    expect(r.find((x) => x.label === 'b.example.com:443')?.status).toBe('unknown')
    expect(r.find((x) => x.label === '9.9.9.9:443')?.status).toBe('undeclared')
  })

  it('không có nguồn traffic → unmeasured, không bịa "idle"', () => {
    const r = buildConnections({
      declared: rows([item('A', 'a.example.com', 443)]),
      observed: null
    })
    expect(status(r)).toEqual(['a.example.com:443=unmeasured'])
    expect(r[0]?.observed).toBeNull()
  })

  it('IP khai báo khớp theo IP; cổng khác nhau thì không khớp', () => {
    const declared = rows([item('DB_HOST', '10.152.3.127', 5432)])
    const hit = buildConnections({ declared, observed: [rate(ext('10.152.3.127'), '5432', 5)] })
    expect(status(hit)).toEqual(['10.152.3.127:5432=active'])
    const miss = buildConnections({ declared, observed: [rate(ext('10.152.3.127'), '6379', 5)] })
    expect(status(miss)).toEqual(['10.152.3.127:5432=declared', '10.152.3.127:6379=undeclared'])
  })

  it('đích kiểu Service khớp workload đứng sau Service (selector)', () => {
    const data = {
      services: [
        {
          ns: 'shop',
          name: 'api',
          type: 'ClusterIP',
          selector: { app: 'api' },
          ports: '8080',
          clusterIP: '10.43.0.9'
        }
      ],
      workloads: [
        {
          kind: 'deployments.apps',
          ns: 'shop',
          name: 'api-v2',
          labels: { app: 'api' },
          ready: 1,
          desired: 1,
          status: '',
          tone: 'ok' as const,
          pvcs: []
        }
      ],
      pods: []
    }
    const declared = rows([item('UPSTREAM', 'api', 8080)], data)
    const r = buildConnections({
      declared,
      data,
      observed: [rate(peer('Deployment', 'shop', 'api-v2'), '80', 4096)]
    })
    expect(status(r)).toEqual(['shop/api:8080=active'])
    expect(r[0]?.matchedBy).toBe('workload')
  })

  it('chỉ quan sát: undeclared; ≥3 IP cùng /16 gom nhóm; DNS / kube-system là nhiễu', () => {
    const r = buildConnections({
      declared: [],
      observed: [
        rate(ext('10.152.3.127'), '5432', 1),
        rate(ext('10.152.3.59'), '9200', 1),
        rate(ext('10.152.2.128'), '8000', 1),
        rate(ext('104.26.12.64'), '443', 1),
        rate(peer('Deployment', 'kube-system', 'coredns'), '53', 1)
      ]
    })
    const labels = r.map((x) => x.label).sort()
    expect(labels).toEqual(['10.152.0.0/16 (3)', '104.26.12.64:443', 'kube-system/coredns:53'])
    const grp = r.find((x) => x.members)
    expect(grp?.members).toHaveLength(3)
    expect(grp?.status).toBe('undeclared')
    expect(r.find((x) => x.label.startsWith('kube-system'))?.system).toBe(true)
  })

  it('chỉ một workload; client không phải workload bị bỏ', () => {
    const other = { ...web, name: 'other' }
    const declared = rows([
      item('A', 'a.example.com', 443),
      { ...item('B', 'b.example.com', 443), workload: other }
    ])
    const r = buildConnections({ declared, observed: [], only: web })
    expect(r.map((x) => x.workload.name)).toEqual(['web'])
    const podClient = buildConnections({
      declared: [],
      observed: [{ client: peer('Pod', 'shop', 'p'), server: ext('1.2.3.4'), port: '80', rate: 1 }]
    })
    expect(podClient).toEqual([])
  })
})

describe('isPublicHostname — chỉ phân giải tên công khai', () => {
  it('không phân giải tên nội bộ / IP / một nhãn (tránh lộ tên nội bộ ra DNS công cộng)', () => {
    expect(isPublicHostname('api.stripe.com')).toBe(true)
    expect(isPublicHostname('db.prod.corp')).toBe(false)
    expect(isPublicHostname('redis.default.svc.cluster.local')).toBe(false)
    expect(isPublicHostname('10.0.0.1')).toBe(false)
    expect(isPublicHostname('redis')).toBe(false)
    expect(isPublicHostname('foo.internal')).toBe(false)
  })
})
