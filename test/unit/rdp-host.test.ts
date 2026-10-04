import { describe, expect, it } from 'vitest'
import type { HostInput } from '@shared/hosts'
import { DEFAULT_RDP } from '@shared/rdp'
import { Secret } from '../../src/node-shared/secret'
import { HostService } from '../../src/main/hosts/service'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { RdpController, resolveRdpConnection } from '../../src/main/rdp/controller'
import type { DetectedClient } from '../../src/main/rdp/detect'
import type { LaunchPlan } from '../../src/main/rdp/launcher'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
  return { db, service: new HostService(db, vault, () => ++clock) }
}

const ssh: HostInput = {
  groupId: null,
  label: 'bastion',
  hostname: 'bastion.example.com',
  port: 22,
  username: 'ops',
  auth: 'auto',
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  tags: [],
  color: null
}

const rdp = (over: Partial<HostInput> = {}): HostInput => ({
  ...ssh,
  protocol: 'rdp',
  label: 'win',
  hostname: 'win.corp.local',
  port: 3389,
  username: 'john.doe@corp.com',
  auth: 'password',
  password: 'P@ssw0rd',
  rdp: { ...DEFAULT_RDP, domain: 'CORP' },
  ...over
})

describe('Host RDP (HostService)', () => {
  it('lưu / đọc: mật khẩu mã hoá trong vault, tree không có secret, UPN được nhận', async () => {
    const { db, service } = await setup()
    const id = service.saveHost(rdp())
    const host = service.tree().hosts.find((h) => h.id === id)
    expect(host).toMatchObject({
      protocol: 'rdp',
      username: 'john.doe@corp.com',
      hasPassword: true,
      port: 3389,
      rdp: { domain: 'CORP', openWith: 'tab' }
    })
    expect(JSON.stringify(service.tree())).not.toContain('P@ssw0rd')
    const raw = db.prepare('SELECT secret_enc FROM identities').all() as {
      secret_enc: Buffer | null
    }[]
    expect(raw.some((r) => r.secret_enc?.toString('utf8').includes('P@ssw0rd'))).toBe(false)
    const r = service.resolveRdp(id)
    expect(r.password?.revealString()).toBe('P@ssw0rd')
    expect(r).toMatchObject({ host: 'win.corp.local', port: 3389, via: null })
    r.password?.dispose()
  })

  it('UPN không hợp lệ cho host SSH; RDP không dùng SSH key / jump host', async () => {
    const { service } = await setup()
    expect(() => service.saveHost({ ...ssh, username: 'a@b' })).toThrow(/username/i)
    expect(() => service.saveHost(rdp({ auth: 'key', keyId: 'k' }))).toThrow()
    const bastion = service.saveHost(ssh)
    expect(() => service.saveHost(rdp({ jumpHostIds: [bastion] }))).toThrow()
    expect(() => service.saveHost(rdp({ rdp: undefined }))).toThrow()
  })

  it('tunnel qua SSH host: phải là SSH tích hợp; host RDP không làm jump host', async () => {
    const { service } = await setup()
    const bastion = service.saveHost(ssh)
    const system = service.saveHost({ ...ssh, label: 'sys', mode: 'system' })
    const id = service.saveHost(rdp({ rdp: { ...DEFAULT_RDP, viaHostId: bastion } }))
    expect(service.resolveRdp(id).via).toEqual({ id: bastion, label: 'bastion' })
    expect(() =>
      service.saveHost(rdp({ label: 'w2', rdp: { ...DEFAULT_RDP, viaHostId: system } }))
    ).toThrow(/system ssh/)
    expect(() =>
      service.saveHost(rdp({ label: 'w3', rdp: { ...DEFAULT_RDP, viaHostId: id } }))
    ).toThrow()
    expect(() => service.saveHost({ ...ssh, label: 'x', jumpHostIds: [id] })).toThrow(
      /Remote Desktop/
    )
    // Không mở nhầm thành phiên SSH.
    expect(() => service.resolveDirect(id)).toThrow(/Remote Desktop/)
    // SSH host bị xoá → báo rõ khi kết nối.
    service.deleteHost(bastion)
    expect(() => service.resolveRdp(id)).toThrow(/no longer exists/)
  })

  it('"Ask each time" xoá mật khẩu đã lưu; resolveRdpConnection', async () => {
    const { service } = await setup()
    const id = service.saveHost(rdp())
    service.saveHost(rdp({ id, auth: 'auto', password: undefined }))
    expect(service.tree().hosts[0]?.hasPassword).toBe(false)
    expect(resolveRdpConnection(service, id)).toMatchObject({
      host: 'win.corp.local',
      username: 'john.doe@corp.com',
      domain: 'CORP',
      password: null,
      sshHostId: null
    })
  })
})

