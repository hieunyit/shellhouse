import { parse } from 'yaml'
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
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(0, i) : '.'
}

function absolute(path: string, base: string): string {
  if (/^([a-zA-Z]:)?[\\/]/.test(path) || path.startsWith('~')) return path
  return `${base}/${path}`
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
  if (!ctx) throw new Error(`The context “${ref.context}” is not in this kubeconfig anymore`)
  const cluster = doc.clusters.get(ctx.cluster)
  if (!cluster) throw new Error(`The cluster “${ctx.cluster}” is missing from the kubeconfig`)
  const user = doc.users.get(ctx.user) ?? {}
  const base = kubeconfigPath ? dirOf(kubeconfigPath) : '.'
  const load = async (data: unknown, file: unknown): Promise<string | undefined> => {
    const d = str(data)
    if (d) return decode(d)
    const f = str(file)
    if (!f) return undefined
    if (!kubeconfigPath)
      throw new Error(
        'An imported kubeconfig must embed certificates (…-data fields), not file paths'
      )
    return readFile(absolute(f, base))
  }
  const server = str(cluster['server'])
  if (!server) throw new Error(`The cluster “${ctx.cluster}” has no server address`)
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
