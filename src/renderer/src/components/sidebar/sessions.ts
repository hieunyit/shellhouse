import type { Tab } from '../../stores/tabs'
import type { TerminalState } from '../../terminal/controller'

type ConnectionState = TerminalState

const RANK: Record<ConnectionState, number> = {
  connected: 5,
  reconnecting: 4,
  connecting: 3,
  disconnected: 2,
  idle: 1,
  exited: 0
}

/**
 * Trạng thái "tốt nhất" của các tab tới từng host — tính MỘT lần cho mọi host (trước đây mỗi hàng
 * tự duyệt hết các tab: 2000 host × N tab mỗi lần trạng thái đổi). Nhớ theo (tabs, byTab).
 */
let sessionCache: {
  tabs: readonly Tab[]
  byTab: Record<string, ConnectionState>
  map: Map<string, ConnectionState>
} | null = null
export function sessionsByHost(
  tabs: readonly Tab[],
  byTab: Record<string, ConnectionState>
): Map<string, ConnectionState> {
  if (sessionCache?.tabs === tabs && sessionCache.byTab === byTab) return sessionCache.map
  const map = new Map<string, ConnectionState>()
  for (const tab of tabs) {
    if (tab.target.kind !== 'host') continue
    const state = byTab[tab.id] ?? 'connecting'
    const best = map.get(tab.target.hostId)
    if (!best || RANK[state] > RANK[best]) map.set(tab.target.hostId, state)
  }
  sessionCache = { tabs, byTab, map }
  return map
}