describe('RdpController', () => {
  const xfreerdp: DetectedClient = {
    kind: 'xfreerdp',
    name: 'xfreerdp3',
    path: '/x',
    freerdpMajor: 3
  }
  const mstsc: DetectedClient = { kind: 'mstsc', name: 'mstsc', path: 'm', cmdkey: 'c' }

  async function make(client: DetectedClient | null) {
    const { service } = await setup()
    const plans: LaunchPlan[] = []
    const controller = new RdpController({
      platform: 'linux',
      detect: () => Promise.resolve(client),
      resolve: (id, touch) => service.resolveRdp(id, touch),
      launcher: {
        launch: (plan) => {
          plans.push(plan)
          return Promise.resolve({ launchId: 'L1', tracked: true, unsignedFile: [] })
        },
        stop: () => Promise.resolve()
      }
    })
    return { service, controller, plans }
  }

  it('không có client → lỗi kèm hướng dẫn cài', async () => {
    const { service, controller } = await make(null)
    const id = service.saveHost(rdp())
    const r = await controller.check(id)
    expect(r).toMatchObject({ ok: false })
    expect(r.ok ? '' : r.hint).toMatch(/FreeRDP/)
  })

  it('FreeRDP + "Ask each time" → askPassword; launch dùng mật khẩu vừa gõ', async () => {
    const { service, controller, plans } = await make(xfreerdp)
    const id = service.saveHost(rdp({ auth: 'auto', password: undefined }))
    expect(await controller.check(id)).toMatchObject({ ok: true, askPassword: true, via: null })
    expect(await controller.launch({ hostId: id })).toMatchObject({ ok: false })
    expect(await controller.launch({ hostId: id, password: 'typed' })).toMatchObject({
      ok: true,
      launchId: 'L1'
    })
    expect(plans[0]?.password).toBe('typed')
  })

  it('mstsc bỏ qua mật khẩu từ renderer (dùng mật khẩu đã lưu hoặc mstsc tự hỏi)', async () => {
    const { service, controller, plans } = await make(mstsc)
    const id = service.saveHost(rdp({ auth: 'auto', password: undefined }))
    expect(await controller.check(id)).toMatchObject({ ok: true, askPassword: false })
    await controller.launch({ hostId: id, password: 'ignored', fullScreen: true })
    expect(plans[0]?.password).toBeNull()
    expect(plans[0]?.target.settings.fullScreen).toBe(true)
  })

  it('tunnel: bắt buộc có cổng khi host đi qua SSH; từ chối cổng cho host kết nối thẳng', async () => {
    const { service, controller, plans } = await make(xfreerdp)
    const bastion = service.saveHost(ssh)
    const tunneled = service.saveHost(rdp({ rdp: { ...DEFAULT_RDP, viaHostId: bastion } }))
    const direct = service.saveHost(rdp({ label: 'direct' }))
    expect(await controller.check(tunneled)).toMatchObject({
      ok: true,
      via: { id: bastion, label: 'bastion' },
      target: { host: 'win.corp.local', port: 3389 }
    })
    expect(await controller.launch({ hostId: tunneled })).toMatchObject({ ok: false })
    expect(await controller.launch({ hostId: direct, tunnelPort: 40000 })).toMatchObject({
      ok: false
    })
    expect(await controller.launch({ hostId: tunneled, tunnelPort: 54321 })).toMatchObject({
      ok: true
    })
    expect(plans[0]?.target).toMatchObject({ host: '127.0.0.1', port: 54321 })
    expect(plans[0]?.password).toBe('P@ssw0rd')
  })
})
