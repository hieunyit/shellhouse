import { dirname, isAbsolute, join } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { t } from '@shared/i18n'
import type { ContextInfo, ContextRef } from '../shared/ops'

/**
 * Đọc kubeconfig (ADR-014 mục 7.2): context / cluster / user. Không tự đọc file — người gọi truyền
 * hàm đọc (main đọc theo quyền `read-file` của manifest).
 */

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export interface ExecPlugin {
  command: string
  args: string[]
  env: Record<string, string>
  apiVersion: string
}

export interface OidcProvider {
  idToken?: string
  refreshToken?: string
  issuer?: string
  clientId?: string
  clientSecret?: string
  /** CA của IdP (PEM). */
  idpCa?: string
}

/** Một context đã phân giải hết — mọi dữ liệu nằm trong đối tượng (không còn đường dẫn file). */
export interface ResolvedCluster {
  name: string
  server: string
  /** PEM. */
  ca?: string
  insecure: boolean
  tlsServerName?: string
  namespace: string
  /** Chế độ chỉ đọc (cài đặt của context trong main — Session Host chặn thao tác thay đổi). */
  readOnly?: boolean
  auth: {
    token?: string
    cert?: string
    key?: string
    username?: string
    password?: string
    exec?: ExecPlugin
    oidc?: OidcProvider
  }
}

export interface KubeconfigDoc {
  contexts: { name: string; cluster: string; user: string; namespace?: string }[]
  clusters: Map<string, Obj>
  users: Map<string, Obj>
  current?: string
}

export function parseKubeconfig(text: string): KubeconfigDoc {
  const doc = obj(parse(text) as unknown)
  const byName = (list: Obj[], field: string): Map<string, Obj> =>
    new Map(
      list.flatMap((e) => {
        const name = str(e['name'])
        return name ? [[name, obj(e[field])] as const] : []
      })
    )
  return {
    contexts: arr(doc['contexts']).flatMap((c) => {
      const name = str(c['name'])
      const ctx = obj(c['context'])
      const cluster = str(ctx['cluster'])
      if (!name || !cluster) return []
      const namespace = str(ctx['namespace'])
      return [{ name, cluster, user: str(ctx['user']) ?? '', ...(namespace ? { namespace } : {}) }]
    }),
    clusters: byName(arr(doc['clusters']), 'cluster'),
    users: byName(arr(doc['users']), 'user'),
    ...(str(doc['current-context']) ? { current: str(doc['current-context']) } : {})
  }
}

export function execPluginName(user: Obj | undefined): string | null {
  const exec = obj(user?.['exec'])
  const command = str(exec['command'])
  if (!command) return null
  return command.split(/[\\/]/).pop() ?? command
}

/** Danh sách context để hiện (không đọc secret). */
export function listContexts(
  doc: KubeconfigDoc,
  source: string,
  sourceLabel: string
): ContextInfo[] {
  return doc.contexts.map((c) => {
    const cluster = doc.clusters.get(c.cluster)
    return {
      ref: { source, context: c.name },
      name: c.name,
      cluster: c.cluster,
      server: str(cluster?.['server']) ?? '',
      user: c.user,
      namespace: c.namespace ?? null,
      sourceLabel,
      execPlugin: execPluginName(doc.users.get(c.user))
    }
  })
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')

/** Thư mục chứa file (đường dẫn tương đối trong kubeconfig tính từ đây). */
function dirOf(path: string): string {
  return dirname(path)
}

/** Đường dẫn tuyệt đối theo quy ước của hệ điều hành (Windows: dấu "\\"). */
function absolute(path: string, base: string): string {
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('~')) return path
  return join(base, path)
}

/**
 * Phân giải một context: chọn cluster + user, đọc các file tham chiếu (CA, chứng chỉ, khoá,
 * token) bằng `readFile` — kết quả tự chứa, gửi được sang Session Host.
 */
