import { describe, expect, it } from 'vitest'
import type { AccountSummary, GroupSummary, HostSummary, KeySummary } from '@shared/hosts'
import {
  keyInUse,
  keyTypeLabel,
  keyUsage,
  matchKeychain,
  moveSelection,
  publicKeyBits,
  reconcileSelection,
  shortFingerprint,
  visibleItems
} from '../../src/renderer/src/components/accounts/keychain-logic'
import { resolveSettingsSection } from '../../src/renderer/src/components/settings/settings-sections'

const key = (over: Partial<KeySummary>): KeySummary => ({
  id: 'k1',
  name: 'laptop',
  type: 'ed25519',
  fingerprint: 'SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg',
  encrypted: false,
  ...over
})

const account = (over: Partial<AccountSummary>): AccountSummary => ({
  id: 'a1',
  name: 'Deploy',
  username: 'deploy',
  hasPassword: false,
  keyId: null,
  hasPassphrase: false,
  domain: '',
  notes: '',
  hostIds: [],
  updatedAt: 1,
  ...over
})

const host = (over: Partial<HostSummary>): HostSummary =>
  ({
    id: 'h1',
    groupId: null,
    label: 'web',
    hostname: 'web.example',
    port: null,
    username: 'root',
    auth: 'key',
    hasPassword: false,
    keyId: null,
    keyFile: null,
    proxyJump: null,
    jumpHostIds: [],
    mode: 'builtin',
    direct: false,
    tags: [],
    color: null,
    protocol: 'ssh',
    ...over
  }) as HostSummary

const group = (over: Partial<GroupSummary>): GroupSummary => ({
  id: 'g1',
  parentId: null,
  name: 'Prod',
  sort: 0,
  defaults: {},
  ...over
})

/** Dòng public key RSA giả có modulus `bits` bit (wire format: string, mpint e, mpint n). */
function rsaLine(bits: number): string {
  const str = (data: number[]): number[] => [
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...data
  ]
  // mpint dương có bit cao → thêm byte 0 ở đầu.
  const n = [0, 0xc5, ...new Array<number>(bits / 8 - 1).fill(0xab)]
  const blob = [
    ...str(Array.from(new TextEncoder().encode('ssh-rsa'))),
    ...str([1, 0, 1]),
    ...str(n)
  ]
  return `ssh-rsa ${btoa(String.fromCharCode(...blob))} laptop`
}

describe('Keychain: ai đang dùng key', () => {
  it('tài khoản + host trực tiếp + host qua tài khoản (không trùng) + nhóm mặc định', () => {
    const accounts = [
      account({ id: 'a2', name: 'Zeta', keyId: 'k1', hostIds: ['h2', 'h3'] }),
      account({ id: 'a1', name: 'alpha', keyId: 'k1', hostIds: ['h3'] }),
      account({ id: 'a3', name: 'Other', keyId: 'k2', hostIds: ['h4'] })
    ]
    const hosts = [
      host({ id: 'h1', keyId: 'k1' }),
      // Host gắn tài khoản: keyId là của tài khoản — không tính là "trực tiếp".
      host({ id: 'h2', keyId: 'k1', accountId: 'a2' }),
      host({ id: 'h5', keyId: 'k2' })
    ]
    const groups = [group({ id: 'g1', defaults: { keyId: 'k1' } }), group({ id: 'g2' })]
    const usage = keyUsage({ id: 'k1' }, { accounts, hosts, groups })
    expect(usage.accounts.map((a) => a.name)).toEqual(['alpha', 'Zeta'])
    expect(usage.directHostIds).toEqual(['h1'])
    expect(usage.hostIds.sort()).toEqual(['h1', 'h2', 'h3'])
    expect(usage.groups.map((g) => g.id)).toEqual(['g1'])
    expect(keyInUse(usage)).toBe(true)
  })

  it('chỉ là key mặc định của nhóm → vẫn xoá được (như main)', () => {
    const usage = keyUsage(
      { id: 'k1' },
      { accounts: [], hosts: [], groups: [group({ defaults: { keyId: 'k1' } })] }
    )
    expect(keyInUse(usage)).toBe(false)
    expect(usage.groups).toHaveLength(1)
  })
})

