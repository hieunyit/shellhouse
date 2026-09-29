import { describe, expect, it } from 'vitest'
import type { HostInput } from '@shared/hosts'
import { Secret } from '../../src/node-shared/secret'
import { HostService } from '../../src/main/hosts/service'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { generateTestKey } from '../integration/ssh-test-server'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
  return { db, service: new HostService(db, vault, () => ++clock) }
}

const host = (patch: Partial<HostInput> = {}): HostInput => ({
  groupId: null,
  label: 'h',
  hostname: 'h.example.com',
  port: null,
  username: '',
  auth: 'auto',
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  tags: [],
  color: null,
  ...patch
})

describe('kế thừa từ nhóm khi kết nối', () => {
  it('username / port / jump host / key lấy từ nhóm gần nhất; host ghi đè được', async () => {
    const { service } = await setup()
    const key = service.importKey('team-key', generateTestKey().private)
    const bastion = service.saveHost(
      host({ label: 'bastion', hostname: 'bastion.example.com', username: 'jump', port: 22 })
    )
    const prod = service.saveGroup({
      parentId: null,
      name: 'Prod',
      defaults: { username: 'deploy', port: 2222, jumpHostIds: [bastion], keyId: key.id }
    })
    const db = service.saveGroup({ parentId: prod, name: 'DB', defaults: { username: 'postgres' } })

    const inherited = service.saveHost(host({ label: 'pg', groupId: db }))
    const r = service.resolveForConnect(inherited)
    expect(r.target).toEqual({ host: 'h.example.com', port: 2222, username: 'postgres' })
    expect(r.jumps.map((j) => j.label)).toEqual(['bastion'])
    expect(r.credentials.privateKey?.label).toBe('team-key') // Automatic → thử key của nhóm

    const own = service.saveHost(
      host({
        label: 'own',
        groupId: db,
        username: 'root',
        port: 22,
        direct: true,
        auth: 'password',
        password: 'x'
      })
    )
    const r2 = service.resolveForConnect(own)
    expect(r2.target).toEqual({ host: 'h.example.com', port: 22, username: 'root' })
    expect(r2.jumps).toEqual([])
    expect(r2.credentials.privateKey).toBeUndefined()

    // tree(): host giữ giá trị "rỗng = kế thừa" để form hiển thị đúng.
    const summary = service.tree().hosts.find((h) => h.id === inherited)
    expect(summary).toMatchObject({ port: null, username: '', direct: false })
    expect(service.tree().groups.find((g) => g.id === prod)?.defaults.port).toBe(2222)
  })

  it('bastion nằm trong chính nhóm có jump = bastion → kết nối thẳng, không báo vòng lặp', async () => {
    const { service } = await setup()
    const prod = service.saveGroup({ parentId: null, name: 'Prod', defaults: { username: 'u' } })
    const bastion = service.saveHost(host({ label: 'bastion', groupId: prod }))
    service.saveGroup({
      id: prod,
      parentId: null,
      name: 'Prod',
      defaults: { username: 'u', jumpHostIds: [bastion] }
    })
    expect(service.resolveForConnect(bastion).jumps).toEqual([])
    const web = service.saveHost(host({ label: 'web', groupId: prod }))
    expect(service.resolveForConnect(web).jumps.map((j) => j.label)).toEqual(['bastion'])
  })

  it('không ai đặt username → báo lỗi rõ ràng', async () => {
    const { service } = await setup()
    const id = service.saveHost(host({ label: 'nouser' }))
    expect(() => service.resolveForConnect(id)).toThrow(/has no username/)
  })

  it('từ chối defaults trỏ tới key / jump host không tồn tại', async () => {
    const { service } = await setup()
    expect(() =>
      service.saveGroup({ parentId: null, name: 'X', defaults: { keyId: 'nope' } })
    ).toThrow(/key no longer exists/)
    expect(() =>
      service.saveGroup({ parentId: null, name: 'X', defaults: { jumpHostIds: ['nope'] } })
    ).toThrow(/jump host no longer exists/)
  })
})

