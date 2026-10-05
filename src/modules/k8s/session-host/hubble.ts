import { connect as http2Connect, type ClientHttp2Session } from 'node:http2'
import { Duplex } from 'node:stream'
import type WebSocket from 'ws'
import type { K8sObject } from '../shared/resources'
import type { TrafficLink, TrafficPeer } from '../shared/traffic'
import { KubeError, type KubeClient } from './client'
import {
  GrpcFrameReader,
  grpcFrame,
  msg,
  msgs,
  num,
  readMessage,
  str,
  strs,
  writeMessage,
  type PbValue
} from './protobuf'

/**
 * Traffic từ Hubble (Cilium): giữ một luồng `observer.Observer/GetFlows` (follow) tới Hubble Relay
 * qua port-forward của API server (gRPC trên HTTP/2 không mã hoá — mặc định của Relay trong
 * cluster), đếm **kết nối mới** (TCP SYN, gói UDP) theo cặp nguồn → đích như bộ đếm tích luỹ của
 * Caretta. Hubble không có số byte — đơn vị là kết nối / giây. Tên miền của đích ngoài cluster lấy từ
 * `destination_names` (Cilium DNS proxy, khi bật DNS visibility).
 *
 * Số trường theo flow.proto / observer.proto của Cilium (ổn định từ Cilium 1.10).
 */

const RELAY_NS = 'kube-system'
const RELAY_NAME = 'hubble-relay'
const RELAY_PORT = 4245
/** Không ai hỏi số liệu trong chừng này → đóng luồng (không đọc flow vô ích). */
const IDLE_MS = 60_000
/** Dò lại Relay (chưa cài / vừa cài / lỗi) sau chừng này. */
const RETRY_MS = 30_000
/** Tối đa số cặp nguồn → đích nhớ (cluster rất lớn). */
const MAX_LINKS = 20_000

/** Identity dành riêng của Cilium. */
const IDENTITY_HOST = 1
const IDENTITY_REMOTE_NODE = 6
/** Verdict FORWARDED. */
const FORWARDED = 1
/** FlowType L3_L4. */
const L3_L4 = 1

export interface RelayTarget {
  namespace: string
  pod: string
  port: number
}

/** Tìm Hubble Relay: Service kube-system/hubble-relay → pod đang chạy + cổng gRPC. null = chưa cài. */
export async function findRelay(
  client: KubeClient,
  signal?: AbortSignal
): Promise<RelayTarget | null> {
  const opts = signal ? { signal } : {}
  let svc: K8sObject
  try {
    svc = await client.json<K8sObject>(
      'GET',
      `/api/v1/namespaces/${RELAY_NS}/services/${RELAY_NAME}`,
      opts
    )
  } catch (error) {
    if (error instanceof KubeError && (error.status === 404 || error.status === 403)) return null
    throw error
  }
  const selector = (svc.spec?.['selector'] ?? {}) as Record<string, string>
  const ports = (svc.spec?.['ports'] ?? []) as { targetPort?: number | string; port?: number }[]
  const target = ports[0]?.targetPort ?? RELAY_PORT
  const labelSelector = Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  if (!labelSelector) return null
  const list = await client.json<{ items: K8sObject[] | null }>(
    'GET',
    `/api/v1/namespaces/${RELAY_NS}/pods`,
    { ...opts, query: { labelSelector } }
  )
  const pod = (list.items ?? []).find(
    (p) =>
      (p.status?.['phase'] as string | undefined) === 'Running' && !p.metadata.deletionTimestamp
  )
  if (!pod) return null
  let port = typeof target === 'number' ? target : RELAY_PORT
  if (typeof target === 'string') {
    const containers = (pod.spec?.['containers'] ?? []) as {
      ports?: { name?: string; containerPort?: number }[]
    }[]
    for (const c of containers)
      for (const p of c.ports ?? [])
        if (p.name === target && p.containerPort) port = p.containerPort
  }
  return { namespace: RELAY_NS, pod: pod.metadata.name, port }
}