export async function resolveContext(
  doc: KubeconfigDoc,
  ref: ContextRef,
  kubeconfigPath: string | null,
  readFile: (path: string) => Promise<string>
): Promise<ResolvedCluster> {
  const ctx = doc.contexts.find((c) => c.name === ref.context)
  if (!ctx)
    throw new Error(
      t('The context “{name}” is not in this kubeconfig anymore', { name: ref.context })
    )
  const cluster = doc.clusters.get(ctx.cluster)
  if (!cluster)
    throw new Error(t('The cluster “{name}” is missing from the kubeconfig', { name: ctx.cluster }))
  const user = doc.users.get(ctx.user) ?? {}
  const base = kubeconfigPath ? dirOf(kubeconfigPath) : '.'
  const load = async (data: unknown, file: unknown): Promise<string | undefined> => {
    const d = str(data)
    if (d) return decode(d)
    const f = str(file)
    if (!f) return undefined
    if (!kubeconfigPath)
      throw new Error(
        t('An imported kubeconfig must embed certificates (…-data fields), not file paths')
      )
    return readFile(absolute(f, base))
  }
  const server = str(cluster['server'])
  if (!server)
    throw new Error(t('The cluster “{name}” has no server address', { name: ctx.cluster }))
  const exec = obj(user['exec'])
  const provider = obj(user['auth-provider'])
  const providerConfig = obj(provider['config'])
  const tokenFile = str(user['tokenFile'])
  const auth: ResolvedCluster['auth'] = {}
  const token =
    str(user['token']) ??
    (tokenFile ? (await readFile(absolute(tokenFile, base))).trim() : undefined)
  if (token) auth.token = token
  const cert = await load(user['client-certificate-data'], user['client-certificate'])
  const key = await load(user['client-key-data'], user['client-key'])
  if (cert) auth.cert = cert
  if (key) auth.key = key
  if (str(user['username'])) auth.username = str(user['username'])
  if (str(user['password'])) auth.password = str(user['password'])
  if (str(exec['command']))
    auth.exec = {
      command: str(exec['command']) ?? '',
      args: Array.isArray(exec['args']) ? exec['args'].map(String) : [],
      env: Object.fromEntries(
        arr(exec['env']).flatMap((e) =>
          str(e['name']) ? [[str(e['name']) ?? '', str(e['value']) ?? '']] : []
        )
      ),
      apiVersion: str(exec['apiVersion']) ?? 'client.authentication.k8s.io/v1beta1'
    }
  if (str(provider['name']) === 'oidc') {
    const oidc: OidcProvider = {}
    const map: [keyof OidcProvider, string][] = [
      ['idToken', 'id-token'],
      ['refreshToken', 'refresh-token'],
      ['issuer', 'idp-issuer-url'],
      ['clientId', 'client-id'],
      ['clientSecret', 'client-secret']
    ]
    for (const [k, field] of map) {
      const v = str(providerConfig[field])
      if (v) oidc[k] = v
    }
    // CA của IdP chỉ cần khi làm mới token — đọc không được thì bỏ qua (dùng CA hệ thống).
    const idpCa = await load(
      providerConfig['idp-certificate-authority-data'],
      providerConfig['idp-certificate-authority']
    ).catch(() => undefined)
    if (idpCa) oidc.idpCa = idpCa
    auth.oidc = oidc
  }
  const ca = await load(cluster['certificate-authority-data'], cluster['certificate-authority'])
  const tlsServerName = str(cluster['tls-server-name'])
  return {
    name: ctx.name,
    server,
    ...(ca ? { ca } : {}),
    insecure: cluster['insecure-skip-tls-verify'] === true,
    ...(tlsServerName ? { tlsServerName } : {}),
    namespace: ctx.namespace ?? 'default',
    auth
  }
}

/** Lý do gốc của lỗi đọc file (ENOENT, vùng bị chặn, quá lớn…) — không nuốt mất. */
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Trường đường dẫn → trường nhúng tương ứng. */
const FILE_FIELDS: readonly (readonly [
  section: 'clusters' | 'users',
  inner: string,
  file: string,
  data: string
])[] = [
  ['clusters', 'cluster', 'certificate-authority', 'certificate-authority-data'],
  ['users', 'user', 'client-certificate', 'client-certificate-data'],
  ['users', 'user', 'client-key', 'client-key-data']
]

/**
 * Kubeconfig tự chứa để lưu vào vault: mọi file tham chiếu (CA, chứng chỉ, khoá, tokenFile) được
 * đọc và nhúng vào (`…-data`, `token`). File thiếu → lỗi rõ tên file.
 */
