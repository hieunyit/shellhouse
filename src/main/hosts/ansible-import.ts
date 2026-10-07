import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Hostname, Username, type ImportCandidate } from '@shared/hosts'
import { t } from '@shared/i18n'

/**
 * Nhập host từ inventory của Ansible — dạng INI (`[web]`, `[web:vars]`, `[prod:children]`, dải tên
 * `web[01:03]`) hoặc YAML (`all: { hosts, vars, children }`). Biến kết nối theo thứ tự ưu tiên của
 * Ansible: biến của host > nhóm con > nhóm cha > `all`. Nhóm lồng nhau theo `children` thành nhóm
 * lồng nhau trong Shellhouse; nhóm khác của cùng host thành tag. Mật khẩu / vault không bao giờ được
 * đọc — chỉ báo tên biến đã bỏ qua.
 */

type Vars = Record<string, string>

interface Group {
  name: string
  hosts: Map<string, Vars>
  vars: Vars
  children: string[]
}

interface Inventory {
  groups: Map<string, Group>
  /** Thứ tự host xuất hiện lần đầu (giữ thứ tự của file). */
  order: string[]
  seen: Set<string>
}

export interface AnsibleScanOptions {
  existingLabels: readonly string[]
  defaultUser: string
}

export interface AnsibleScan {
  candidates: ImportCandidate[]
  /** Host không dùng SSH (connection=local / winrm / docker…) — theo kiểu kết nối. */
  ignored: Record<string, number>
  /** Biến chứa bí mật đã bỏ qua (ansible_password, ansible_become_pass…). */
  secretColumns: string[]
}

const SECRET_VAR = /pass(word)?$|passphrase|_secret|token|vault/i
/** Nhóm ngầm của Ansible — không thành nhóm trong Shellhouse. */
const IMPLICIT = new Set(['all', 'ungrouped'])
/** Số host tối đa sinh ra từ một dải `[01:99]` (tránh file lỗi sinh hàng triệu host). */
const MAX_RANGE = 10_000

function group(inv: Inventory, name: string): Group {
  let g = inv.groups.get(name)
  if (!g) {
    g = { name, hosts: new Map(), vars: {}, children: [] }
    inv.groups.set(name, g)
  }
  return g
}

function addHost(inv: Inventory, groupName: string, host: string, vars: Vars): void {
  const g = group(inv, groupName)
  g.hosts.set(host, { ...(g.hosts.get(host) ?? {}), ...vars })
  if (!inv.seen.has(host)) {
    inv.seen.add(host)
    inv.order.push(host)
  }
}

/** `web[01:03].x` → web01.x, web02.x, web03.x; `[a:c]`; bước `[1:10:2]`. */
export function expandRange(pattern: string): string[] {
  const m = /^(.*?)\[([0-9a-z]+):([0-9a-z]+)(?::(\d+))?\](.*)$/i.exec(pattern)
  if (!m) return [pattern]
  const [, head = '', from = '', to = '', stepRaw, tail = ''] = m
  const step = Math.max(1, Number(stepRaw ?? 1))
  const out: string[] = []
  if (/^\d+$/.test(from) && /^\d+$/.test(to)) {
    const width = from.length > 1 && from.startsWith('0') ? from.length : 0
    for (let i = Number(from); i <= Number(to) && out.length < MAX_RANGE; i += step)
      out.push(...expandRange(`${head}${String(i).padStart(width, '0')}${tail}`))
  } else if (from.length === 1 && to.length === 1) {
    for (let c = from.charCodeAt(0); c <= to.charCodeAt(0) && out.length < MAX_RANGE; c += step)
      out.push(...expandRange(`${head}${String.fromCharCode(c)}${tail}`))
  } else return [pattern]
  return out
}

