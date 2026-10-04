import { stringify } from 'yaml'
import type { HostTree } from './hosts'

/**
 * Xuất danh sách host (thiết kế v0.7): Shellhouse YAML (giữ cây nhóm, môi trường, mặc định của
 * nhóm), OpenSSH config (`Host / HostName / User / Port / ProxyJump`; RDP / Serial / Telnet bỏ qua
 * kèm ghi chú), CSV. KHÔNG BAO GIỜ xuất mật khẩu / khoá — chỉ tên tài khoản dùng chung.
 */
export type ExportFormat = 'yaml' | 'ssh' | 'csv'

export interface ExportResult {
  text: string
  hosts: number
  /** Host không xuất được theo định dạng này (vd. RDP trong OpenSSH config). */
  skipped: string[]
}

/** Nhóm trong phạm vi (nhóm gốc + mọi nhóm con cháu); null = tất cả. */
function scopeGroups(tree: HostTree, root: string | null): Set<string | null> {
  if (root === null) return new Set([null, ...tree.groups.map((g) => g.id)])
  const out = new Set<string | null>([root])
  for (let added = true; added;) {
    added = false
    for (const g of tree.groups)
      if (g.parentId !== null && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id)
        added = true
      }
  }
  return out
}

function groupPath(tree: HostTree, id: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let current = id === null ? undefined : tree.groups.find((g) => g.id === id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    out.unshift(current.name)
    current =
      current.parentId === null ? undefined : tree.groups.find((g) => g.id === current?.parentId)
  }
  return out
}

/** Bí danh Host cho OpenSSH config: chữ thường, không dấu cách. */
export function sshAlias(label: string): string {
  return (
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/gi, 'd')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'host'
  )
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function exportHosts(
  tree: HostTree,
  format: ExportFormat,
  scope: string | null = null
): ExportResult {
  const groups = scopeGroups(tree, scope)
  const hosts = tree.hosts.filter((h) => groups.has(h.groupId))
  const label = (id: string): string => tree.hosts.find((h) => h.id === id)?.label ?? id
  const account = (id: string | null | undefined): string | undefined =>
    id ? tree.accounts.find((a) => a.id === id)?.name : undefined
  const skipped: string[] = []

  if (format === 'csv') {
    const rows = [['Label', 'Group', 'Hostname', 'Port', 'Username', 'Protocol', 'Tags', 'Account']]
    for (const h of hosts)
      rows.push([
        h.label,
        groupPath(tree, h.groupId).join(' / '),
        h.hostname,
        h.port === null ? '' : String(h.port),
        h.accountId ? '' : h.username,
        h.protocol,
        h.tags.join(' '),
        account(h.accountId) ?? ''
      ])
    return {
      text: rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n',
      hosts: hosts.length,
      skipped
    }
  }

  if (format === 'ssh') {
    const aliases = new Map<string, string>()
    const taken = new Set<string>()
    for (const h of hosts) {
      let alias = sshAlias(h.label)
      for (let i = 2; taken.has(alias); i++) alias = `${sshAlias(h.label)}-${String(i)}`
      taken.add(alias)
      aliases.set(h.id, alias)
    }
    const blocks: string[] = ['# Exported from Shellhouse — passwords and keys are never exported.']
    for (const h of hosts) {
      if (h.protocol !== 'ssh') {
        skipped.push(h.label)
        continue
      }
      const lines = [`Host ${aliases.get(h.id) ?? sshAlias(h.label)}`, `  HostName ${h.hostname}`]
      if (!h.accountId && h.username) lines.push(`  User ${h.username}`)
      if (h.port !== null && h.port !== 22) lines.push(`  Port ${String(h.port)}`)
      const jumps = h.jumpHostIds.map((id) => aliases.get(id) ?? sshAlias(label(id)))
      if (jumps.length) lines.push(`  ProxyJump ${jumps.join(',')}`)
      else if (h.proxyJump) lines.push(`  ProxyJump ${h.proxyJump}`)
      const path = groupPath(tree, h.groupId)
      if (path.length) lines.unshift(`# ${path.join(' / ')}`)
      blocks.push(lines.join('\n'))
    }
    if (skipped.length) blocks.push(`# Not exported (not SSH): ${skipped.join(', ')}`)
    return { text: blocks.join('\n\n') + '\n', hosts: hosts.length - skipped.length, skipped }
  }

  // Shellhouse YAML: cây nhóm lồng nhau, host nằm trong nhóm của nó.
  interface YGroup {
    name: string
    environment?: string
    defaults?: Record<string, unknown>
    groups?: YGroup[]
    hosts?: Record<string, unknown>[]
  }
  const hostEntry = (h: HostTree['hosts'][number]): Record<string, unknown> => {
    const e: Record<string, unknown> = { label: h.label, hostname: h.hostname }
    if (h.port !== null) e['port'] = h.port
    if (!h.accountId && h.username) e['username'] = h.username
    if (h.accountId) e['account'] = account(h.accountId)
    if (h.protocol !== 'ssh') e['protocol'] = h.protocol
    if (h.jumpHostIds.length) e['jump'] = h.jumpHostIds.map(label)
    if (h.tags.length) e['tags'] = h.tags
    if (h.favorite) e['favorite'] = true
    return e
  }
  const build = (id: string): YGroup => {
    const g = tree.groups.find((x) => x.id === id)
    const node: YGroup = { name: g?.name ?? '' }
    const d = g?.defaults
    if (d?.environment) node.environment = d.environment
    const defaults: Record<string, unknown> = {}
    if (d?.username) defaults['username'] = d.username
    if (d?.port) defaults['port'] = d.port
    if (d?.jumpHostIds?.length) defaults['jump'] = d.jumpHostIds.map(label)
    if (Object.keys(defaults).length) node.defaults = defaults
    const children = tree.groups
      .filter((x) => x.parentId === id)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
      .map((x) => build(x.id))
    if (children.length) node.groups = children
    const inside = hosts.filter((h) => h.groupId === id).map(hostEntry)
    if (inside.length) node.hosts = inside
    return node
  }
  const rootIds =
    scope === null ? tree.groups.filter((g) => g.parentId === null).map((g) => g.id) : [scope]
  const doc: Record<string, unknown> = {
    shellhouse: 1,
    groups: rootIds.map(build)
  }
  if (scope === null) {
    const loose = hosts.filter((h) => h.groupId === null).map(hostEntry)
    if (loose.length) doc['hosts'] = loose
  }
  return {
    text: '# Exported from Shellhouse — passwords and keys are never exported.\n' + stringify(doc),
    hosts: hosts.length,
    skipped
  }
}
