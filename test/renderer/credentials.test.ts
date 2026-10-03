import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { HostSummary } from '@shared/hosts'

/**
 * Lưu mật khẩu từ hộp hỏi (stores/credentials): chỉ ghi vào vault khi tab kết nối được; gõ sai (bị
 * hỏi lại / phiên kết thúc) thì bỏ. Thanh bên gọn theo loại tab (stores/sidebar-layout).
 */

const saved: [string, string][] = []
const storage = new Map<string, string>()

beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k)
  })
  vi.stubGlobal('window', {
    shellhouse: {
      vaultState: () => Promise.resolve('unlocked'),
      onVaultState: () => () => undefined,
      onHostsChanged: () => () => undefined,
      setHostPassword: (id: string, pw: string) => {
        saved.push([id, pw])
        return Promise.resolve({ ok: true, id })
      }
    }
  })
})

const host = (over: Partial<HostSummary>): HostSummary => ({
  id: 'h1',
  groupId: null,
  label: 'web',
  hostname: 'web.example.com',
  port: 22,
  username: 'deploy',
  auth: 'auto',
  hasPassword: false,
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  direct: false,
  legacyAlgorithms: false,
  protocol: 'ssh',
  serial: null,
  tags: [],
  color: null,
  lastUsedAt: null,
  favorite: false,
  sort: 0,
  ...over
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('stores/credentials', { timeout: 60_000 }, () => {
  it('tìm host đã lưu theo user@host; bỏ host dùng SSH key; ưu tiên host của tab', async () => {
    const { useHosts } = await import('../../src/renderer/src/stores/hosts')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')
    const { savedHostForPassword } = await import('../../src/renderer/src/stores/credentials')
    useHosts.setState({
      tree: {
        groups: [],
        keys: [],
        hosts: [
          host({ id: 'a', lastUsedAt: 5 }),
          host({ id: 'b', lastUsedAt: 1 }),
          host({ id: 'k', auth: 'key', lastUsedAt: 9 })
        ]
      },
      effective: new Map()
    })
    const request = { kind: 'password', username: 'deploy', host: 'WEB.example.com' } as const
    expect(savedHostForPassword(request, null)?.id).toBe('a')
    useTabs.setState({
      tabs: [{ id: 't1', title: 'web', target: { kind: 'host', hostId: 'b' } } as never],
      activeId: 't1'
    })
    expect(savedHostForPassword(request, 't1')?.id).toBe('b')
    expect(savedHostForPassword({ ...request, username: 'root' }, 't1')).toBeNull()
  })

  it('chỉ lưu khi tab kết nối được; bị hỏi lại / ngắt kết nối → không lưu', async () => {
    const { useTabStatus } = await import('../../src/renderer/src/stores/tab-status')
    const { rememberAfterLogin, dropPending } =
      await import('../../src/renderer/src/stores/credentials')
    const entry = {
      kind: 'password' as const,
      key: 'deploy@web.example.com',
      hostId: 'a',
      label: 'web',
      secret: 'pw-1'
    }
    // Đăng nhập được → lưu.
    useTabStatus.getState().set('t1', 'connecting')
    rememberAfterLogin({ ...entry, tabId: 't1' })
    useTabStatus.getState().set('t1', 'connected')
    await flush()
    expect(saved).toEqual([['a', 'pw-1']])

    // Gõ sai: server hỏi lại → bỏ cái đang chờ.
    useTabStatus.getState().set('t2', 'connecting')
    rememberAfterLogin({ ...entry, tabId: 't2', secret: 'wrong' })
    dropPending('t2', 'password', entry.key)
    useTabStatus.getState().set('t2', 'connected')
    await flush()
    expect(saved).toHaveLength(1)

    // Phiên kết thúc trước khi kết nối được → bỏ.
    useTabStatus.getState().set('t3', 'connecting')
    rememberAfterLogin({ ...entry, tabId: 't3', secret: 'nope' })
    useTabStatus.getState().set('t3', 'disconnected')
    useTabStatus.getState().set('t3', 'connected')
    await flush()
    expect(saved).toHaveLength(1)
  })

  it('passphrase nhớ trong phiên; tự trả lời một lần, bị hỏi lại ngay trong cùng tab → quên', async () => {
    const { useTabStatus } = await import('../../src/renderer/src/stores/tab-status')
    const { rememberAfterLogin, takeRememberedPassphrase } =
      await import('../../src/renderer/src/stores/credentials')
    expect(takeRememberedPassphrase('~/.ssh/id_ed25519', 't4')).toBeNull()
    useTabStatus.getState().set('t4', 'connecting')
    rememberAfterLogin({
      kind: 'passphrase',
      tabId: 't4',
      key: '~/.ssh/id_ed25519',
      hostId: null,
      label: '~/.ssh/id_ed25519',
      secret: 'pp'
    })
    useTabStatus.getState().set('t4', 'connected')
    await flush()
    expect(saved).toHaveLength(1) // passphrase không vào vault
    expect(takeRememberedPassphrase('~/.ssh/id_ed25519', 't5')).toBe('pp')
    // Tab khác dùng chung được.
    expect(takeRememberedPassphrase('~/.ssh/id_ed25519', 't6')).toBe('pp')
    // Cùng tab bị hỏi lại ngay → passphrase sai → quên.
    expect(takeRememberedPassphrase('~/.ssh/id_ed25519', 't5')).toBeNull()
    expect(takeRememberedPassphrase('~/.ssh/id_ed25519', 't7')).toBeNull()
  })
})

describe('stores/sidebar-layout', () => {
  it('tab module mặc định gọn, tab khác đầy đủ; nhớ lựa chọn theo loại', async () => {
    const { modeForTab, useSidebarLayout } =
      await import('../../src/renderer/src/stores/sidebar-layout')
    expect(modeForTab('module')).toBe('module')
    expect(modeForTab('host')).toBe('default')
    expect(modeForTab(undefined)).toBe('default')
    expect(useSidebarLayout.getState().compact).toEqual({ module: true, default: false })
    useSidebarLayout.getState().setCompact('module', false)
    expect(JSON.parse(storage.get('shellhouse.sidebar.compact') ?? '{}')).toEqual({
      module: false,
      default: false
    })
  })
})

describe('TagInput: addTags', () => {
  it('tách theo dấu phẩy / xuống dòng, bỏ trùng không phân biệt hoa thường, giới hạn độ dài', async () => {
    const { addTags, MAX_TAG_LENGTH } = await import('../../src/renderer/src/components/TagInput')
    expect(addTags(['prod'], ' web, Prod ,db\nweb ')).toEqual(['prod', 'web', 'db'])
    expect(addTags([], ' , ')).toEqual([])
    expect(addTags([], 'x'.repeat(60))[0]).toHaveLength(MAX_TAG_LENGTH)
  })
})

describe('HostForm: portProblem', { timeout: 60_000 }, () => {
  it('trống = mặc định; chỉ nhận số nguyên 1–65535', async () => {
    const { portProblem } = await import('../../src/renderer/src/components/HostForm')
    expect(portProblem('')).toBeNull()
    expect(portProblem(' 2222 ')).toBeNull()
    expect(portProblem('0')).not.toBeNull()
    expect(portProblem('65536')).not.toBeNull()
    expect(portProblem('22a')).not.toBeNull()
  })
})
