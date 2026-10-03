import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ForwardStatus } from '@shared/forwards'

/**
 * Vòng đời tunnel SSH của Remote Desktop (lib/rdp-tunnel): mở phiên SSH không shell, forward
 * 127.0.0.1:<ngẫu nhiên> → đích, trả cổng; prompt SSH đi ra ngoài; đóng / đứt kết nối được báo.
 */

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null
  sent: unknown[]
  closed: boolean
  start(): void
  close(): void
  postMessage(m: unknown): void
}
const ports: FakePort[] = []
const opened: unknown[] = []
const closedSessions: string[] = []

vi.mock('../../src/renderer/src/lib/sessions', () => ({
  openSession: (spec: unknown) => {
    opened.push(spec)
    const port: FakePort = {
      onmessage: null,
      sent: [],
      closed: false,
      start: () => undefined,
      close() {
        this.closed = true
      },
      postMessage(m) {
        this.sent.push(m)
      }
    }
    ports.push(port)
    return Promise.resolve({ sessionId: `s${ports.length}`, port })
  }
}))

beforeAll(async () => {
  // Nạp trước (lần nạp đầu chậm trên máy bận) — các test chỉ đo hành vi.
  await import('../../src/renderer/src/lib/rdp-tunnel')
  await import('../../src/renderer/src/lib/sessions')
  vi.stubGlobal('window', {
    shellhouse: {
      closeSession: (id: string) => {
        closedSessions.push(id)
        return Promise.resolve()
      }
    }
  })
})

const forwards = (port: FakePort, list: Partial<ForwardStatus>[]): void => {
  port.onmessage?.({
    data: {
      t: 'forwards',
      list: list.map((f) => ({ spec: { id: 'rdp' }, actualPort: null, error: null, ...f }))
    }
  })
}
/** Đợi open() gọi openSession (nạp sessions.ts động). */
let seen = 0
const tick = () =>
  vi.waitFor(() => {
    if (ports.length <= seen) throw new Error('chưa mở phiên')
    seen = ports.length
  })

async function load() {
  const { RdpTunnel } = await import('../../src/renderer/src/lib/rdp-tunnel')
  const events = { status: [] as string[], prompts: [] as unknown[], lost: [] as string[] }
  const tunnel = new RdpTunnel({
    status: (d) => events.status.push(d),
    prompt: (p) => events.prompts.push(p),
    lost: (r) => events.lost.push(r)
  })
  return { tunnel, events }
}

describe('RdpTunnel', () => {
  it('mở phiên SSH không shell, xin forward cổng 0 → trả cổng thật; đứt kết nối → lost', async () => {
    const { tunnel, events } = await load()
    const pending = tunnel.open('bastion-id', { host: 'win.corp', port: 3389 })
    await tick()
    const port = ports.at(-1) as FakePort
    expect(opened.at(-1)).toMatchObject({ kind: 'host', hostId: 'bastion-id', noShell: true })
    expect(port.sent[0]).toMatchObject({
      t: 'forward-start',
      spec: {
        id: 'rdp',
        kind: 'L',
        bindAddr: '127.0.0.1',
        bindPort: 0,
        destHost: 'win.corp',
        destPort: 3389
      }
    })
    port.onmessage?.({ data: { t: 'status', phase: 'authenticating', detail: 'Authenticating…' } })
    port.onmessage?.({
      data: { t: 'prompt', id: 7, prompt: { kind: 'password', username: 'ops', host: 'bastion' } }
    })
    expect(events.status).toEqual(['Authenticating…'])
    expect(events.prompts.at(-1)).toMatchObject({ id: 7 })
    tunnel.answer(7, true, ['pw'])
    expect(port.sent.at(-1)).toEqual({ t: 'prompt-reply', id: 7, ok: true, answers: ['pw'] })
    expect(events.prompts.at(-1)).toBeNull()
    forwards(port, [{ state: 'starting' }])
    forwards(port, [{ state: 'active', actualPort: 54321 }])
    await expect(pending).resolves.toBe(54321)
    port.onmessage?.({ data: { t: 'exit', code: null, signal: null, reason: 'network' } })
    expect(events.lost).toHaveLength(1)
    expect(port.closed).toBe(true)
  })

  it('forward lỗi trước khi chạy → open() báo lỗi và đóng phiên', async () => {
    const { tunnel } = await load()
    const pending = tunnel.open('b', { host: 'h', port: 3389 })
    await tick()
    const port = ports.at(-1) as FakePort
    forwards(port, [{ state: 'error', error: 'Connection refused' }])
    await expect(pending).rejects.toThrow('Connection refused')
    expect(port.closed).toBe(true)
  })

  it('SSH thất bại trước khi forward chạy → lỗi cuối cùng của phiên', async () => {
    const { tunnel } = await load()
    const pending = tunnel.open('b', { host: 'h', port: 3389 })
    await tick()
    const port = ports.at(-1) as FakePort
    port.onmessage?.({ data: { t: 'error', message: 'Authentication failed' } })
    port.onmessage?.({ data: { t: 'exit', code: null, signal: null, reason: 'auth' } })
    await expect(pending).rejects.toThrow('Authentication failed')
  })

  it('Disconnect khi đang mở → huỷ; khi đã mở → đóng phiên, không báo lost', async () => {
    const a = await load()
    const pending = a.tunnel.open('b', { host: 'h', port: 3389 })
    await tick()
    a.tunnel.close()
    await expect(pending).rejects.toThrow()
    const b = await load()
    const p2 = b.tunnel.open('b', { host: 'h', port: 3389 })
    await tick()
    const port = ports.at(-1) as FakePort
    forwards(port, [{ state: 'active', actualPort: 40000 }])
    await p2
    b.tunnel.close()
    expect(port.closed).toBe(true)
    expect(closedSessions).toContain(`s${ports.length}`)
    expect(b.events.lost).toEqual([])
  })
})
