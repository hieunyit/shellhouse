import { describe, expect, it } from 'vitest'
import { buildGroupTree } from '../../src/shared/group-tree'
import type { GroupDefaults } from '../../src/shared/hosts'
import {
  effectiveHost,
  inheritedDefaults,
  type GroupWithDefaults,
  type HostOwnValues
} from '../../src/shared/inherit'

const g = (
  id: string,
  parentId: string | null,
  defaults: GroupDefaults = {}
): GroupWithDefaults => ({ id, parentId, name: id.toUpperCase(), sort: 0, defaults })

// prod (user=deploy, port=2222, jump=[bastion], color=red)
// └── db (user=postgres)
//     └── eu (color=orange)
const tree = buildGroupTree([
  g('prod', null, { username: 'deploy', port: 2222, jumpHostIds: ['bastion'], color: 'red' }),
  g('db', 'prod', { username: 'postgres' }),
  g('eu', 'db', { color: 'orange' })
])

const own = (patch: Partial<HostOwnValues> = {}): HostOwnValues => ({
  username: '',
  port: null,
  jumpHostIds: [],
  proxyJump: null,
  direct: false,
  color: null,
  ...patch
})

describe('inheritedDefaults', () => {
  it('mỗi trường lấy từ nhóm gần nhất có đặt nó', () => {
    const d = inheritedDefaults(tree, 'eu')
    expect(d.username).toEqual({ value: 'postgres', groupId: 'db', groupName: 'DB' })
    expect(d.port?.value).toBe(2222)
    expect(d.port?.groupName).toBe('PROD')
    expect(d.color?.value).toBe('orange')
    expect(d.jumpHostIds?.value).toEqual(['bastion'])
    expect(d.keyId).toBeUndefined()
  })

  it('không có nhóm → không kế thừa gì', () => {
    expect(Object.values(inheritedDefaults(tree, null)).every((v) => v === undefined)).toBe(true)
  })
})

describe('effectiveHost', () => {
  it('host để trống → lấy từ nhóm, ghi lại nhóm nguồn', () => {
    const e = effectiveHost(own(), inheritedDefaults(tree, 'eu'))
    expect(e).toMatchObject({
      username: 'postgres',
      port: 2222,
      jumpHostIds: ['bastion'],
      color: 'orange',
      from: { username: 'DB', port: 'PROD', jumpHostIds: 'PROD', color: 'EU' }
    })
  })

  it('host tự đặt giá trị → ghi đè nhóm', () => {
    const e = effectiveHost(
      own({ username: 'root', port: 22, jumpHostIds: ['other'], color: 'green' }),
      inheritedDefaults(tree, 'eu')
    )
    expect(e).toMatchObject({
      username: 'root',
      port: 22,
      jumpHostIds: ['other'],
      color: 'green',
      from: {}
    })
  })

  it('"kết nối thẳng" hoặc có ProxyJump riêng → không kế thừa jump host', () => {
    expect(effectiveHost(own({ direct: true }), inheritedDefaults(tree, 'db')).jumpHostIds).toEqual(
      []
    )
    expect(
      effectiveHost(own({ proxyJump: 'gw' }), inheritedDefaults(tree, 'db')).jumpHostIds
    ).toEqual([])
  })

  it('không nhóm nào đặt port → 22; không có username → null', () => {
    const e = effectiveHost(own(), inheritedDefaults(tree, null))
    expect(e.port).toBe(22)
    expect(e.username).toBeNull()
  })
})
