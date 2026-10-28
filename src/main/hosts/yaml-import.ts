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
  jump?: unknown
}
interface YGroup {
  name?: unknown
  defaults?: unknown
  groups?: unknown
  hosts?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(t('Could not read this entry'))
  return value as Record<string, unknown>
}

function entries(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(t('Could not read this entry'))
  return value
}

export function scanShellhouseYaml(
  text: string,
  options: { existingLabels: readonly string[]; defaultUser: string | null }
): { candidates: ImportCandidate[]; ignored: Record<string, number> } {
  const doc: unknown = parse(text)
  if (typeof doc !== 'object' || doc === null || !('shellhouse' in doc))
    throw new Error(t('This is not a Shellhouse hosts file (exported with Export hosts).'))
  if (doc.shellhouse !== 1)
    throw new Error(t('This is not a Shellhouse hosts file (exported with Export hosts).'))
  const existing = new Set(options.existingLabels.map((label) => label.toLowerCase()))
  const candidates: ImportCandidate[] = []
  const ignored: Record<string, number> = {}
  const seen = new Set<string>()
  const add = (
    h: YHost,
    group: string[],
    inherited: { username?: string | undefined; port?: unknown; jump?: unknown }
  ): void => {
    const protocol = str(h.protocol) ?? 'ssh'
    if (protocol !== 'ssh') {
      const kind = protocol.toUpperCase()
      ignored[kind] = (ignored[kind] ?? 0) + 1
      return
    }
    const label = (str(h.label) ?? str(h.hostname) ?? '').trim().slice(0, 100)
    let alias = [...group, label].join(' / ')
    for (let i = 2; seen.has(alias); i++) alias = `${[...group, label].join(' / ')} (${String(i)})`
    seen.add(alias)
    const hostname = str(h.hostname) ?? ''
    const port = h.port ?? inherited.port ?? 22
    const account = str(h.account)
    const username =
      str(h.username) ?? (account ? null : (inherited.username ?? options.defaultUser))
    const jump = h.jump ?? inherited.jump
    const jumpNames = Array.isArray(jump)
      ? jump.filter((value): value is string => typeof value === 'string')
      : []
    const warnings = [
      ...(account
        ? [t('Uses the shared account “{name}” — set it after importing', { name: account })]
        : []),
      ...(jumpNames.length
        ? [
            t('Choose a jump host below or configure it after importing: {names}.', {
              names: jumpNames.join(', ')
            })
          ]
        : [])
    ]
    const problem = !label
      ? t('A label is required')
      : !Hostname.safeParse(hostname).success
        ? t('Invalid hostname')
        : !Port.safeParse(port).success
          ? t('The port must be between 1 and 65535')
          : username !== null && !Username.safeParse(username).success
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
      port: typeof port === 'number' && Number.isInteger(port) ? port : 22,
      username: username ?? null,
      keyFile: null,
      proxyJump: null,
      duplicate: existing.has(label.toLowerCase()),
      problem,
      warning: warnings.length ? warnings.join(' · ') : null
    })
  }
  const active = new WeakSet<object>()
  const walk = (
    g: YGroup,
    path: string[],
    inherited: { username?: string | undefined; port?: unknown; jump?: unknown }
  ): void => {
    if (path.length >= 20 || active.has(g)) throw new Error(t('Could not read this entry'))
    active.add(g)
    const name = str(g.name)
    if (!name) throw new Error(t('Could not read this entry'))
    const here = [...path, name]
    const defaults = g.defaults == null ? {} : record(g.defaults)
    const next = {
      username: str(defaults['username']) ?? inherited.username,
      port: defaults['port'] ?? inherited.port,
      jump: defaults['jump'] ?? inherited.jump
    }
    for (const h of entries(g.hosts)) add(record(h), here, next)
    for (const c of entries(g.groups)) walk(record(c), here, next)
    active.delete(g)
  }
  const root = doc as { groups?: unknown; hosts?: unknown }
  for (const g of entries(root.groups)) walk(record(g), [], {})
  for (const h of entries(root.hosts)) add(record(h), [], {})
  return { candidates, ignored }
}
