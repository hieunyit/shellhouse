import { basename, extname } from 'node:path'
import { t } from '@shared/i18n'
import { Hostname, type HostInput, type ImportCandidate } from '@shared/hosts'
import {
  RdpUsername,
  type RdpSettings,
  type RdpCheckResult,
  type RdpLaunchRequest,
  type RdpLaunchResult
} from '@shared/rdp'
import type { ResolvedRdp } from '../hosts/service'
import { installHint, type DetectedClient } from './detect'
import type { RdpLauncher } from './launcher'
import { parseRdpFile, qualifiedUser, type ParsedRdpFile, type RdpTarget } from './rdp-file'

export interface RdpControllerDeps {
  platform: NodeJS.Platform
  /** Client RDP trên máy (main dò một lần, dò lại nếu lần trước chưa có). */
  detect(): Promise<DetectedClient | null>
  resolve(hostId: string, touch: boolean): ResolvedRdp
  launcher: Pick<RdpLauncher, 'launch' | 'stop'>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** FreeRDP chạy nền không có terminal để tự hỏi mật khẩu → Shellhouse hỏi (không lưu). */
const needsStdinPassword = (client: DetectedClient): boolean => client.kind === 'xfreerdp'

/**
 * Kiểm tra / mở phiên RDP cho một host đã lưu. Tunnel SSH (nếu có) do renderer mở bằng cơ chế
 * forward sẵn có rồi gửi cổng local vào đây — main chỉ nhận cổng đó khi host thật sự cấu hình tunnel.
 */
export class RdpController {
  constructor(private readonly deps: RdpControllerDeps) {}

  private missingClient(): { ok: false; message: string; hint: string } {
    return {
      ok: false,
      message: t('No Remote Desktop client was found on this computer'),
      hint: installHint(this.deps.platform)
    }
  }

  async check(hostId: string): Promise<RdpCheckResult> {
    const client = await this.deps.detect()
    if (!client) return this.missingClient()
    let host: ResolvedRdp
    try {
      host = this.deps.resolve(hostId, false)
    } catch (error) {
      return { ok: false, message: message(error), hint: null }
    }
    try {
      if (needsStdinPassword(client) && !host.username)
        return {
          ok: false,
          message: t('Add a username to “{name}” — {client} needs it to sign in', {
            name: host.label,
            client: client.name
          }),
          hint: null
        }
      return {
        ok: true,
        client: { kind: client.kind, name: client.name },
        askPassword: needsStdinPassword(client) && host.password === null,
        username: host.username ? qualifiedUser(host.username, host.settings.domain) : '',
        target: { host: host.host, port: host.port },
        via: host.via
      }
    } finally {
      host.password?.dispose()
    }
  }

