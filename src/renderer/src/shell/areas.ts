import type { Tab, TabTarget } from '../stores/tabs'

/** Khu vực của khung app (activity bar) — xem shell/store.ts. */
export type Area = 'home' | 'hosts' | 'files' | 'transfers' | 'settings' | `m:${string}`

/** Tab nằm trong dockview (phiên, chia màn hình) hay là "trang" riêng của khu vực. */
export function inDockview(target: TabTarget): boolean {
  return target.kind !== 'module' && target.kind !== 'home'
}

export function tabArea(tab: Pick<Tab, 'target' | 'view'>): Area {
  const { target } = tab
  if (target.kind === 'home') return 'home'
  if (target.kind === 'module') return `m:${target.module}`
  if (tab.view === 'files') return 'files'
  return 'hosts'
}

/** Hosts và Files dùng chung một dockview (tab trình quản lý file vẫn là phiên SSH). */
export function sharesDockview(area: Area): boolean {
  return area === 'hosts' || area === 'files'
}
