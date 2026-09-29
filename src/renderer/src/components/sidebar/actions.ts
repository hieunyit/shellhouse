import type { HostSummary } from '@shared/hosts'
import { sshCommand } from '@shared/ssh-command'
import { useHosts } from '../../stores/hosts'
import { useTabs, type OpenHostOptions } from '../../stores/tabs'
import { useBroadcast } from '../../terminal/broadcast'

/** Mở quá nhiều phiên một lúc dễ là bấm nhầm — hỏi trước. Lưới quá 16 ô thì không đọc được. */
export const CONFIRM_OPEN_OVER = 8
export const MAX_GRID = 16

export function connect(host: HostSummary, options?: OpenHostOptions): void {
  useTabs.getState().addHost({ id: host.id, label: host.label }, options)
}

/** `multiExec`: mở thành tab rồi bật MultiExec (lưới đều, gõ đồng loạt vào các host vừa mở). */
export function openMany(
  hosts: readonly HostSummary[],
  layout: 'tabs' | 'grid',
  multiExec = false
): void {
  const ids = useTabs.getState().openHosts(
    hosts.map((h) => ({ id: h.id, label: h.label })),
    multiExec ? 'tabs' : layout
  )
  if (multiExec) useBroadcast.getState().start(ids)
}

/** Mọi host trong nhóm (kể cả nhóm con cháu), theo đúng thứ tự hiển thị. */
export function hostsInGroup(groupId: string): HostSummary[] {
  const { tree, groupTree } = useHosts.getState()
  const out: HostSummary[] = []
  const walk = (id: string): void => {
    for (const child of groupTree.children(id)) walk(child.id)
    out.push(...tree.hosts.filter((h) => h.groupId === id))
  }
  walk(groupId)
  return out
}

/** Lệnh ssh tương đương (sau kế thừa từ nhóm). */
export function sshCommandFor(host: HostSummary): string {
  const { tree, effective } = useHosts.getState()
  const eff = effective.get(host.id)
  const endpointOf = (
    h: HostSummary
  ): { username: string | null; hostname: string; port: number } => {
    const e = effective.get(h.id)
    return { username: e?.username ?? null, hostname: h.hostname, port: e?.port ?? h.port ?? 22 }
  }
  const jumps = (eff?.jumpHostIds ?? host.jumpHostIds)
    .map((id) => tree.hosts.find((h) => h.id === id))
    .filter((h): h is HostSummary => !!h)
    .map(endpointOf)
  return sshCommand(endpointOf(host), {
    jumps,
    proxyJump: host.proxyJump,
    keyFile: host.keyFile
  })
}
