import { t } from '@shared/i18n'
import { uuidv7 } from '../../../node-shared/uuid'
import type { ModuleDb, ModuleSecrets } from '../../registry/main-types'
import type { DockerTcpConfig } from '../shared/ops'
import type { DockerTcpEndpoint, TcpEndpointInput } from '../shared/ipc'
import { checkTlsMaterial, type TlsMaterial } from './tls-material'

interface Row {
  id: string
  name: string
  host: string
  port: number
  ca_enc: Buffer | null
  cert_enc: Buffer | null
  key_enc: Buffer | null
  cert_expires: number | null
  cert_subject: string | null
}

const TABLE = 'docker_tcp'

/**
 * Engine Docker ở địa chỉ TCP + TLS. CA, chứng chỉ client và khoá riêng mã hoá bằng vault; chỉ giải
 * mã khi mở phiên và chỉ gửi sang Session Host — renderer không bao giờ thấy PEM.
 */
export class DockerTcpEndpoints {
  constructor(
    private readonly db: ModuleDb,
    private readonly secrets: ModuleSecrets,
    private readonly now: () => number = Date.now
  ) {}

  list(): DockerTcpEndpoint[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, host, port, ca_enc, cert_enc, key_enc, cert_expires, cert_subject
         FROM ${TABLE} WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      hasCa: r.ca_enc !== null,
      hasCert: r.cert_enc !== null,
      hasKey: r.key_enc !== null,
      certExpires: r.cert_expires,
      certSubject: r.cert_subject
    }))
  }

  private row(id: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT id, name, host, port, ca_enc, cert_enc, key_enc, cert_expires, cert_subject
         FROM ${TABLE} WHERE id = ? AND deleted_at IS NULL`
      )
      .get(id) as Row | undefined
  }

  private open(id: string, field: string, sealed: Buffer | null): string | undefined {
    return sealed === null ? undefined : this.secrets.open(TABLE, id, field, sealed)
  }

  /** PEM hiện có của một engine (để kiểm lại cặp cert / key khi chỉ sửa một phần). */
  private material(row: Row): TlsMaterial {
    return {
      ca: this.open(row.id, 'ca_enc', row.ca_enc),
      cert: this.open(row.id, 'cert_enc', row.cert_enc),
      key: this.open(row.id, 'key_enc', row.key_enc)
    }
  }

  /**
   * Thêm / sửa. Trường PEM: chuỗi = thay, null = xoá, vắng = giữ. Kiểm trên bộ PEM SAU khi áp dụng
   * thay đổi — sửa chỉ khoá mà không khớp chứng chỉ cũ thì báo ngay.
   */
  save(input: TcpEndpointInput): string {
    const existing = input.id ? this.row(input.id) : undefined
    if (input.id && !existing) throw new Error(t('The engine no longer exists'))
    const current = existing ? this.material(existing) : {}
    const pick = (next: string | null | undefined, old: string | undefined): string | undefined =>
      next === undefined ? old : next === null || next.trim() === '' ? undefined : next
    const material: TlsMaterial = {
      ca: pick(input.ca, current.ca),
      cert: pick(input.cert, current.cert),
      key: pick(input.key, current.key)
    }
    // Hết hạn chỉ chặn khi người dùng vừa nhập chứng chỉ mới — đổi tên một engine cũ vẫn được.
    const info = checkTlsMaterial(material, input.cert === undefined ? 0 : this.now())
    const id = input.id ?? uuidv7(this.now())
    const seal = (field: string, value: string | undefined): Buffer | null =>
      value === undefined ? null : this.secrets.seal(TABLE, id, field, value)
    const values = [
      input.name.trim(),
      input.host,
      input.port,
      seal('ca_enc', material.ca),
      seal('cert_enc', material.cert),
      seal('key_enc', material.key),
      info.expires,
      info.subject,
      this.now()
    ]
    if (existing)
      this.db
        .prepare(
          `UPDATE ${TABLE} SET name = ?, host = ?, port = ?, ca_enc = ?, cert_enc = ?, key_enc = ?,
             cert_expires = ?, cert_subject = ?, updated_at = ? WHERE id = ?`
        )
        .run(...values, id)
    else
      this.db
        .prepare(
          `INSERT INTO ${TABLE} (name, host, port, ca_enc, cert_enc, key_enc, cert_expires,
             cert_subject, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...values, id)
    return id
  }

  delete(id: string): void {
    this.db
      .prepare(
        `UPDATE ${TABLE} SET deleted_at = ?, ca_enc = NULL, cert_enc = NULL, key_enc = NULL WHERE id = ?`
      )
      .run(this.now(), id)
  }

  /** Cấu hình đầy đủ cho Session Host (PEM đã giải mã). */
  resolve(id: string): DockerTcpConfig {
    const row = this.row(id)
    if (!row) throw new Error(t('The engine no longer exists'))
    const m = this.material(row)
    return {
      id: row.id,
      host: row.host,
      port: row.port,
      ...(m.ca ? { ca: m.ca } : {}),
      ...(m.cert ? { cert: m.cert } : {}),
      ...(m.key ? { key: m.key } : {})
    }
  }
}