/** Kênh portforward (WebSocket v4) → luồng Duplex cho HTTP/2. */
function portForwardStream(ws: WebSocket): Duplex {
  const seen = new Set<number>()
  const stream = new Duplex({
    read() {
      ws.resume()
    },
    write(chunk: Buffer, _enc, done) {
      ws.send(Buffer.concat([Buffer.from([0]), chunk]), (err) => {
        done(err ?? null)
      })
    },
    final(done) {
      ws.close()
      done()
    },
    destroy(err, done) {
      ws.close()
      done(err)
    }
  })
  ws.on('message', (data: Buffer) => {
    if (data.length === 0) return
    const channel = data[0] ?? 0
    let payload = data.subarray(1)
    // Khung đầu tiên của mỗi kênh mang số cổng (2 byte).
    if (!seen.has(channel)) {
      seen.add(channel)
      payload = payload.subarray(2)
    }
    if (payload.length === 0) return
    if (channel === 0) {
      if (!stream.push(payload)) ws.pause()
    } else if (channel === 1) stream.destroy(new Error(payload.toString('utf8')))
  })
  ws.on('close', () => stream.push(null))
  ws.on('error', (e) => stream.destroy(e))
  return stream
}

type Pb = Map<number, PbValue[]>

/** Endpoint của Hubble → bên của kết nối (workload như Caretta; ngoài cluster = tên miền / IP). */
function peerOf(ep: Pb | null, ip: string, names: string[], node: string): TrafficPeer {
  const ns = ep ? str(ep, 3) : ''
  const pod = ep ? str(ep, 5) : ''
  if (ep && ns && pod) {
    const wl = msgs(ep, 6)[0]
    const name = wl ? str(wl, 1) : ''
    const kind = wl ? str(wl, 2) : ''
    return name ? { ns, name, kind: kind || 'Pod' } : { ns, name: pod, kind: 'Pod' }
  }
  const identity = ep ? num(ep, 2) : 0
  if (identity === IDENTITY_HOST || identity === IDENTITY_REMOTE_NODE)
    return { ns: '', name: identity === IDENTITY_HOST && node ? node : ip, kind: 'Node' }
  return { ns: '', name: names[0] || ip, kind: 'external' }
}

/**
 * Một flow → kết nối mới cần đếm (nguồn, đích, cổng), hoặc null (gói trả lời, gói giữa chừng của
 * TCP, bị chặn, L7…).
 */
export function flowLink(
  flow: Pb
): { client: TrafficPeer; server: TrafficPeer; port: string } | null {
  if (num(flow, 2) !== FORWARDED) return null
  const type = num(flow, 10)
  if (type !== 0 && type !== L3_L4) return null
  // is_reply (BoolValue, 26) — bản cũ: reply (16).
  const isReply = msg(flow, 26)
  if ((isReply && num(isReply, 1) === 1) || num(flow, 16) === 1) return null
  const l4 = msg(flow, 6)
  if (!l4) return null
  const tcp = msg(l4, 1)
  const udp = msg(l4, 2)
  if (!tcp && !udp) return null
  if (tcp) {
    const flags = msg(tcp, 3)
    // Chỉ gói mở kết nối: SYN không kèm ACK.
    if (!flags || num(flags, 2) !== 1 || num(flags, 5) === 1) return null
  }
  const port = tcp ? num(tcp, 2) : udp ? num(udp, 2) : 0
  const ipm = msg(flow, 5)
  const node = str(flow, 11)
  const client = peerOf(msg(flow, 8), ipm ? str(ipm, 1) : '', strs(flow, 13), node)
  const server = peerOf(msg(flow, 9), ipm ? str(ipm, 2) : '', strs(flow, 14), node)
  if (!client.name || !server.name) return null
  return { client, server, port: String(port) }
}

const linkId = (l: { client: TrafficPeer; server: TrafficPeer; port: string }): string =>
  `${l.client.kind}|${l.client.ns}|${l.client.name}>${l.server.kind}|${l.server.ns}|${l.server.name}>${l.port}`

/**
 * Bộ đọc Hubble của một phiên cluster: mở luồng khi có người hỏi số liệu, đóng khi rảnh, dò lại
 * Relay định kỳ. `bytes` của link = số kết nối mới tích luỹ (renderer tính tốc độ như Caretta).
 */
