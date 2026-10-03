import type { Db } from '../store/db'

export type RdpCertCheck =
  { status: 'trusted' } | { status: 'unknown' } | { status: 'changed'; known: string }

/**
 * Chứng chỉ TLS của server RDP đã tin (TOFU, như known_hosts): theo host:port của đích. Server RDP
 * gần như luôn dùng chứng chỉ tự ký nên không kiểm theo CA — ghim dấu SHA-256 lần đầu, đổi thì hỏi lại.
 */
export class RdpCertStore {
  constructor(private readonly db: Db) {}

  check(host: string, port: number, fingerprint: string): RdpCertCheck {
    const row = this.db
      .prepare('SELECT fingerprint FROM rdp_certificates WHERE host = ? AND port = ?')
      .get(host.toLowerCase(), port) as { fingerprint: string } | undefined
    if (!row) return { status: 'unknown' }
    return row.fingerprint === fingerprint
      ? { status: 'trusted' }
      : { status: 'changed', known: row.fingerprint }
  }

  /** Dấu đã tin cho đích (null = chưa tin chứng chỉ nào). */
  pinned(host: string, port: number): string | null {
    const row = this.db
      .prepare('SELECT fingerprint FROM rdp_certificates WHERE host = ? AND port = ?')
      .get(host.toLowerCase(), port) as { fingerprint: string } | undefined
    return row?.fingerprint ?? null
  }

  trust(host: string, port: number, fingerprint: string, subject: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO rdp_certificates (host, port, fingerprint, subject, trusted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (host, port) DO UPDATE SET fingerprint = excluded.fingerprint,
           subject = excluded.subject, trusted_at = excluded.trusted_at`
      )
      .run(host.toLowerCase(), port, fingerprint, subject.slice(0, 2048), now)
  }
}