export async function embedReferences(
  text: string,
  readReferenced: (path: string) => Promise<string>
): Promise<string> {
  const doc = parseDocument(text)
  const root = doc.toJS() as Obj | null
  if (!root || typeof root !== 'object') throw new Error(t('This file is not a kubeconfig'))
  for (const [section, inner, file, data] of FILE_FIELDS) {
    const list = arr(root[section])
    for (let i = 0; i < list.length; i++) {
      const body = obj(list[i]?.[inner])
      const ref = str(body[file])
      if (!ref || str(body[data])) continue
      let content: string
      try {
        content = await readReferenced(ref)
      } catch (error) {
        throw new Error(
          t('Could not read {path} (referenced as {field}): {reason}', {
            path: ref,
            field: file,
            reason: reason(error)
          }),
          {
            cause: error
          }
        )
      }
      doc.setIn([section, i, inner, data], Buffer.from(content).toString('base64'))
      doc.deleteIn([section, i, inner, file])
    }
  }
  const users = arr(root['users'])
  for (let i = 0; i < users.length; i++) {
    const ref = str(obj(users[i]?.['user'])['tokenFile'])
    if (!ref) continue
    const token = (
      await readReferenced(ref).catch((error: unknown) => {
        throw new Error(
          t('Could not read {path} (referenced as tokenFile): {reason}', {
            path: ref,
            reason: reason(error)
          }),
          {
            cause: error
          }
        )
      })
    ).trim()
    doc.setIn(['users', i, 'user', 'token'], token)
    doc.deleteIn(['users', i, 'user', 'tokenFile'])
  }
  return doc.toString()
}

/**
 * Xoá một context khỏi kubeconfig (như `kubectl config delete-context`), giữ nguyên chú thích /
 * thứ tự phần còn lại. Cluster / user chỉ context này dùng cũng được xoá; current-context trỏ vào
 * nó thì chuyển sang context còn lại đầu tiên (hoặc bỏ). Trả về số context còn lại.
 */
export function deleteContextFromYaml(text: string, name: string): { text: string; left: number } {
  const doc = parseDocument(text)
  const root = doc.toJS() as Obj | null
  if (!root || typeof root !== 'object') throw new Error(t('This file is not a kubeconfig'))
  const contexts = arr(root['contexts'])
  const index = contexts.findIndex((c) => str(c['name']) === name)
  if (index < 0)
    throw new Error(t('The context “{name}” is not in this kubeconfig anymore', { name }))
  const target = obj(contexts[index]?.['context'])
  doc.deleteIn(['contexts', index])
  const rest = contexts.filter((_, i) => i !== index)
  const stillUsed = (field: 'cluster' | 'user', value: string): boolean =>
    rest.some((c) => str(obj(c['context'])[field]) === value)
  for (const [section, field] of [
    ['clusters', 'cluster'],
    ['users', 'user']
  ] as const) {
    const value = str(target[field])
    if (!value || stillUsed(field, value)) continue
    const i = arr(root[section]).findIndex((x) => str(x['name']) === value)
    if (i >= 0) doc.deleteIn([section, i])
  }
  if (str(root['current-context']) === name) {
    const next = str(rest[0]?.['name'])
    if (next) doc.set('current-context', next)
    else doc.delete('current-context')
  }
  return { text: doc.toString(), left: rest.length }
}

/**
 * Ghi token OIDC vừa làm mới vào user của context (như kubectl: id-token / refresh-token trong
 * auth-provider.config) — IdP xoay vòng refresh token thì bản cũ trong file không dùng được nữa.
 * null = context không dùng OIDC (không đổi gì).
 */
export function setOidcTokens(
  text: string,
  contextName: string,
  tokens: { idToken: string; refreshToken?: string | undefined }
): string | null {
  const doc = parseDocument(text)
  const root = doc.toJS() as Obj | null
  if (!root || typeof root !== 'object') return null
  const ctx = arr(root['contexts']).find((c) => str(c['name']) === contextName)
  const userName = str(obj(ctx?.['context'])['user'])
  if (!userName) return null
  const users = arr(root['users'])
  const i = users.findIndex((u) => str(u['name']) === userName)
  const provider = obj(obj(users[i]?.['user'])['auth-provider'])
  if (i < 0 || str(provider['name']) !== 'oidc') return null
  doc.setIn(['users', i, 'user', 'auth-provider', 'config', 'id-token'], tokens.idToken)
  if (tokens.refreshToken)
    doc.setIn(['users', i, 'user', 'auth-provider', 'config', 'refresh-token'], tokens.refreshToken)
  return doc.toString()
}