/** `a=1 b="x y" c='z'` → { a, b, c } (giá trị có thể trong nháy). */
function parseVars(text: string): Vars {
  const out: Vars = {}
  for (const m of text.matchAll(/([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g)) {
    const raw = m[2] ?? ''
    out[m[1] ?? ''] =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw
  }
  return out
}

function parseIni(text: string): Inventory {
  const inv: Inventory = { groups: new Map(), order: [], seen: new Set() }
  let section = 'ungrouped'
  let kind: 'hosts' | 'vars' | 'children' = 'hosts'
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s[#;].*$/, '').trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const head = /^\[([^\]:]+)(?::(vars|children))?\]$/.exec(line)
    if (head) {
      section = head[1] ?? 'ungrouped'
      kind = (head[2] as 'vars' | 'children' | undefined) ?? 'hosts'
      group(inv, section)
      continue
    }
    if (kind === 'vars') {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const value = line.slice(eq + 1).trim()
        group(inv, section).vars[line.slice(0, eq).trim()] = value.replace(/^(["'])(.*)\1$/, '$2')
      }
    } else if (kind === 'children') {
      const child = line.split(/\s+/)[0] ?? ''
      group(inv, child)
      const g = group(inv, section)
      if (!g.children.includes(child)) g.children.push(child)
    } else {
      const space = line.search(/\s/)
      const name = space < 0 ? line : line.slice(0, space)
      const vars = space < 0 ? {} : parseVars(line.slice(space + 1))
      for (const host of expandRange(name)) addHost(inv, section, host, vars)
    }
  }
  return inv
}

const asVars = (v: unknown): Vars => {
  const out: Vars = {}
  if (v && typeof v === 'object' && !Array.isArray(v))
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')
        out[k] = String(x)
      else if (x && typeof x === 'object' && 'vault' in x) out[k] = '<vault>'
  return out
}

function parseYaml(text: string): Inventory {
  // `!vault |` (giá trị mã hoá) không đọc được và cũng không cần — thay bằng đánh dấu.
  const doc: unknown = parse(text, {
    customTags: [
      { tag: '!vault', resolve: () => ({ vault: true }) },
      { tag: '!unsafe', resolve: (s: string) => s }
    ]
  })
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    throw new Error(t('This is not an Ansible inventory.'))
  const inv: Inventory = { groups: new Map(), order: [], seen: new Set() }
  const walk = (name: string, node: unknown, depth: number): void => {
    if (depth > 20) return
    const g = group(inv, name)
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    Object.assign(g.vars, asVars(n['vars']))
    const hosts = n['hosts']
    if (hosts && typeof hosts === 'object')
      for (const [host, vars] of Object.entries(hosts as Record<string, unknown>))
        for (const h of expandRange(host)) addHost(inv, name, h, asVars(vars))
    const children = n['children']
    if (children && typeof children === 'object')
      for (const [child, sub] of Object.entries(children as Record<string, unknown>)) {
        if (!g.children.includes(child)) g.children.push(child)
        walk(child, sub, depth + 1)
      }
  }
  for (const [name, node] of Object.entries(doc as Record<string, unknown>)) walk(name, node, 0)
  return inv
}

/** Có phải YAML không (dòng đầu có nội dung kiểu `all:` / `---`, không có `[nhóm]`). */
function looksYaml(text: string): boolean {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith(';'))
  return first !== undefined && (first === '---' || /^[\w.-]+:\s*(\{.*\})?$/.test(first))
}

/** Biến của host theo thứ tự ưu tiên của Ansible: all < nhóm cha < nhóm con < host. */
function hostVars(
  inv: Inventory,
  host: string,
  parents: Map<string, string[]>
): { vars: Vars; direct: string[] } {
  const direct = [...inv.groups.values()].filter((g) => g.hosts.has(host)).map((g) => g.name)
  const depth = new Map<string, number>()
  const visit = (name: string, d: number, seen: Set<string>): void => {
    if (seen.has(name)) return
    seen.add(name)
    depth.set(name, Math.max(depth.get(name) ?? 0, d))
    for (const p of parents.get(name) ?? []) visit(p, d - 1, seen)
  }
  for (const g of direct) visit(g, 100, new Set())
  // Cha (độ sâu nhỏ) trước, con sau → con ghi đè; `all` luôn trước nhất.
  const chain = [...depth.entries()]
    .sort((a, b) => (a[0] === 'all' ? -1 : b[0] === 'all' ? 1 : a[1] - b[1]))
    .map(([name]) => name)
  const vars: Vars = { ...(inv.groups.get('all')?.vars ?? {}) }
  for (const name of chain) Object.assign(vars, inv.groups.get(name)?.vars ?? {})
  for (const g of direct) Object.assign(vars, inv.groups.get(g)?.hosts.get(host) ?? {})
  return { vars, direct }
}

/** Đường dẫn nhóm từ nhóm cao nhất (bỏ all / ungrouped) xuống `name`. */
function groupPath(name: string, parents: Map<string, string[]>): string[] {
  const path: string[] = []
  let cur: string | undefined = name
  const seen = new Set<string>()
  while (cur && !IMPLICIT.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    path.unshift(cur)
    cur = (parents.get(cur) ?? []).find((p) => !IMPLICIT.has(p))
  }
  return path
}

/** ProxyJump trong ansible_ssh_common_args / ansible_ssh_extra_args (`-J x` hoặc `-o ProxyJump=x`). */
function proxyJumpOf(vars: Vars): string | null {
  const args = `${vars['ansible_ssh_common_args'] ?? ''} ${vars['ansible_ssh_extra_args'] ?? ''}`
  return (
    /-o\s*["']?ProxyJump[= ]([^\s"']+)/i.exec(args)?.[1] ??
    /(?:^|\s)-J\s*([^\s"']+)/.exec(args)?.[1] ??
    null
  )
}

const expandHome = (p: string): string =>
  p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p

export function scanAnsibleInventory(text: string, options: AnsibleScanOptions): AnsibleScan {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const inv = looksYaml(body) ? parseYaml(body) : parseIni(body)
  if (!inv.order.length) throw new Error(t('No hosts found in this inventory.'))
  const parents = new Map<string, string[]>()
  for (const g of inv.groups.values())
    for (const c of g.children) parents.set(c, [...(parents.get(c) ?? []), g.name])

  const existing = new Set(options.existingLabels.map((l) => l.toLowerCase()))
  const secrets = new Set<string>()
  const seen = new Set<string>()
  const candidates: ImportCandidate[] = []
  const ignored: Record<string, number> = {}
  for (const host of inv.order) {
    const { vars, direct } = hostVars(inv, host, parents)
    for (const k of Object.keys(vars)) if (SECRET_VAR.test(k)) secrets.add(k)
    const connection = (vars['ansible_connection'] ?? 'ssh').toLowerCase()
    if (
      !['ssh', 'smart', 'paramiko', 'paramiko_ssh', 'network_cli', 'netconf'].includes(connection)
    ) {
      const key = connection === 'winrm' ? 'WinRM' : connection
      ignored[key] = (ignored[key] ?? 0) + 1
      continue
    }
    // Nhóm sâu nhất làm nhóm của host; các nhóm trực tiếp khác thành tag.
    const paths = direct.map((g) => groupPath(g, parents)).sort((a, b) => b.length - a.length)
    const path = paths[0] ?? []
    const tags = direct
      .filter((g) => !IMPLICIT.has(g) && g !== path.at(-1))
      .filter((g) => g.length <= 40)
      .slice(0, 10)
    let alias = [...path, host].join('\\')
    if (seen.has(alias.toLowerCase())) alias = `${alias} (${String(candidates.length + 1)})`
    seen.add(alias.toLowerCase())

    const hostname = vars['ansible_host'] ?? vars['ansible_ssh_host'] ?? host
    const portRaw = vars['ansible_port'] ?? vars['ansible_ssh_port'] ?? ''
    const port = portRaw ? Number(portRaw) : 22
    const username = vars['ansible_user'] ?? vars['ansible_ssh_user'] ?? options.defaultUser
    const keyRaw = vars['ansible_ssh_private_key_file'] ?? vars['ansible_private_key_file'] ?? ''
    const keyFile = keyRaw ? expandHome(keyRaw) : null

    let problem: string | null = null
    if ([hostname, username, portRaw, keyRaw].some((v) => v.includes('{{')))
      problem = t('Uses an Ansible template ({{ … }}) — fill it in after importing')
    else if (!Hostname.safeParse(hostname).success)
      problem = t('Invalid hostname: {value}', { value: hostname })
    else if (!Number.isInteger(port) || port < 1 || port > 65535)
      problem = t('Invalid port: {value}', { value: portRaw })
    else if (!Username.safeParse(username).success)
      problem = t('Invalid username: {value}', { value: username })
    // Key không có trên máy này: vẫn nhập — chọn key trong vault lúc nhập hoặc thêm sau.
    const missingKey = keyFile !== null && !existsSync(keyFile)

    candidates.push({
      alias,
      label: host.slice(0, 100),
      group: path,
      hostname,
      port: Number.isInteger(port) ? port : 22,
      username,
      keyFile: missingKey ? null : keyFile,
      proxyJump: proxyJumpOf(vars),
      duplicate: existing.has(host.toLowerCase()),
      problem,
      warning: missingKey ? t('Private key not found: {path}', { path: keyFile }) : null,
      ...(tags.length ? { tags } : {})
    })
  }
  return { candidates, ignored, secretColumns: [...secrets].sort() }
}