  async launch(request: RdpLaunchRequest): Promise<RdpLaunchResult> {
    const client = await this.deps.detect()
    if (!client) return this.missingClient()
    let host: ResolvedRdp
    try {
      host = this.deps.resolve(request.hostId, true)
    } catch (error) {
      return { ok: false, message: message(error), hint: null }
    }
    try {
      const tunnel = request.tunnelPort
      if (host.via && tunnel === undefined)
        return {
          ok: false,
          message: t('“{name}” connects through {via} — the SSH tunnel is not open', {
            name: host.label,
            via: host.via.label
          }),
          hint: null
        }
      // Không nhận cổng tunnel cho host kết nối thẳng: mật khẩu đã lưu không bị gửi tới một cổng
      // local bất kỳ.
      if (!host.via && tunnel !== undefined)
        return { ok: false, message: t('This host does not use an SSH tunnel'), hint: null }
      const settings = {
        ...host.settings,
        ...(request.fullScreen !== undefined ? { fullScreen: request.fullScreen } : {})
      }
      const target: RdpTarget = {
        label: host.label,
        host: tunnel !== undefined ? '127.0.0.1' : host.host,
        port: tunnel ?? host.port,
        username: host.username,
        domain: settings.domain,
        settings
      }
      const password =
        host.password?.revealString() ??
        (needsStdinPassword(client) ? (request.password ?? null) : null)
      if (needsStdinPassword(client) && password === null)
        return { ok: false, message: t('Enter the password to connect'), hint: null }
      const { launchId, tracked } = await this.deps.launcher.launch({ client, target, password })
      return { ok: true, launchId, client: { kind: client.kind, name: client.name }, tracked }
    } catch (error) {
      return { ok: false, message: message(error), hint: null }
    } finally {
      host.password?.dispose()
    }
  }
}

/** Thông tin kết nối đầy đủ của một host RDP (cho trình xem nhúng trong tab). */
export interface RdpConnectionInfo {
  hostId: string
  label: string
  host: string
  port: number
  username: string
  domain: string
  /** Mật khẩu đã giải mã từ vault; null = "Ask each time". KHÔNG log, không gửi qua renderer nếu tránh được. */
  password: string | null
  /** SSH host làm tunnel (forward 127.0.0.1:<cổng> → host:port); null = kết nối thẳng. */
  sshHostId: string | null
  sshHostLabel: string | null
  /** RD Gateway; null = không dùng. */
  gateway: string | null
  settings: RdpSettings
}

/**
 * API dùng chung (main): giải mã thông tin kết nối của host RDP theo id. Ném lỗi (đã dịch) khi host
 * không tồn tại / không phải RDP / SSH host của tunnel không hợp lệ. Cập nhật "dùng gần nhất".
 */
export function resolveRdpConnection(
  hosts: { resolveRdp(hostId: string, touch?: boolean): ResolvedRdp },
  hostId: string
): RdpConnectionInfo {
  const r = hosts.resolveRdp(hostId, true)
  try {
    return {
      hostId,
      label: r.label,
      host: r.host,
      port: r.port,
      username: r.username,
      domain: r.settings.domain,
      password: r.password ? r.password.revealString() : null,
      sshHostId: r.via?.id ?? null,
      sshHostLabel: r.via?.label ?? null,
      gateway: r.settings.gateway,
      settings: r.settings
    }
  } finally {
    r.password?.dispose()
  }
}

/** Kết quả quét các file .rdp người dùng chọn (Import). */
export interface RdpFileScan {
  candidates: ImportCandidate[]
  parsed: Map<string, ParsedRdpFile & { label: string }>
}

/** Quét file .rdp: mỗi file một host; tên = tên file. */
export function scanRdpFiles(
  files: readonly { path: string; text: string | null }[],
  existingLabels: readonly string[]
): RdpFileScan {
  const existing = new Set(existingLabels.map((l) => l.toLowerCase()))
  const candidates: ImportCandidate[] = []
  const parsed = new Map<string, ParsedRdpFile & { label: string }>()
  const used = new Set<string>()
  for (const file of files) {
    const label = basename(file.path, extname(file.path)).trim().slice(0, 100) || 'RDP'
    let alias = basename(file.path)
    for (let i = 2; used.has(alias); i++) alias = `${basename(file.path)} (${i})`
    used.add(alias)
    const result = file.text === null ? null : parseRdpFile(file.text)
    const problem =
      file.text === null
        ? t('Could not read the file')
        : !result
          ? t('No computer address in the file')
          : !Hostname.safeParse(result.hostname).success
            ? t('Invalid hostname')
            : null
    if (result && !problem) parsed.set(alias, { ...result, label })
    candidates.push({
      alias,
      label,
      hostname: result?.hostname ?? '',
      port: result?.port ?? 3389,
      username: result?.username || null,
      keyFile: null,
      proxyJump: null,
      duplicate: existing.has(label.toLowerCase()),
      problem
    })
  }
  return { candidates, parsed }
}

/** Host RDP từ một file .rdp đã quét. Username không hợp lệ → để trống (client tự hỏi). */
export function rdpHostInput(file: ParsedRdpFile & { label: string }): HostInput {
  return {
    protocol: 'rdp',
    groupId: null,
    label: file.label,
    hostname: file.hostname,
    port: file.port,
    username: RdpUsername.safeParse(file.username).success ? file.username : '',
    auth: 'auto',
    keyId: null,
    keyFile: null,
    proxyJump: null,
    jumpHostIds: [],
    mode: 'builtin',
    rdp: file.settings,
    tags: ['rdp'],
    color: null
  }
}
