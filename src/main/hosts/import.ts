import log from 'electron-log/main'
import { t } from '@shared/i18n'
import { HostInput, type ImportCandidate, type ImportOptions } from '@shared/hosts'
import type { HostService } from './service'

/** Import into the selected existing group (or no group), never recreating source folders. */
export function importCandidates(
  service: HostService,
  candidates: readonly ImportCandidate[],
  aliases: readonly string[],
  tag: string,
  options: ImportOptions = {}
): { imported: number; skipped: string[] } {
  const wanted = new Set(aliases)
  let imported = 0
  const available = new Set(candidates.map((candidate) => candidate.alias))
  const skipped = [...wanted].filter((alias) => !available.has(alias))
  if (options.groupId && !service.groups().some((g) => g.id === options.groupId))
    throw new Error(t('The group no longer exists'))
  // Một transaction cho cả lượt (mỗi host là một savepoint lồng bên trong: host lỗi chỉ bỏ host đó).
  return service.batch(() => {
    for (const c of candidates) {
      if (!wanted.delete(c.alias)) continue
      // User nhập lúc nhập thay user của file (và điền cho host file không ghi user).
      const username = options.username ?? c.username
      if (c.problem || !username) {
        skipped.push(c.alias)
        continue
      }
      try {
        service.saveHost(
          HostInput.parse({
            groupId: options.groupId || null,
            label: c.label ?? c.alias,
            hostname: c.hostname,
            port: c.port,
            username,
            // Key chọn lúc nhập (trong vault) thay IdentityFile của file.
            ...(options.keyId
              ? { auth: 'key' as const, keyId: options.keyId, keyFile: null }
              : { auth: 'auto' as const, keyId: null, keyFile: c.keyFile }),
            // Jump host chọn lúc nhập thay ProxyJump của file.
            ...(options.jumpHostId
              ? { proxyJump: null, jumpHostIds: [options.jumpHostId] }
              : { proxyJump: c.proxyJump, jumpHostIds: [] }),
            mode: 'builtin',
            tags: [
              ...new Set([
                tag,
                ...(c.tags ?? [])
                  .map((value) => value.trim())
                  .filter((value) => value && value.length <= 40)
              ])
            ].slice(0, 20),
            color: null
          })
        )
        imported++
      } catch (error) {
        log.warn(`Skipping ${c.alias}: ${error instanceof Error ? error.message : String(error)}`)
        skipped.push(c.alias)
      }
    }
    return { imported, skipped }
  })
}
