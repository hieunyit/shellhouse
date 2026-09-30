import { request as httpsRequest } from 'node:https'
import type { LimitedSpawn } from '../../registry/host-types'
import type { ModuleBinary } from '../../registry/types'
import type { Credentials } from './client'

/** Thông tin xác thực đã phân giải bởi main (xem main/kubeconfig.ts). */
export interface AuthConfig {
  token?: string
  cert?: string
  key?: string
  username?: string
  password?: string
  exec?: { command: string; args: string[]; env: Record<string, string>; apiVersion: string }
  oidc?: {
    idToken?: string
    refreshToken?: string
    issuer?: string
    clientId?: string
    clientSecret?: string
  }
}

/** Plugin xác thực được phép chạy (ADR-014 mục 7.2) — theo tên chương trình, tìm trong PATH. */
const ALLOWED: Record<string, ModuleBinary> = {
  aws: 'aws',
  gcloud: 'gcloud',
  'gke-gcloud-auth-plugin': 'gke-gcloud-auth-plugin',
  kubelogin: 'kubelogin'
}

export function pluginBinary(command: string): ModuleBinary {
  const name = (command.split(/[\\/]/).pop() ?? command).replace(/\.exe$/i, '')
  const binary = ALLOWED[name]
  if (!binary)
    throw new Error(
      `This context signs in with “${name}”, which Shellhouse does not run. Supported: ${Object.keys(ALLOWED).join(', ')}.`
    )
  return binary
}

/** Hết hạn của JWT (ms), null nếu không đọc được. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    ).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(form).toString()
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        timeout: 20_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
              string,
              unknown
            >
            if ((res.statusCode ?? 0) >= 400)
              reject(
                new Error(
                  typeof json['error_description'] === 'string'
                    ? json['error_description']
                    : typeof json['error'] === 'string'
                      ? json['error']
                      : `HTTP ${res.statusCode ?? '?'}`
                )
              )
            else resolve(json)
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('The identity provider did not answer')))
    req.end(body)
  })
}

function getJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { headers: { Accept: 'application/json' }, timeout: 20_000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('The identity provider did not answer')))
  })
}

/**
 * Nguồn thông tin xác thực của một cluster: tĩnh (token, chứng chỉ, basic) hoặc làm mới được (exec
 * plugin — chạy qua ctx.spawn, hỏi người dùng lần đầu; OIDC refresh token).
 */
export function credentialProvider(
  auth: AuthConfig,
  spawn: LimitedSpawn,
  server: string,
  now: () => number = Date.now
): (refresh: boolean) => Promise<Credentials> {
  let cached: { creds: Credentials; expires: number } | null = null
  let oidcToken = auth.oidc?.idToken

  const staticCreds = (): Credentials => {
    const headers: Record<string, string> = {}
    if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`
    else if (auth.username !== undefined && auth.password !== undefined)
      headers['Authorization'] =
        `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
    return {
      headers,
      ...(auth.cert ? { cert: auth.cert } : {}),
      ...(auth.key ? { key: auth.key } : {})
    }
  }

  const runExec = async (): Promise<{ creds: Credentials; expires: number }> => {
    const exec = auth.exec
    if (!exec) throw new Error('No exec plugin')
    const binary = pluginBinary(exec.command)
    const info = {
      kind: 'ExecCredential',
      apiVersion: exec.apiVersion,
      spec: { cluster: { server }, interactive: false }
    }
    const r = await spawn.exec(binary, exec.args, {
      env: { ...exec.env, KUBERNETES_EXEC_INFO: JSON.stringify(info) },
      timeoutMs: 60_000
    })
    if (r.code !== 0)
      throw new Error(
        `${binary} could not get a token: ${r.stderr.trim().split('\n').slice(-2).join(' ') || `exit ${r.code ?? '?'}`}`
      )
    const status = (
      JSON.parse(r.stdout) as {
        status?: {
          token?: string
          expirationTimestamp?: string
          clientCertificateData?: string
          clientKeyData?: string
        }
      }
    ).status
    if (!status?.token && !status?.clientCertificateData)
      throw new Error(`${binary} did not return a credential`)
    const expires = status.expirationTimestamp
      ? Date.parse(status.expirationTimestamp)
      : now() + 10 * 60_000
    return {
      creds: {
        headers: status.token ? { Authorization: `Bearer ${status.token}` } : {},
        ...(status.clientCertificateData
          ? { cert: status.clientCertificateData }
          : auth.cert
            ? { cert: auth.cert }
            : {}),
        ...(status.clientKeyData
          ? { key: status.clientKeyData }
          : auth.key
            ? { key: auth.key }
            : {})
      },
      expires
    }
  }

  const refreshOidc = async (): Promise<string> => {
    const o = auth.oidc
    if (!o?.refreshToken || !o.issuer || !o.clientId)
      throw new Error('The OIDC token expired — sign in again with kubectl to refresh it')
    const discovery = await getJson(
      `${o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    )
    const endpoint = discovery['token_endpoint']
    if (typeof endpoint !== 'string') throw new Error('The identity provider has no token endpoint')
    const res = await postForm(endpoint, {
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      client_id: o.clientId,
      ...(o.clientSecret ? { client_secret: o.clientSecret } : {})
    })
    const idToken = res['id_token']
    if (typeof idToken !== 'string') throw new Error('The identity provider returned no id_token')
    return idToken
  }

  return async (refresh) => {
    if (auth.exec) {
      if (refresh || !cached || cached.expires - 60_000 < now()) cached = await runExec()
      return cached.creds
    }
    if (auth.oidc) {
      const exp = oidcToken ? jwtExpiry(oidcToken) : null
      if (refresh || !oidcToken || (exp !== null && exp - 60_000 < now()))
        oidcToken = await refreshOidc()
      return { ...staticCreds(), headers: { Authorization: `Bearer ${oidcToken}` } }
    }
    return staticCreds()
  }
}
