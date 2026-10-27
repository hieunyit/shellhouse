import { expect, it, vi } from 'vitest'
import type { TabTarget } from '../../src/renderer/src/stores/tabs'
vi.mock('../../src/renderer/src/stores/tabs', () => ({ useTabs: {} }))
vi.mock('../../src/renderer/src/terminal/registry', () => ({ controllers: new Map() }))
vi.mock('../../src/modules/registry/renderer-kit', () => ({
  moduleTab: (_module: string, tab: string) => ({ multiExec: tab === 'terminal' })
}))
import { joinsMultiExec } from '../../src/renderer/src/terminal/broadcast'
it.each<TabTarget>([
  { kind: 'editor', key: 'a' },
  { kind: 'rdp', hostId: 'a' },
  { kind: 'home' },
  { kind: 'module', module: 'test', tab: 'browser', params: {} }
])('không thêm tab $kind vào MultiExec', (target) => {
  expect(joinsMultiExec(target)).toBe(false)
})
it.each<TabTarget>([
  { kind: 'local' },
  { kind: 'host', hostId: 'a' },
  { kind: 'ssh', host: 'localhost', port: 22, username: 'u' },
  { kind: 'module', module: 'test', tab: 'terminal', params: {} }
])('thêm terminal $kind vào MultiExec', (target) => {
  expect(joinsMultiExec(target)).toBe(true)
})
