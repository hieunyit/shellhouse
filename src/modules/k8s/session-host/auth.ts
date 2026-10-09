import { request as httpsRequest, type RequestOptions as HttpsOptions } from 'node:https'
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
    /** CA của IdP (idp-certificate-authority[-data]) — PEM. */
    idpCa?: string
  }
}

/** Token OIDC vừa làm mới (refresh token có thể bị IdP xoay vòng — cần lưu lại bản mới). */
export interface OidcTokens {
  idToken: string
  refreshToken?: string
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

/**
 * Biến môi trường từ kubeconfig được đặt cho plugin: DANH SÁCH CHO PHÉP (chọn hồ sơ / region /
 * project / tài khoản, thông tin service principal). Danh sách chặn trước đây luôn lọt: proxy kèm
 * tắt kiểm chứng chỉ (`HTTPS_PROXY` + `CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION` → gcloud gửi refresh
 * token qua máy của kẻ tấn công), `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` (chạy lệnh), file cấu
 * hình khác (`AWS_CONFIG_FILE` → credential_process), nạp mã (`LD_PRELOAD`, `NODE_OPTIONS`…).
 * Kubeconfig lạ (import, tải về) không được biến plugin đã cho phép thành công cụ của người khác.
 * Biến môi trường của chính người dùng (proxy công ty…) vẫn được plugin kế thừa như thường.
 */
const ALLOWED_ENV =
  /^(AWS_(PROFILE|DEFAULT_PROFILE|REGION|DEFAULT_REGION|STS_REGIONAL_ENDPOINTS|SDK_LOAD_CONFIG|CA_BUNDLE|ROLE_SESSION_NAME)|CLOUDSDK_CORE_(PROJECT|ACCOUNT)|CLOUDSDK_ACTIVE_CONFIG_NAME|CLOUDSDK_COMPUTE_(REGION|ZONE)|USE_GKE_GCLOUD_AUTH_PLUGIN|GOOGLE_APPLICATION_CREDENTIALS|AAD_(LOGIN_METHOD|SERVICE_PRINCIPAL_CLIENT_ID|SERVICE_PRINCIPAL_CLIENT_SECRET|SERVICE_PRINCIPAL_CLIENT_CERTIFICATE|SERVICE_PRINCIPAL_CLIENT_CERTIFICATE_PASSWORD|USER_PRINCIPAL_NAME|USER_PRINCIPAL_PASSWORD)|AZURE_(CLIENT_ID|TENANT_ID|CLIENT_SECRET|FEDERATED_TOKEN_FILE|ENVIRONMENT))$/

/** Biến môi trường an toàn cho plugin (chỉ biến trong danh sách cho phép); trả kèm tên đã bỏ. */
export function pluginEnv(env: Record<string, string>): {
  env: Record<string, string>
  dropped: string[]
} {
  const out: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!ALLOWED_ENV.test(k) || v.includes('\0')) dropped.push(k)
    else out[k] = v
  }
  return { env: out, dropped }
}

/**
 * Tuỳ chọn đổi nơi gửi thông tin xác thực / tắt kiểm chứng chỉ / nạp thêm tuỳ chọn từ file — không
 * nhận từ kubeconfig (ở bất kỳ vị trí nào, dạng `--x v` hay `--x=v`).
 */
const BLOCKED_ARGS: Partial<Record<ModuleBinary, readonly string[]>> = {
  aws: ['--endpoint-url', '--no-verify-ssl', '--ca-bundle'],
  gcloud: ['--flags-file', '--log-http'],
  kubelogin: ['--authority-host']
}

/**
 * Lệnh con `words` có đứng ngay đầu không: trước nó chỉ được là tuỳ chọn (`--x`, `--x=v`) hoặc giá trị
 * ngay sau một tuỳ chọn (`--region us-east-1`). Không tìm ở giữa mảng — `aws s3 cp ~/.ssh/id_rsa
 * s3://x eks get-token` có "eks get-token" ở cuối nhưng lệnh thật là `s3 cp`.
 */
function leadingSubcommand(args: readonly string[], words: readonly string[]): boolean {
  let i = 0
  while (i < args.length && args[i] !== words[0]) {
    const a = args[i] ?? ''
    if (!a.startsWith('-')) return false
    // Giá trị của tuỳ chọn (không có "="): bỏ qua một đối số — trừ khi đó chính là lệnh con.
    if (!a.includes('=') && args[i + 1] !== undefined && !(args[i + 1] ?? '').startsWith('-')) {
      if (args[i + 1] === words[0]) {
        i++
        break
      }
      i++
    }
    i++
  }
  return words.every((w, k) => args[i + k] === w)
}