describe('thuật toán legacy', () => {
  it('lưu theo host, truyền khi kết nối (cả khi host là jump host)', async () => {
    const { service } = await setup()
    const old = service.saveHost(
      host({ label: 'old-switch', username: 'admin', legacyAlgorithms: true })
    )
    const modern = service.saveHost(host({ label: 'web', username: 'u', jumpHostIds: [old] }))
    expect(service.tree().hosts.find((h) => h.id === old)?.legacyAlgorithms).toBe(true)
    expect(service.resolveForConnect(old).legacyAlgorithms).toBe(true)
    const r = service.resolveForConnect(modern)
    expect(r.legacyAlgorithms).toBeUndefined()
    expect(r.jumps[0]?.legacyAlgorithms).toBe(true)
  })
})

describe('thao tác hàng loạt', () => {
  it('yêu thích, gắn/bỏ tag, di chuyển, xoá nhiều host', async () => {
    const { service } = await setup()
    const g = service.saveGroup({ parentId: null, name: 'G' })
    const a = service.saveHost(host({ label: 'a', username: 'u', tags: ['old'] }))
    const b = service.saveHost(host({ label: 'b', username: 'u' }))
    service.setFavorite([a, b], true)
    service.tagHosts([a, b], ['prod', 'OLD'], ['old'])
    service.moveHosts([a, b], g)
    const tree = service.tree()
    for (const id of [a, b]) {
      const h = tree.hosts.find((x) => x.id === id)
      expect(h).toMatchObject({ favorite: true, groupId: g })
    }
    expect(tree.hosts.find((x) => x.id === a)?.tags).toEqual(['prod', 'OLD'])
    service.deleteHosts([a, b])
    expect(service.tree().hosts).toHaveLength(0)
  })

  it('sắp xếp thủ công host và nhóm; host mới thêm vào cuối nhóm đã sắp', async () => {
    const { service } = await setup()
    const [a, , c] = ['alpha', 'bravo', 'charlie'].map((label) =>
      service.saveHost(host({ label, username: 'u' }))
    )
    expect(service.tree().hosts.map((h) => h.label)).toEqual(['alpha', 'bravo', 'charlie'])
    service.reorderHosts(null, [c ?? '', a ?? ''])
    expect(service.tree().hosts.map((h) => h.label)).toEqual(['charlie', 'alpha', 'bravo'])
    service.saveHost(host({ label: 'aaa-new', username: 'u' }))
    expect(service.tree().hosts.map((h) => h.label)).toEqual([
      'charlie',
      'alpha',
      'bravo',
      'aaa-new'
    ])

    const x = service.saveGroup({ parentId: null, name: 'X' })
    const y = service.saveGroup({ parentId: null, name: 'Y' })
    service.reorderGroups(null, [y, x])
    expect(service.tree().groups.map((gr) => gr.name)).toEqual(['Y', 'X'])
  })

  it('nhân bản host: có mật khẩu (mã hoá lại cho id mới) và forward, tên không trùng', async () => {
    const { service } = await setup()
    const id = service.saveHost(
      host({ label: 'web', username: 'u', auth: 'password', password: 'S3CRET' })
    )
    service.saveForward({
      hostId: id,
      kind: 'L',
      bindAddr: '127.0.0.1',
      bindPort: 8080,
      destHost: '127.0.0.1',
      destPort: 80,
      autoStart: true
    })
    const copy = service.duplicateHost(id)
    const copy2 = service.duplicateHost(id)
    const labels = service.tree().hosts.map((h) => h.label)
    expect(labels).toEqual(expect.arrayContaining(['web', 'web (copy)', 'web (copy 2)']))
    expect(service.resolveForConnect(copy).credentials.password).toBe('S3CRET')
    expect(service.listForwards(copy)).toHaveLength(1)
    // Sửa mật khẩu bản sao không ảnh hưởng bản gốc (identity riêng).
    service.saveHost({
      ...host({ label: 'web (copy 2)', username: 'u', auth: 'password' }),
      id: copy2,
      password: 'OTHER'
    })
    expect(service.resolveForConnect(id).credentials.password).toBe('S3CRET')
  })
})
