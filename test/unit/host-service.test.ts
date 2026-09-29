import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { utils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import type { HostInput } from '@shared/hosts'
import { Secret } from '../../src/node-shared/secret'
import { fingerprintSha256 } from '../../src/node-shared/hostkey'
import { HostService, publicKeyFromOpenSshHeader } from '../../src/main/hosts/service'
import { openDatabase } from '../../src/main/store/db'
import { migrate, schemaVersion } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { generateTestKey } from '../integration/ssh-test-server'
import { MAX_GROUP_DEPTH } from '../../src/shared/group-tree'
import { tempDir } from './helpers'

async function setup(path = ':memory:') {
  const db = openDatabase(path)
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
  const service = new HostService(db, vault, () => ++clock)
  return { db, vault, service }
}

const base: HostInput = {
  groupId: null,
  label: 'Web',
  hostname: 'web.example.com',
  port: 22,
  username: 'deploy',
  auth: 'auto',
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  tags: [],
  color: null
}

describe('HostService', () => {
  it('schema đã lên bản mới nhất', async () => {
    const { db } = await setup()
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
  })

  it('tạo host auto; tree không chứa secret', async () => {
    const { service } = await setup()
    const id = service.saveHost({ ...base, tags: ['prod', 'prod', 'web'], color: 'red' })
    const host = service.tree().hosts[0]
    expect(host).toMatchObject({
      id,
      label: 'Web',
      username: 'deploy',
      auth: 'auto',
      hasPassword: false,
      tags: ['prod', 'web'],
      color: 'red'
    })
    expect(service.resolveForConnect(id)).toEqual({
      label: 'Web',
      target: { host: 'web.example.com', port: 22, username: 'deploy' },
      credentials: {},
      mode: 'builtin',
      jumps: [],
      keyFile: null
    })
  })

  it('mật khẩu: mã hoá trong DB, giữ nguyên khi sửa mà không nhập lại, xoá bằng chuỗi rỗng', async () => {
    const path = join(tempDir(), 'h.db')
    const { db, service } = await setup(path)
    const id = service.saveHost({ ...base, auth: 'password', password: 'PW-MARKER-987' })
    expect(service.tree().hosts[0]?.hasPassword).toBe(true)
    db.pragma('wal_checkpoint(TRUNCATE)')
    expect(readFileSync(path).includes('PW-MARKER-987')).toBe(false)
    expect(JSON.stringify(service.tree())).not.toContain('PW-MARKER-987')

    service.saveHost({ ...base, id, label: 'Web 2', auth: 'password' }) // password undefined = giữ
    expect(service.resolveForConnect(id).credentials.password).toBe('PW-MARKER-987')

    service.saveHost({ ...base, id, auth: 'password', password: '' })
    expect(service.tree().hosts[0]?.hasPassword).toBe(false)
    expect(service.resolveForConnect(id).credentials.password).toBeUndefined()
  })

  it('vault khoá → không lưu được mật khẩu, không giải mã được', async () => {
    const { vault, service } = await setup()
    const id = service.saveHost({ ...base, auth: 'password', password: 'x' })
    vault.lock()
    expect(() => service.resolveForConnect(id)).toThrow(/locked/)
    expect(() => service.saveHost({ ...base, auth: 'password', password: 'y' })).toThrow(/locked/)
    // Host không có secret vẫn kết nối được khi vault khoá.
    expect(service.resolveForConnect(service.saveHost(base)).target.host).toBe('web.example.com')
  })

  it('xoá host: biến mất khỏi tree, secret bị xoá, không kết nối được', async () => {
    const { db, service } = await setup()
    const id = service.saveHost({ ...base, auth: 'password', password: 'x' })
    service.deleteHost(id)
    expect(service.tree().hosts).toHaveLength(0)
    expect(() => service.resolveForConnect(id)).toThrow(/not found/)
    const identity = db.prepare('SELECT secret_enc FROM identities').get() as {
      secret_enc: unknown
    }
    expect(identity.secret_enc).toBeNull()
  })

  it('nhóm: tạo lồng nhau, chặn vòng lặp, chặn trùng tên cùng cấp', async () => {
    const { service } = await setup()
    const parent = service.saveGroup({ parentId: null, name: 'Prod' })
    const child = service.saveGroup({ parentId: parent, name: 'DB' })
    expect(() => service.saveGroup({ id: parent, parentId: child, name: 'Prod' })).toThrow(
      /itself or one of its subgroups/
    )
    expect(() => {
      service.moveGroup(parent, child)
    }).toThrow(/itself/)
    // Trùng tên (không phân biệt hoa thường) chỉ bị chặn trong cùng một nhóm cha.
    expect(() => service.saveGroup({ parentId: parent, name: 'db' })).toThrow(/already a group/)
    expect(service.saveGroup({ parentId: null, name: 'DB' })).toBeTruthy()
    // Đổi tên chính nó (giữ nguyên tên) không tính là trùng.
    expect(service.saveGroup({ id: child, parentId: parent, name: 'DB' })).toBe(child)
  })

  it('nhóm: di chuyển cả cây con; giới hạn độ sâu', async () => {
    const { service } = await setup()
    const a = service.saveGroup({ parentId: null, name: 'A' })
    const b = service.saveGroup({ parentId: a, name: 'B' })
    const host = service.saveHost({ ...base, groupId: b })
    const other = service.saveGroup({ parentId: null, name: 'Other' })
    service.moveGroup(a, other)
    const tree = service.tree()
    expect(tree.groups.find((g) => g.id === a)?.parentId).toBe(other)
    expect(tree.groups.find((g) => g.id === b)?.parentId).toBe(a)
    expect(tree.hosts.find((h) => h.id === host)?.groupId).toBe(b)
    service.moveGroup(a, null)
    expect(service.tree().groups.find((g) => g.id === a)?.parentId).toBeNull()

    let parent: string | null = null
    for (let i = 0; i < MAX_GROUP_DEPTH; i++)
      parent = service.saveGroup({ parentId: parent, name: `L${i}` })
    expect(() => service.saveGroup({ parentId: parent, name: 'too deep' })).toThrow(/at most/)
  })

  it('xoá nhóm không mất gì: host và nhóm con dời lên nhóm cha, tên trùng được đổi', async () => {
    const { service } = await setup()
    const prod = service.saveGroup({ parentId: null, name: 'Prod' })
    const eu = service.saveGroup({ parentId: prod, name: 'EU' })
    const db = service.saveGroup({ parentId: eu, name: 'DB' })
    service.saveGroup({ parentId: prod, name: 'DB' }) // trùng tên với nhóm con của EU
    const inEu = service.saveHost({ ...base, label: 'eu-1', groupId: eu })
    const inDb = service.saveHost({ ...base, label: 'db-1', groupId: db })

    service.deleteGroup(eu)
    const tree = service.tree()
    expect(tree.groups.some((g) => g.id === eu)).toBe(false)
    expect(tree.hosts.find((h) => h.id === inEu)?.groupId).toBe(prod)
    expect(tree.hosts.find((h) => h.id === inDb)?.groupId).toBe(db) // vẫn ở nhóm cũ
    const moved = tree.groups.find((g) => g.id === db)
    expect(moved?.parentId).toBe(prod)
    expect(moved?.name).toBe('DB (2)')

    service.deleteGroup(prod) // cấp cao nhất → mọi thứ ra ngoài cùng
    const after = service.tree()
    expect(after.hosts.find((h) => h.id === inEu)?.groupId).toBeNull()
    expect(
      after.groups
        .filter((g) => g.parentId === null)
        .map((g) => g.name)
        .sort()
    ).toEqual(['DB', 'DB (2)'])
  })

  it('key không passphrase: nhập, gắn vào host, giải mã khi kết nối', async () => {
    const { service } = await setup()
    const pair = generateTestKey()
    const key = service.importKey('laptop', pair.private)
    const parsed = utils.parseKey(pair.public)
    if (parsed instanceof Error) throw parsed
    expect(key).toMatchObject({ name: 'laptop', type: 'ed25519', encrypted: false })
    expect(key.fingerprint).toBe(fingerprintSha256(parsed.getPublicSSH()))

    const id = service.saveHost({ ...base, auth: 'key', keyId: key.id })
    const creds = service.resolveForConnect(id).credentials
    expect(creds.privateKey?.data).toBe(pair.private)
    expect(creds.privateKey?.passphrase).toBeUndefined()
    expect(() => {
      service.deleteKey(key.id)
    }).toThrow(/used by 1 host/)
  })

  it('key có passphrase (tạo bằng ssh-keygen): đọc fingerprint không cần passphrase', async () => {
    const { service } = await setup()
    const dir = tempDir()
    const keyPath = join(dir, 'k')
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'pp', '-f', keyPath])
    } catch {
      return // không có ssh-keygen
    }
    const pem = readFileSync(keyPath, 'utf8')
    const pub = readFileSync(`${keyPath}.pub`, 'utf8').split(' ')[1] ?? ''
    const key = service.importKey('enc', pem)
    expect(key.encrypted).toBe(true)
    expect(key.fingerprint).toBe(fingerprintSha256(Buffer.from(pub, 'base64')))
    expect(service.tree().keys[0]?.encrypted).toBe(true)

    const id = service.saveHost({ ...base, auth: 'key', keyId: key.id, passphrase: 'pp' })
    expect(service.resolveForConnect(id).credentials.privateKey?.passphrase).toBe('pp')
  })

  it('từ chối file không phải private key', async () => {
    const { service } = await setup()
    expect(() => service.importKey('x', 'không phải key')).toThrow(/Could not read the key/)
    const pair = generateTestKey()
    expect(() => service.importKey('pub', pair.public)).toThrow(/public key/)
  })

  it('auth=key mà thiếu key → lỗi', async () => {
    const { service } = await setup()
    expect(() => service.saveHost({ ...base, auth: 'key', keyId: null })).toThrow(/No key selected/)
  })

  it('jump host: chuỗi lồng nhau được phẳng hoá theo thứ tự, mỗi chặng có credentials riêng', async () => {
    const { service } = await setup()
    const outer = service.saveHost({
      ...base,
      label: 'outer',
      hostname: 'outer.example',
      auth: 'password',
      password: 'p-outer'
    })
    const inner = service.saveHost({
      ...base,
      label: 'inner',
      hostname: 'inner.example',
      jumpHostIds: [outer]
    })
    const app = service.saveHost({
      ...base,
      label: 'app',
      hostname: 'app.internal',
      jumpHostIds: [inner]
    })
    const resolved = service.resolveForConnect(app)
    expect(resolved.jumps.map((j) => j.target.host)).toEqual(['outer.example', 'inner.example'])
    expect(resolved.jumps[0]?.credentials.password).toBe('p-outer')
    expect(resolved.target.host).toBe('app.internal')
    expect(service.tree().hosts.find((h) => h.id === app)?.jumpHostIds).toEqual([inner])
  })

  it('jump host: chặn tự trỏ và vòng lặp', async () => {
    const { service } = await setup()
    const a = service.saveHost({ ...base, label: 'a' })
    const b = service.saveHost({ ...base, label: 'b', jumpHostIds: [a] })
    expect(() => service.saveHost({ ...base, id: a, label: 'a', jumpHostIds: [a] })).toThrow(
      /its own jump host/
    )
    expect(() => service.saveHost({ ...base, id: a, label: 'a', jumpHostIds: [b] })).toThrow(
      /contains a loop/
    )
    expect(() => service.saveHost({ ...base, label: 'c', jumpHostIds: ['khong-ton-tai'] })).toThrow(
      /not found/
    )
  })

  it('ProxyJump từ ~/.ssh/config: alias host đã lưu hoặc user@host:port', async () => {
    const { service } = await setup()
    service.saveHost({ ...base, label: 'Bastion', hostname: 'bastion.example', username: 'jb' })
    const id = service.saveHost({
      ...base,
      label: 'db',
      hostname: 'db.internal',
      proxyJump: 'bastion, ops@10.0.0.9:2222'
    })
    const resolved = service.resolveForConnect(id, 'localuser')
    expect(resolved.jumps.map((j) => j.target)).toEqual([
      { host: 'bastion.example', port: 22, username: 'jb' },
      { host: '10.0.0.9', port: 2222, username: 'ops' }
    ])
    const bad = service.saveHost({ ...base, label: 'bad', proxyJump: '-oProxyCommand=x' })
    expect(() => service.resolveForConnect(bad)).toThrow(/Invalid ProxyJump/)
  })

  it('chế độ system được lưu và trả về', async () => {
    const { service } = await setup()
    const id = service.saveHost({ ...base, mode: 'system', keyFile: '/home/u/.ssh/id_x' })
    expect(service.tree().hosts[0]?.mode).toBe('system')
    expect(service.resolveForConnect(id)).toMatchObject({
      mode: 'system',
      keyFile: '/home/u/.ssh/id_x'
    })
  })

  it('forward lưu theo host: thêm, sửa, xoá mềm; D không lưu đích', async () => {
    const { service } = await setup()
    const host = service.saveHost(base)
    const l = service.saveForward({
      hostId: host,
      kind: 'L',
      bindAddr: '127.0.0.1',
      bindPort: 5432,
      destHost: 'db.internal',
      destPort: 5432,
      autoStart: true
    })
    service.saveForward({
      hostId: host,
      kind: 'D',
      bindAddr: '127.0.0.1',
      bindPort: 1080,
      destHost: 'ignored.example',
      destPort: 1,
      autoStart: false
    })
    expect(service.listForwards(host).map((f) => [f.kind, f.destHost, f.autoStart])).toEqual([
      ['L', 'db.internal', true],
      ['D', null, false]
    ])
    service.saveForward({
      id: l,
      hostId: host,
      kind: 'L',
      bindAddr: '127.0.0.1',
      bindPort: 15432,
      destHost: 'db.internal',
      destPort: 5432,
      autoStart: false
    })
    expect(service.listForwards(host)[0]).toMatchObject({ bindPort: 15432, autoStart: false })
    service.deleteForward(l)
    expect(service.listForwards(host)).toHaveLength(1)
    expect(() =>
      service.saveForward({
        hostId: 'x',
        kind: 'D',
        bindAddr: '127.0.0.1',
        bindPort: 1,
        destHost: null,
        destPort: null,
        autoStart: false
      })
    ).toThrow(/not found/)
  })

  it('cập nhật forward không tồn tại → lỗi thay vì im lặng không lưu gì', async () => {
    const { service } = await setup()
    const host = service.saveHost(base)
    expect(() =>
      service.saveForward({
        id: 'khong-co',
        hostId: host,
        kind: 'D',
        bindAddr: '127.0.0.1',
        bindPort: 1080,
        destHost: null,
        destPort: null,
        autoStart: false
      })
    ).toThrow(/Forward not found/)
    expect(service.listForwards(host)).toHaveLength(0)
  })

  it('publicKeyFromOpenSshHeader từ chối dữ liệu rác', () => {
    expect(publicKeyFromOpenSshHeader('xyz')).toBeNull()
  })
})