export class HubbleCollector {
  state: 'idle' | 'connecting' | 'ok' | 'unavailable' = 'idle'
  /** Lý do khi unavailable (tiếng Anh — renderer dịch). */
  reason = ''
  /** Đã thấy Relay (để biết nên dùng Hubble thay Caretta). */
  present = false
  private readonly counters = new Map<string, TrafficLink>()
  private session: ClientHttp2Session | null = null
  private lastUsed = 0
  private retryAt = 0
  private idleTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly client: KubeClient,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  /** Gọi mỗi lượt đọc số liệu: mở luồng nếu chưa có (không chờ kết nối xong). */
  async touch(signal?: AbortSignal): Promise<void> {
    this.lastUsed = Date.now()
    if (this.session || this.state === 'connecting') return
    if (Date.now() < this.retryAt) return
    this.state = 'connecting'
    try {
      const relay = await findRelay(this.client, signal)
      if (!relay) {
        this.present = false
        this.fail('Hubble Relay is not installed in this cluster')
        return
      }
      this.present = true
      await this.open(relay)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  snapshot(): TrafficLink[] {
    return [...this.counters.values()].map((l) => ({ ...l }))
  }

  dispose(): void {
    this.close()
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  private fail(reason: string): void {
    this.state = 'unavailable'
    this.reason = reason
    this.retryAt = Date.now() + RETRY_MS
    this.close()
  }

  private close(): void {
    const s = this.session
    this.session = null
    s?.destroy()
  }

  private async open(relay: RelayTarget): Promise<void> {
    const ws = await this.client.websocket(
      `/api/v1/namespaces/${encodeURIComponent(relay.namespace)}/pods/${encodeURIComponent(relay.pod)}/portforward`,
      { ports: String(relay.port) },
      ['v4.channel.k8s.io']
    )
    const stream = portForwardStream(ws)
    const session = http2Connect('http://hubble-relay', { createConnection: () => stream })
    this.session = session
    session.on('error', (e: Error) => {
      if (this.session === session) this.fail(`Could not talk to Hubble Relay (${e.message})`)
    })
    session.on('close', () => {
      if (this.session === session) {
        this.session = null
        if (this.state === 'ok') this.state = 'idle'
      }
    })
    const req = session.request({
      ':method': 'POST',
      ':path': '/observer.Observer/GetFlows',
      'content-type': 'application/grpc',
      te: 'trailers'
    })
    // GetFlowsRequest { follow = true } — từ bây giờ, không đọc lại lịch sử.
    req.end(grpcFrame(writeMessage([[3, true]])))
    const frames = new GrpcFrameReader()
    req.on('response', (headers) => {
      const status = Number(headers[':status'])
      if (status !== 200) {
        this.fail(`Hubble Relay answered HTTP ${String(status)}`)
        return
      }
      this.state = 'ok'
      this.reason = ''
    })
    req.on('data', (chunk: Buffer) => {
      try {
        frames.push(chunk, (message) => {
          this.onResponse(message)
        })
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error))
      }
    })
    req.on('trailers', (trailers: Record<string, string | string[] | undefined>) => {
      const code = Number(trailers['grpc-status'] ?? 0)
      if (code !== 0)
        this.fail(
          `Hubble Relay: ${String(trailers['grpc-message'] ?? `gRPC status ${String(code)}`)}`
        )
    })
    req.on('error', (e: Error) => {
      if (this.session === session) this.fail(`Hubble Relay stream failed (${e.message})`)
    })
    this.idleTimer ??= setInterval(() => {
      if (this.session && Date.now() - this.lastUsed > IDLE_MS) {
        this.log('hubble: idle — closing the flow stream')
        this.close()
        this.state = 'idle'
      }
    }, 15_000)
    this.idleTimer.unref()
  }

  private onResponse(message: Uint8Array): void {
    // GetFlowsResponse { flow = 1 }.
    const res = readMessage(message)
    const flow = msg(res, 1)
    if (!flow) return
    const link = flowLink(flow)
    if (!link) return
    const id = linkId(link)
    const prev = this.counters.get(id)
    if (prev) prev.bytes += 1
    else if (this.counters.size < MAX_LINKS) this.counters.set(id, { ...link, bytes: 1 })
  }
}
