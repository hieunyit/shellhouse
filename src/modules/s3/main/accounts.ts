import { z } from 'zod'
import { uuidv7 } from '../../../node-shared/uuid'
import type { ModuleDb, ModuleSecrets } from '../../registry/main-types'
import { MAX_S3_PINS, S3Pin, type S3AccountInput, type S3AccountSummary } from '../shared/ops'

interface Row {
  id: string
  name: string
  endpoint: string
  region: string
  access_key_id: string
  secret_enc: Buffer | null
  path_style: number
  pins: string
}

function parsePins(json: string): S3Pin[] {
  try {
    const parsed = z.array(S3Pin).safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** Tài khoản S3: secret key nằm trong vault, chỉ giải mã lúc mở kết nối (không gửi renderer). */
export class S3Accounts {
  constructor(
    private readonly db: ModuleDb,
    private readonly secrets: ModuleSecrets,
    private readonly now: () => number = Date.now
  ) {}

  list(): S3AccountSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, endpoint, region, access_key_id, secret_enc, path_style, pins
         FROM s3_accounts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      endpoint: r.endpoint,
      region: r.region,
      accessKeyId: r.access_key_id,
      forcePathStyle: r.path_style === 1,
      hasSecret: r.secret_enc !== null,
      pins: parsePins(r.pins)
    }))
  }

  /** Ghim / bỏ ghim bucket hoặc thư mục (mục mới thêm vào cuối). */
  setPin(id: string, pin: S3Pin, pinned: boolean): void {
    const row = this.db
      .prepare('SELECT pins FROM s3_accounts WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { pins: string } | undefined
    if (!row) throw new Error('The S3 account no longer exists')
    const same = (p: S3Pin): boolean => p.bucket === pin.bucket && p.prefix === pin.prefix
    const pins = parsePins(row.pins).filter((p) => !same(p))
    if (pinned) {
      if (pins.length >= MAX_S3_PINS) throw new Error(`You can pin up to ${MAX_S3_PINS} locations`)
      pins.push(pin)
    }
    this.db
      .prepare('UPDATE s3_accounts SET pins = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(pins), this.now(), id)
  }

  save(input: S3AccountInput): string {
    const now = this.now()
    const id = input.id ?? uuidv7(now)
    const secret =
      input.secretAccessKey === undefined
        ? undefined
        : input.secretAccessKey === ''
          ? null
          : this.secrets.seal('s3_accounts', id, 'secret_enc', input.secretAccessKey)
    const values = [
      input.name,
      input.endpoint,
      input.region,
      input.accessKeyId,
      input.forcePathStyle ? 1 : 0,
      now
    ]
    if (input.id) {
      const result = this.db
        .prepare(
          `UPDATE s3_accounts SET name = ?, endpoint = ?, region = ?, access_key_id = ?,
             path_style = ?, updated_at = ?${secret === undefined ? '' : ', secret_enc = ?'}
           WHERE id = ? AND deleted_at IS NULL`
        )
        .run(...values, ...(secret === undefined ? [] : [secret]), id)
      if (result.changes === 0) throw new Error('The S3 account no longer exists')
      return id
    }
    if (!secret) throw new Error('Enter the secret access key')
    this.db
      .prepare(
        `INSERT INTO s3_accounts (name, endpoint, region, access_key_id, path_style, updated_at,
           secret_enc, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...values, secret, id)
    return id
  }

  delete(id: string): void {
    const now = this.now()
    this.db
      .prepare(
        'UPDATE s3_accounts SET deleted_at = ?, updated_at = ?, secret_enc = NULL WHERE id = ?'
      )
      .run(now, now, id)
  }

  /** Thông tin kết nối (giải mã secret) — chỉ gửi sang Session Host. */
  resolve(id: string): {
    name: string
    endpoint: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
  } {
    const row = this.db
      .prepare(
        `SELECT id, name, endpoint, region, access_key_id, secret_enc, path_style FROM s3_accounts
         WHERE id = ? AND deleted_at IS NULL`
      )
      .get(id) as Row | undefined
    if (!row) throw new Error('The S3 account no longer exists')
    if (!row.secret_enc) throw new Error(`"${row.name}" has no secret key — edit the account`)
    return {
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      accessKeyId: row.access_key_id,
      secretAccessKey: this.secrets.open('s3_accounts', id, 'secret_enc', row.secret_enc),
      forcePathStyle: row.path_style === 1
    }
  }
}