/**
 * Plugin chỉ được chạy đúng lệnh lấy token (`aws eks get-token`, `kubelogin get-token`, `gcloud
 * config config-helper`) — kubeconfig lạ không dùng được `aws` đã cho phép để chạy `aws s3 cp …`.
 */
export function checkPluginArgs(binary: ModuleBinary, args: readonly string[]): void {
  const ok =
    binary === 'aws'
      ? leadingSubcommand(args, ['eks', 'get-token'])
      : binary === 'kubelogin'
        ? leadingSubcommand(args, ['get-token'])
        : binary === 'gcloud'
          ? leadingSubcommand(args, ['config', 'config-helper'])
          : true
  const blocked = BLOCKED_ARGS[binary] ?? []
  const bad = args.find((a) => blocked.some((o) => a === o || a.startsWith(`${o}=`)))
  if (bad !== undefined)
    throw new Error(
      `This context runs “${binary}” with “${bad.split('=')[0] ?? bad}”, which Shellhouse does not allow for sign-in commands.`
    )
  if (!ok || args.some((a) => a.includes('\0')))
    throw new Error(
      `This context runs “${binary} ${args.slice(0, 4).join(' ')}”, which is not a sign-in command — Shellhouse only runs ${
        binary === 'aws'
          ? '“aws eks get-token”'
          : binary === 'kubelogin'
            ? '“kubelogin get-token”'
            : '“gcloud config config-helper”'
      } for it.`
    )
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

/** Gửi request tới IdP (https; CA riêng nếu kubeconfig có idp-certificate-authority). */
function idpRequest(
  url: string,
  options: HttpsOptions,
  body: string | undefined,
  ca: string | undefined
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { ...options, ...(ca ? { ca } : {}), timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > 1024 * 1024) req.destroy(new Error('The identity provider answer is too large'))
        else chunks.push(c)
      })
      res.on('error', reject)
      res.on('end', () => {
        let json: Record<string, unknown>
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        } catch {
          reject(new Error(`The identity provider answered HTTP ${res.statusCode ?? '?'}`))
          return
        }
        if ((res.statusCode ?? 0) >= 400)
          reject(
            Object.assign(
              new Error(
                typeof json['error_description'] === 'string'
                  ? json['error_description']
                  : typeof json['error'] === 'string'
                    ? json['error']
                    : `HTTP ${res.statusCode ?? '?'}`
              ),
              // Mã lỗi OAuth (invalid_grant…) — thông báo có thể là error_description.
              { oauthError: typeof json['error'] === 'string' ? json['error'] : undefined }
            )
          )
        else resolve(json)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('The identity provider did not answer')))
    // Luôn kết thúc request (GET cũng vậy) — không thì không có gì được gửi đi.
    req.end(body)
  })
}

function postForm(
  url: string,
  form: Record<string, string>,
  ca?: string
): Promise<Record<string, unknown>> {
  return idpRequest(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      }
    },
    new URLSearchParams(form).toString(),
    ca
  )
}

function getJson(url: string, ca?: string): Promise<Record<string, unknown>> {
  return idpRequest(url, { method: 'GET', headers: { Accept: 'application/json' } }, undefined, ca)
}

export interface CredentialHooks {
  /** OIDC vừa làm mới → lưu token mới (refresh token xoay vòng) để lần mở sau còn dùng được. */
  onOidcRefreshed?(tokens: OidcTokens): void
  /**
   * Đọc lại token OIDC đã lưu (main): tab khác cùng context có thể vừa làm mới — IdP xoay vòng thì
   * refresh token mình giữ đã hết hiệu lực (invalid_grant), bản mới nhất nằm trong kubeconfig.
   */
  reloadOidc?(): Promise<{ idToken?: string | undefined; refreshToken?: string | undefined } | null>
  /** Ghi log (biến môi trường bị bỏ…). */
  log?(message: string): void
}

/**
 * Nguồn thông tin xác thực của một cluster: tĩnh (token, chứng chỉ, basic) hoặc làm mới được (exec
 * plugin — chạy qua ctx.spawn, hỏi người dùng lần đầu; OIDC refresh token).
 */
