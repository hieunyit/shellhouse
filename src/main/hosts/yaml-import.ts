import { parse } from 'yaml'
import { Hostname, Port, Username, type ImportCandidate } from '@shared/hosts'
import { t } from '@shared/i18n'

/**
 * Nhập lại file "Shellhouse YAML" (Export hosts — @shared/host-export): cây nhóm lồng nhau, host
 * kế thừa username / port mặc định của nhóm. Không có bí mật nào trong file để đọc.
 */
interface YHost {
  label?: unknown
  hostname?: unknown
  port?: unknown
  username?: unknown
  account?: unknown
  protocol?: unknown
  tags?: unknown
}
interface YGroup {
  name?: unknown
  defaults?: { username?: unknown; port?: unknown }
  groups?: unknown
  hosts?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined

export function scanShellhouseYaml(
  text: string,
  options: { existingLabels: readonly string[]; defaultUser: string | null }
): { candidates: ImportCandidate[]; ignored: Record<string, number> } {
  const doc: unknown = parse(text)
  if (typeof doc !== 'object' || doc === null || !('shellhouse' in doc))
    throw new Error(t('This is not a Shellhouse hosts file (exported with Export hosts).'))
  const existing = new Set(options.existingLabels)
  const candidates: ImportCandidate[] = []
  const ignored: Record<string, number> = {}
  const seen = new Set<string>()
  const add = (
    h: YHost,
    group: string[],
    inherited: { username?: string | undefined; port?: number | undefined }
  ): void => {
    const protocol = str(h.protocol) ?? 'ssh'
    if (protocol !== 'ssh') {
      const kind = protocol.toUpperCase()
      ignored[kind] = (ignored[kind] ?? 0) + 1
      return
    }
    const label = str(h.label) ?? str(h.hostname) ?? ''
    let alias = [...group, label].join(' / ')
    for (let i = 2; seen.has(alias); i++) alias = `${[...group, label].join(' / ')} (${String(i)})`
    seen.add(alias)
    const hostname = str(h.hostname) ?? ''
    const port = num(h.port) ?? inherited.port ?? 22
    const username = str(h.username) ?? inherited.username ?? options.defaultUser
    const account = str(h.account)
    const problem = !Hostname.safeParse(hostname).success
      ? t('Invalid hostname')
      : !Port.safeParse(port).success
        ? t('The port must be between 1 and 65535')
        : !username
          ? account
            ? t('Uses the shared account “{name}” — set it after importing', { name: account })
            : t('No username')
          : !Username.safeParse(username).success
            ? t('Invalid username')
            : null
    candidates.push({
      alias,
      label,
      group,
      ...(Array.isArray(h.tags)
        ? { tags: h.tags.filter((x): x is string => typeof x === 'string') }
        : {}),
      hostname,
      port,
      username: username ?? null,
      keyFile: null,
      proxyJump: null,
      duplicate: existing.has(label),
      problem
    })
  }
  const walk = (
    g: YGroup,
    path: string[],
    inherited: { username?: string | undefined; port?: number | undefined }
  ): void => {
    const name = str(g.name)
    if (!name) return
    const here = [...path, name]
    const next = {
      username: str(g.defaults?.username) ?? inherited.username,
      port: num(g.defaults?.port) ?? inherited.port
    }
    if (Array.isArray(g.hosts)) for (const h of g.hosts as YHost[]) add(h, here, next)
    if (Array.isArray(g.groups)) for (const c of g.groups as YGroup[]) walk(c, here, next)
  }
  const root = doc as { groups?: unknown; hosts?: unknown }
  if (Array.isArray(root.groups)) for (const g of root.groups as YGroup[]) walk(g, [], {})
  if (Array.isArray(root.hosts)) for (const h of root.hosts as YHost[]) add(h, [], {})
  return { candidates, ignored }
}
