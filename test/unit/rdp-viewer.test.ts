import { describe, expect, it } from 'vitest'
import { DEFAULT_RDP } from '../../src/shared/rdp'
import type { RdpCertInfo, RdpViewTarget } from '../../src/shared/rdp-viewer'
import { RdpCertStore } from '../../src/main/rdp-viewer/cert-store'
import { RdpViewController } from '../../src/main/rdp-viewer/controller'
import type { ResolvedRdp } from '../../src/main/hosts/service'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'

const FP_A = Array(32).fill('AA').join(':')
const FP_B = Array(32).fill('BB').join(':')

const cert = (fingerprint: string): RdpCertInfo => ({
  fingerprint,
  subject: 'CN=win',
  issuer: 'CN=win',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2027-01-01T00:00:00.000Z',
  selfSigned: true
})

async function setup(host: Partial<ResolvedRdp> = {}) {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const certs = new RdpCertStore(db)
  let serverCert = FP_A
  const opened: { target: RdpViewTarget; pin: string }[] = []
  const disposed: string[] = []
  const resolve = (): ResolvedRdp => ({
    label: 'Win',
    host: 'Win.Corp',
    port: 3389,
    username: 'alice',
    settings: { ...DEFAULT_RDP, domain: 'CORP' },
    password: {
      revealString: () => 'secret',
      dispose: () => disposed.push('pw')
    } as unknown as ResolvedRdp['password'],
    via: null,
    ...host
  })
  const controller = new RdpViewController({
    resolve,
    certs,
    probe: () =>
      Promise.resolve({
        cert: cert(serverCert),
        tls: { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', legacyRsa: false }
      }),
    open: (target, pin) => {
      opened.push({ target, pin })
      return Promise.resolve({ proxyAddress: 'ws://127.0.0.1:9/rdcleanpath', token: 'tok' })
    }
  })
  return {
    controller,
    certs,
    opened,
    disposed,
    setServerCert: (fp: string) => {
      serverCert = fp
    }
  }
}

describe('RdpViewController (main)', () => {
  it('TOFU: lần đầu unknown → tin → trusted; chứng chỉ đổi → changed', async () => {
    const s = await setup()
    const first = await s.controller.probe({ hostId: 'h' })
    expect(first.status).toBe('unknown')
    await expect(s.controller.open({ hostId: 'h' })).rejects.toThrow(/not been trusted/)
    // Chỉ tin đúng dấu vừa dò.
    expect(() => {
      s.controller.trust('h', FP_B)
    }).toThrow(/expired/)
    s.controller.trust('h', FP_A)
    expect((await s.controller.probe({ hostId: 'h' })).status).toBe('trusted')
    s.setServerCert(FP_B)
    const changed = await s.controller.probe({ hostId: 'h' })
    expect(changed).toMatchObject({ status: 'changed', known: FP_A })
    // Theo host:port, không phân biệt hoa thường.
    expect(s.certs.pinned('win.corp', 3389)).toBe(FP_A)
  })

  it('open: dùng mật khẩu đã lưu, ghim dấu đã tin, đích do main quyết định', async () => {
    const s = await setup()
    await s.controller.probe({ hostId: 'h' })
    s.controller.trust('h', FP_A)
    const r = await s.controller.open({ hostId: 'h' })
    expect(r).toEqual({
      proxyAddress: 'ws://127.0.0.1:9/rdcleanpath',
      authToken: 'tok',
      destination: 'Win.Corp:3389',
      username: 'alice',
      domain: 'CORP',
      password: 'secret'
    })
    expect(s.opened).toEqual([{ target: { host: 'Win.Corp', port: 3389 }, pin: FP_A }])
    expect(s.disposed.length).toBeGreaterThan(0)
    // Gõ "DOMAIN\\user" tách domain.
    const typed = await s.controller.open({ hostId: 'h', username: 'OTHER\\bob', password: 'x' })
    expect(typed).toMatchObject({ username: 'bob', domain: 'OTHER', password: 'x' })
  })

  it('tunnel: host qua SSH phải có phiên SSH; host thẳng không nhận phiên SSH', async () => {
    const via = await setup({ via: { id: 'ssh1', label: 'bastion' } })
    await expect(via.controller.probe({ hostId: 'h' })).rejects.toThrow(/tunnel is not open/)
    const sessionId = '0190f5a0-0000-7000-8000-000000000001'
    await via.controller.probe({ hostId: 'h', viaSessionId: sessionId })
    via.controller.trust('h', FP_A)
    await via.controller.open({ hostId: 'h', viaSessionId: sessionId })
    expect(via.opened[0]?.target).toEqual({ host: 'Win.Corp', port: 3389, viaSessionId: sessionId })

    const direct = await setup()
    await expect(direct.controller.probe({ hostId: 'h', viaSessionId: sessionId })).rejects.toThrow(
      /does not use an SSH tunnel/
    )
  })

  it('prepare: không trả mật khẩu; RD Gateway → gợi ý client ngoài; thiếu mật khẩu → báo', async () => {
    const s = await setup()
    const p = s.controller.prepare('h')
    expect(p).toMatchObject({ ok: true, hasPassword: true, username: 'alice' })
    expect(JSON.stringify(p)).not.toContain('secret')
    const gw = await setup({ settings: { ...DEFAULT_RDP, gateway: 'gw.corp' } })
    expect(gw.controller.prepare('h')).toMatchObject({ ok: false, external: true })
    const nopw = await setup({ password: null })
    await nopw.controller.probe({ hostId: 'h' })
    nopw.controller.trust('h', FP_A)
    await expect(nopw.controller.open({ hostId: 'h' })).rejects.toThrow(/password/)
  })
})