export function credentialProvider(
  auth: AuthConfig,
  spawn: LimitedSpawn,
  server: string,
  now: () => number = Date.now,
  hooks: CredentialHooks = {}
): (refresh: boolean) => Promise<Credentials> {
  let cached: { creds: Credentials; expires: number } | null = null
  let oidcToken = auth.oidc?.idToken
  // Refresh token mới nhất (IdP có thể xoay vòng — bản trong kubeconfig không dùng lại được nữa).
  let refreshToken = auth.oidc?.refreshToken
  /** Lần làm mới đang chạy — nhiều request cùng hết hạn / cùng bị 401 chỉ làm mới một lần. */
  let inflight: Promise<void> | null = null
  /** Lúc làm mới xong gần nhất: 401 của request gửi trước đó không làm mới lần nữa. */
  let refreshedAt = Number.NEGATIVE_INFINITY

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
    checkPluginArgs(binary, exec.args)
    const { env, dropped } = pluginEnv(exec.env)
    if (dropped.length)
      hooks.log?.(`exec plugin ${binary}: ignored environment variables ${dropped.join(', ')}`)
    const info = {
      kind: 'ExecCredential',
      apiVersion: exec.apiVersion,
      spec: { cluster: { server }, interactive: false }
    }
    const r = await spawn.exec(binary, exec.args, {
      env: { ...env, KUBERNETES_EXEC_INFO: JSON.stringify(info) },
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
    if (!refreshToken || !o?.issuer || !o.clientId)
      throw new Error('The OIDC token expired — sign in again with kubectl to refresh it')
    if (!/^https:\/\//i.test(o.issuer))
      throw new Error('The OIDC issuer must use https — sign in again with kubectl')
    const discovery = await getJson(
      `${o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      o.idpCa
    )
    const endpoint = discovery['token_endpoint']
    if (typeof endpoint !== 'string' || !/^https:\/\//i.test(endpoint))
      throw new Error('The identity provider has no token endpoint')
    const exchange = (token: string): Promise<Record<string, unknown>> =>
      postForm(
        endpoint,
        {
          grant_type: 'refresh_token',
          refresh_token: token,
          client_id: o.clientId ?? '',
          ...(o.clientSecret ? { client_secret: o.clientSecret } : {})
        },
        o.idpCa
      )
    let res: Record<string, unknown>
    try {
      res = await exchange(refreshToken)
    } catch (error) {
      // Refresh token bị từ chối: tab khác có thể đã xoay vòng nó → đọc bản đã lưu, thử lại một lần.
      if ((error as { oauthError?: unknown }).oauthError !== 'invalid_grant' || !hooks.reloadOidc)
        throw error
      const used = refreshToken
      const latest = await hooks.reloadOidc().catch(() => null)
      if (!latest?.refreshToken || latest.refreshToken === used) throw error
      refreshToken = latest.refreshToken
      // Token tab kia vừa lấy còn hạn (và khác token đang bị từ chối) → dùng luôn, không xoay vòng thêm.
      const exp = latest.idToken ? jwtExpiry(latest.idToken) : null
      if (latest.idToken && latest.idToken !== oidcToken && exp !== null && exp - 60_000 > now())
        return latest.idToken
      res = await exchange(refreshToken)
    }
    const idToken = res['id_token']
    if (typeof idToken !== 'string') throw new Error('The identity provider returned no id_token')
    // IdP xoay vòng refresh token (Dex, Keycloak, Okta…): bản cũ hết hiệu lực → giữ bản mới.
    const next = res['refresh_token']
    if (typeof next === 'string' && next) refreshToken = next
    hooks.onOidcRefreshed?.({ idToken, ...(refreshToken ? { refreshToken } : {}) })
    return idToken
  }

  /** Chạy `fn` một lần cho mọi người gọi cùng lúc. */
  const once = (fn: () => Promise<void>): Promise<void> => {
    inflight ??= fn()
      .then(() => {
        refreshedAt = now()
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
  /** 401 ngay sau khi vừa làm mới (request gửi bằng token cũ) → không làm mới lần nữa. */
  const justRefreshed = (): boolean => now() - refreshedAt < 5_000

  return async (refresh) => {
    if (auth.exec) {
      if (inflight) await inflight
      if ((refresh && !justRefreshed()) || !cached || cached.expires - 60_000 < now())
        await once(async () => {
          cached = await runExec()
        })
      if (!cached) throw new Error('No credential')
      return cached.creds
    }
    if (auth.oidc) {
      if (inflight) await inflight
      const exp = oidcToken ? jwtExpiry(oidcToken) : null
      if ((refresh && !justRefreshed()) || !oidcToken || (exp !== null && exp - 60_000 < now()))
        await once(async () => {
          oidcToken = await refreshOidc()
        })
      return { ...staticCreds(), headers: { Authorization: `Bearer ${oidcToken ?? ''}` } }
    }
    return staticCreds()
  }
}
