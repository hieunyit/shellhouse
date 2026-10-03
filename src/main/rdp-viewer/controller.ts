import { t } from '@shared/i18n'
import { hostPort, splitDomainUser } from '@shared/rdp'
import type {
  RdpCertInfo,
  RdpViewOpenRequest,
  RdpViewOpenResult,
  RdpViewPrepare,
  RdpViewProbeRequest,
  RdpViewProbeResult,
  RdpViewTarget
} from '@shared/rdp-viewer'
import type { ResolvedRdp } from '../hosts/service'
import type { RdpCertStore } from './cert-store'

export interface RdpViewDeps {
  resolve(hostId: string, touch: boolean): ResolvedRdp
  certs: Pick<RdpCertStore, 'check' | 'pinned' | 'trust'>
  /** Session Host: dò chứng chỉ server. */
  probe(target: RdpViewTarget): Promise<RdpCertInfo>
  /** Session Host: cấp token proxy cho đích + dấu chứng chỉ đã tin. */
  open(target: RdpViewTarget, pin: string): Promise<{ proxyAddress: string; token: string }>
  now?: () => number
}

/** Kết quả dò gần nhất của host — chỉ tin được đúng chứng chỉ vừa thấy, trong thời gian ngắn. */
interface Probed {
  host: string
  port: number
  cert: RdpCertInfo
  at: number
}
const PROBE_VALID_MS = 10 * 60_000

function withSecret<T>(host: ResolvedRdp, use: (h: ResolvedRdp) => T): T {
  try {
    return use(host)
  } finally {
    host.password?.dispose()
  }
}

/**
 * Phần main của trình xem RDP trong tab. Main quyết định đích (host:port của host đã lưu, qua SSH
 * host nếu cấu hình) — renderer chỉ gửi id host và id phiên SSH của tunnel; mật khẩu đã lưu chỉ
 * được trao khi chứng chỉ server đã được tin.
 */
export class RdpViewController {
  private readonly probed = new Map<string, Probed>()
  private readonly now: () => number

  constructor(private readonly deps: RdpViewDeps) {
    this.now = deps.now ?? Date.now
  }

  prepare(hostId: string): RdpViewPrepare {
    let host: ResolvedRdp
    try {
      host = this.deps.resolve(hostId, false)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        external: false
      }
    }
    return withSecret(host, (h) => {
      if (h.settings.gateway)
        return {
          ok: false as const,
          message: t(
            '“{name}” connects through an RD Gateway, which the built-in viewer does not support yet',
            { name: h.label }
          ),
          external: true
        }
      return {
        ok: true as const,
        label: h.label,
        address: hostPort(h.host, h.port),
        username: h.username,
        domain: h.settings.domain,
        hasPassword: h.password !== null,
        via: h.via,
        clipboard: h.settings.clipboard,
        dynamicResolution: h.settings.dynamicResolution,
        width: h.settings.width,
        height: h.settings.height
      }
    })
  }

  /** Đích của host — kiểm tunnel khớp cấu hình (không nhận phiên SSH cho host kết nối thẳng). */
  private target(h: ResolvedRdp, viaSessionId: string | undefined): RdpViewTarget {
    if (h.settings.gateway) throw new Error(t('RD Gateway is not supported by the built-in viewer'))
    if (h.via && !viaSessionId)
      throw new Error(
        t('“{name}” connects through {via} — the SSH tunnel is not open', {
          name: h.label,
          via: h.via.label
        })
      )
    if (!h.via && viaSessionId) throw new Error(t('This host does not use an SSH tunnel'))
    return { host: h.host, port: h.port, ...(viaSessionId ? { viaSessionId } : {}) }
  }

  async probe(request: RdpViewProbeRequest): Promise<RdpViewProbeResult> {
    const host = this.deps.resolve(request.hostId, false)
    const target = withSecret(host, (h) => this.target(h, request.viaSessionId))
    const cert = await this.deps.probe(target)
    this.probed.set(request.hostId, { host: target.host, port: target.port, cert, at: this.now() })
    const check = this.deps.certs.check(target.host, target.port, cert.fingerprint)
    return {
      cert,
      status: check.status,
      known: check.status === 'changed' ? check.known : null
    }
  }

  /** Tin chứng chỉ vừa dò (đúng dấu renderer đã cho người dùng xem). */
  trust(hostId: string, fingerprint: string): void {
    const p = this.probed.get(hostId)
    if (!p || p.cert.fingerprint !== fingerprint || this.now() - p.at > PROBE_VALID_MS)
      throw new Error(t('The certificate check expired — connect again'))
    this.deps.certs.trust(p.host, p.port, p.cert.fingerprint, p.cert.subject, this.now())
  }

  async open(request: RdpViewOpenRequest): Promise<RdpViewOpenResult> {
    const host = this.deps.resolve(request.hostId, true)
    const prepared = withSecret(host, (h) => {
      const target = this.target(h, request.viaSessionId)
      const pin = this.deps.certs.pinned(target.host, target.port)
      if (!pin) throw new Error(t('The server certificate has not been trusted yet'))
      const typed = request.username ? splitDomainUser(request.username) : null
      const username = typed?.username ?? h.username
      const domain = typed?.domain ?? request.domain ?? h.settings.domain
      const password = request.password ?? h.password?.revealString() ?? null
      if (!username) throw new Error(t('Enter a username'))
      if (password === null) throw new Error(t('Enter the password to connect'))
      return { target, pin, username, domain, password }
    })
    const { proxyAddress, token } = await this.deps.open(prepared.target, prepared.pin)
    return {
      proxyAddress,
      authToken: token,
      destination: hostPort(prepared.target.host, prepared.target.port),
      username: prepared.username,
      domain: prepared.domain,
      password: prepared.password
    }
  }
}
