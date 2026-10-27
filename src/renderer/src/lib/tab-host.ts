import type { TabTarget } from '../stores/tabs'

/** Host nguồn của terminal, SFTP và tab module (Docker engine/log/shell). */
export function tabHostId(target: TabTarget | undefined): string | null {
  if (!target) return null
  if (target.kind === 'host' || target.kind === 'rdp' || target.kind === 'module-terminal')
    return target.hostId ?? null
  if (target.kind === 'module' && target.params && typeof target.params === 'object') {
    const params = target.params as Record<string, unknown>
    return typeof params['hostId'] === 'string' ? params['hostId'] : null
  }
  return null
}