describe('Keychain: tìm và lọc', () => {
  const accounts = [
    account({ id: 'a1', name: 'Production deploy', username: 'deploy' }),
    account({ id: 'a2', name: 'Máy chủ Windows', username: 'Administrator', domain: 'CORP' })
  ]
  const keys = [
    key({ id: 'k1', name: 'laptop', fingerprint: 'SHA256:QWERTYuiop123' }),
    key({ id: 'k2', name: 'ci-runner', type: 'rsa', fingerprint: 'SHA256:zzzzXXXX' })
  ]

  it('không có từ khoá: theo tên; Tất cả = tài khoản trước rồi key', () => {
    const m = matchKeychain(accounts, keys, '')
    expect(visibleItems(m, 'all').map((i) => i.id)).toEqual(['a2', 'a1', 'k2', 'k1'])
    expect(visibleItems(m, 'accounts').map((i) => i.id)).toEqual(['a2', 'a1'])
    expect(visibleItems(m, 'keys').map((i) => i.id)).toEqual(['k2', 'k1'])
  })

  it('tìm theo tên / username / domain / loại key; fingerprint chỉ khớp chuỗi con', () => {
    expect(visibleItems(matchKeychain(accounts, keys, 'may chu'), 'all').map((i) => i.id)).toEqual([
      'a2'
    ])
    expect(visibleItems(matchKeychain(accounts, keys, 'rsa'), 'keys').map((i) => i.id)).toEqual([
      'k2'
    ])
    expect(visibleItems(matchKeychain(accounts, keys, 'qwerty'), 'all').map((i) => i.id)).toEqual([
      'k1'
    ])
    // "zx" khớp mờ trong fingerprint "zzzzXXXX" nhưng không phải chuỗi con liền → không khớp.
    expect(visibleItems(matchKeychain([], keys, 'zxzx'), 'all')).toEqual([])
  })
})

describe('Keychain: chọn mục bằng bàn phím', () => {
  const items = visibleItems(
    matchKeychain([account({ id: 'a1' })], [key({ id: 'k1' }), key({ id: 'k2', name: 'm' })], ''),
    'all'
  )

  it('↑/↓ dừng ở hai đầu; Home/End', () => {
    expect(moveSelection(items, null, 'down')).toEqual({ kind: 'account', id: 'a1' })
    expect(moveSelection(items, { kind: 'account', id: 'a1' }, 'down')).toEqual({
      kind: 'key',
      id: 'k1'
    })
    expect(moveSelection(items, { kind: 'account', id: 'a1' }, 'up')).toEqual({
      kind: 'account',
      id: 'a1'
    })
    expect(moveSelection(items, null, 'last')).toEqual({ kind: 'key', id: 'k2' })
    expect(moveSelection([], null, 'down')).toBeNull()
  })

  it('mục đang chọn biến mất (xoá / lọc) → chọn mục ở cùng vị trí, rồi mục đầu', () => {
    const sel = { kind: 'key' as const, id: 'k1' }
    expect(reconcileSelection(items, sel, 1)).toBe(sel)
    expect(reconcileSelection(items, { kind: 'key', id: 'gone' }, 1)).toEqual({
      kind: 'key',
      id: 'k1'
    })
    expect(reconcileSelection(items, { kind: 'key', id: 'gone' }, 9)).toEqual({
      kind: 'key',
      id: 'k2'
    })
    expect(reconcileSelection([], sel, 0)).toBeNull()
  })
})

describe('Keychain: hiển thị key', () => {
  it('số bit từ public key: Ed25519, ECDSA theo đường cong, RSA theo modulus', () => {
    expect(publicKeyBits('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA x')).toBe(256)
    expect(publicKeyBits('ecdsa-sha2-nistp384 AAAA')).toBe(384)
    expect(publicKeyBits(rsaLine(4096))).toBe(4096)
    expect(publicKeyBits(rsaLine(3072))).toBe(3072)
    expect(publicKeyBits('ssh-rsa !!!')).toBeNull()
    expect(publicKeyBits('')).toBeNull()
  })

  it('nhãn loại + fingerprint rút gọn', () => {
    expect(keyTypeLabel('rsa', 4096)).toBe('RSA 4096')
    expect(keyTypeLabel('ed25519', 256)).toBe('ED25519')
    expect(keyTypeLabel('ecdsa', null)).toBe('ECDSA')
    expect(shortFingerprint('SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg')).toBe(
      'SHA256:AbCdEfGh…defg'
    )
    expect(shortFingerprint('SHA256:short')).toBe('SHA256:short')
  })
})

describe('Settings: mục cũ Accounts / SSH keys mở Keychain', () => {
  it('lọc sẵn theo mục cũ', () => {
    expect(resolveSettingsSection('accounts')).toEqual({
      section: 'keychain',
      keychainFilter: 'accounts'
    })
    expect(resolveSettingsSection('keys')).toEqual({ section: 'keychain', keychainFilter: 'keys' })
    expect(resolveSettingsSection('keychain')).toEqual({
      section: 'keychain',
      keychainFilter: 'all'
    })
    expect(resolveSettingsSection('terminal').section).toBe('terminal')
  })
})
