import { t } from '@shared/i18n'
import { uuidv7 } from '../../../node-shared/uuid'
import type { ModuleDb, ModuleSecrets } from '../../registry/main-types'
import type { RegistryAuth } from '../shared/ops'
import { normalizeRegistry, type DockerRegistry, type RegistryInput } from '../shared/ipc'

interface Row {
  id: string
  name: string
  server: string
  username: string
  secret_enc: Buffer | null
}

/**
 * Registry đã lưu: mật khẩu / token nằm trong vault, chỉ giải mã khi Session Host cần kéo / đẩy
 * image (không bao giờ gửi renderer).
 */
export class DockerRegistries {
  constructor(
    private readonly db: ModuleDb,
    private readonly secrets: ModuleSecrets,
    private readonly now: () => number = Date.now
  ) {}

  list(): DockerRegistry[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, server, username, secret_enc FROM docker_registries
         WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      server: r.server,
      username: r.username,
      hasSecret: r.secret_enc !== null
    }))
  }

  save(input: RegistryInput): string {
    const now = this.now()
    const id = input.id ?? uuidv7(now)
    const server = normalizeRegistry(input.server)
    if (!server) throw new Error(t('Enter the registry address'))
    const secret =
      input.secret === undefined || (input.id && input.secret === '')
        ? undefined
        : this.secrets.seal('docker_registries', id, 'secret_enc', input.secret)
    const values = [input.name.trim(), server, input.username.trim(), now]
    if (input.id) {
      const result = this.db
        .prepare(
          `UPDATE docker_registries SET name = ?, server = ?, username = ?, updated_at = ?${
            secret === undefined ? '' : ', secret_enc = ?'
          } WHERE id = ? AND deleted_at IS NULL`
        )
        .run(...values, ...(secret === undefined ? [] : [secret]), id)
      if (result.changes === 0) throw new Error(t('The registry no longer exists'))
      return id
    }
    if (!secret) throw new Error(t('Enter the password or access token'))
    this.db
      .prepare(
        `INSERT INTO docker_registries (name, server, username, updated_at, secret_enc, id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(...values, secret, id)
    return id
  }

  delete(id: string): void {
    const now = this.now()
    this.db
      .prepare(
        'UPDATE docker_registries SET deleted_at = ?, updated_at = ?, secret_enc = NULL WHERE id = ?'
      )
      .run(now, now, id)
  }

  /** Thông tin đăng nhập (giải mã) — chỉ trả cho Session Host. */
  resolve(id: string): RegistryAuth {
    const row = this.db
      .prepare(
        `SELECT id, name, server, username, secret_enc FROM docker_registries
         WHERE id = ? AND deleted_at IS NULL`
      )
      .get(id) as Row | undefined
    if (!row) throw new Error(t('The registry no longer exists'))
    if (!row.secret_enc)
      throw new Error(t('“{name}” has no password — edit the registry', { name: row.name }))
    return {
      server: row.server,
      username: row.username,
      password: this.secrets.open('docker_registries', id, 'secret_enc', row.secret_enc)
    }
  }
}
