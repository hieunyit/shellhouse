import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Khung app mới (shell/store): tab ↔ khu vực trên activity bar. Chọn tab → khu vực theo tab; đóng
 * tab cuối của khu vực → ở lại (trạng thái rỗng); chọn khu vực → mở lại tab gần nhất; đóng tab ưu
 * tiên tab kề bên cùng khu vực.
 */

const storage = new Map<string, string>()

beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k)
  })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
  vi.stubGlobal('window', {
    shellhouse: {
      onSettingsChanged: () => () => undefined,
      getSettings: () => new Promise(() => undefined),
      updateSettings: () => Promise.resolve()
    }
  })
})

async function load() {
  const { useShell, tabArea } = await import('../../src/renderer/src/shell/store')
  const { useTabs } = await import('../../src/renderer/src/stores/tabs')
  return { useShell, useTabs, tabArea }
}

const k8s = { kind: 'module' as const, module: 'k8s', tab: 'cluster', params: {} }
const docker = { kind: 'module' as const, module: 'docker', tab: 'endpoint', params: {} }

beforeEach(async () => {
  const { useShell, useTabs } = await load()
  useTabs.setState({ tabs: [], activeId: null, closed: [] })
  useShell.setState({ area: 'home', lastTab: {}, history: ['home'], historyAt: 0 })
})

describe('shell/store', () => {
  it('khu vực của tab: Home, Hosts (Files khi là trình quản lý file), module', async () => {
    const { tabArea } = await load()
    expect(tabArea({ target: { kind: 'home' } })).toBe('home')
    expect(tabArea({ target: { kind: 'local' } })).toBe('hosts')
    expect(tabArea({ target: { kind: 'host', hostId: 'h' }, view: 'files' })).toBe('files')
    expect(tabArea({ target: k8s })).toBe('m:k8s')
  })

  it('mở / chọn tab → khu vực đi theo; ghi lịch sử cho ← / →', async () => {
    const { useShell, useTabs } = await load()
    const term = useTabs.getState().addLocal()
    expect(useShell.getState().area).toBe('hosts')
    const cluster = useTabs.getState().addTarget('prod', k8s)
    expect(useShell.getState().area).toBe('m:k8s')
    useTabs.getState().activate(term)
    expect(useShell.getState().area).toBe('hosts')
    expect(useShell.getState().lastTab).toMatchObject({ hosts: term, 'm:k8s': cluster })
    useShell.getState().back()
    expect(useShell.getState().area).toBe('m:k8s')
    expect(useTabs.getState().activeId).toBe(cluster)
    useShell.getState().forward()
    expect(useShell.getState().area).toBe('hosts')
  })

  it('chọn khu vực → mở lại tab dùng gần nhất của khu vực; không có thì chỉ đổi khu vực', async () => {
    const { useShell, useTabs } = await load()
    const a = useTabs.getState().addTarget('a', k8s)
    const b = useTabs.getState().addTarget('b', k8s)
    useTabs.getState().activate(a)
    useTabs.getState().addLocal()
    useShell.getState().go('m:k8s')
    expect(useTabs.getState().activeId).toBe(a)
    useShell.getState().go('m:docker')
    expect(useShell.getState().area).toBe('m:docker')
    expect(useTabs.getState().activeId).toBe(a)
    useTabs.getState().activate(b)
    expect(useShell.getState().area).toBe('m:k8s')
  })

  it('đóng tab: ưu tiên tab kề bên cùng khu vực; tab cuối của khu vực → giữ khu vực', async () => {
    const { useShell, useTabs } = await load()
    const term = useTabs.getState().addLocal()
    const d1 = useTabs.getState().addTarget('d1', docker)
    useTabs.getState().addLocal()
    const d2 = useTabs.getState().addTarget('d2', docker)
    useTabs.getState().activate(d1)
    useTabs.getState().close(d1)
    // Kề bên (index) là terminal, nhưng tab Docker còn lại được chọn.
    expect(useTabs.getState().activeId).toBe(d2)
    expect(useShell.getState().area).toBe('m:docker')
    useTabs.getState().close(d2)
    expect(useShell.getState().area).toBe('m:docker')
    expect(useTabs.getState().activeId).not.toBe(d2)
    useShell.getState().go('hosts')
    expect(useShell.getState().area).toBe('hosts')
    expect(useTabs.getState().tabs.some((x) => x.id === term)).toBe(true)
  })

  it('Home: chưa có tab Home thì mở', async () => {
    const { useShell, useTabs } = await load()
    useTabs.getState().addLocal()
    useShell.getState().go('home')
    const active = useTabs.getState().tabs.find((x) => x.id === useTabs.getState().activeId)
    expect(active?.target.kind).toBe('home')
    expect(useShell.getState().area).toBe('home')
  })

  it('Settings mở đúng mục và nằm trong lịch sử', async () => {
    const { useShell } = await load()
    useShell.getState().openSettings('keychain')
    expect(useShell.getState().area).toBe('settings')
    expect(useShell.getState().settingsSection).toBe('keychain')
    useShell.getState().back()
    expect(useShell.getState().area).toBe('home')
  })
})

describe('shell/store: tab mở từ khu vực khác', () => {
  it('đóng editor mở từ S3 → quay lại khu vực S3', async () => {
    const { useShell, useTabs } = await load()
    useTabs.getState().addLocal()
    const s3 = useTabs.getState().addTarget('bucket', {
      kind: 'module',
      module: 's3',
      tab: 'browser',
      params: {}
    })
    expect(useShell.getState().area).toBe('m:s3')
    const editor = useTabs.getState().openEditor('a.txt', 's3://a.txt')
    expect(useShell.getState().area).toBe('hosts')
    useTabs.getState().close(editor)
    expect(useShell.getState().area).toBe('m:s3')
    expect(useTabs.getState().activeId).toBe(s3)
  })
})
