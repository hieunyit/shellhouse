import { t } from '@shared/i18n'
import type { MainModule } from '../../registry/main-types'
import { dockerManifest } from '../manifest'
import { DockerIpc, endpointId, tcpSource, type DockerEndpoint } from '../shared/ipc'
import { DockerSessionConfig } from '../shared/ops'
import m0001 from '../migrations/0001_endpoints.sql?raw'
import m0002 from '../migrations/0002_hidden.sql?raw'
import m0003 from '../migrations/0003_registries.sql?raw'
import m0004 from '../migrations/0004_tcp.sql?raw'
import { DockerRegistries } from './registries'
import { DockerTcpEndpoints } from './tcp-endpoints'

interface Row {
  id: string
  host_id: string | null
  read_only: number
  hidden: number
}

/** Phần main của Docker: danh sách nguồn (máy này / host SSH) và chế độ chỉ đọc. */
export const dockerMain: MainModule = {
  manifest: dockerManifest,
  migrations: [
    { version: 1, name: 'endpoints', sql: m0001 },
    { version: 2, name: 'hidden', sql: m0002 },
    { version: 3, name: 'registries', sql: m0003 },
    { version: 4, name: 'tcp', sql: m0004 }
  ],
  activate(ctx) {
    const now = (): number => Date.now()
    const changed = (): void => {
      ctx.events.emit('changed', null)
    }
    const list = (): DockerEndpoint[] =>
      (
        ctx.db
          .prepare('SELECT id, host_id, read_only, hidden FROM docker_endpoints ORDER BY added_at')
          .all() as Row[]
      ).map((r) => ({
        id: r.id,
        hostId: r.host_id,
        readOnly: r.read_only === 1,
        hidden: r.hidden === 1
      }))
    ctx.ipc.handle('endpoints', DockerIpc.endpoints, list)
    ctx.ipc.handle('add', DockerIpc.add, (hostId) => {
      ctx.db
        .prepare(
          `INSERT INTO docker_endpoints (id, host_id, read_only, added_at, updated_at)
           VALUES (?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET hidden = 0, updated_at = excluded.updated_at`
        )
        .run(endpointId(hostId), hostId, now(), now())
      changed()
    })
    ctx.ipc.handle('remove', DockerIpc.remove, (hostId) => {
      ctx.db.prepare('DELETE FROM docker_endpoints WHERE id = ?').run(endpointId(hostId))
      changed()
    })
    ctx.ipc.handle('hide', DockerIpc.hide, (hostId) => {
      ctx.db
        .prepare(
          `INSERT INTO docker_endpoints (id, host_id, read_only, hidden, added_at, updated_at)
           VALUES (?, ?, 0, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET hidden = 1, updated_at = excluded.updated_at`
        )
        .run(endpointId(hostId), hostId, now(), now())
      changed()
    })
    ctx.ipc.handle('setReadOnly', DockerIpc.setReadOnly, (hostId, readOnly) => {
      ctx.db
        .prepare(
          `INSERT INTO docker_endpoints (id, host_id, read_only, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET read_only = excluded.read_only, updated_at = excluded.updated_at`
        )
        .run(endpointId(hostId), hostId, readOnly ? 1 : 0, now(), now())
      changed()
    })
    ctx.ipc.handle('wslDistros', DockerIpc.wslDistros, () => ctx.wslDistros())
    // Engine TCP + TLS (chứng chỉ trong vault): lưu → hiện ngay ở thanh bên như mọi nguồn khác.
    const tcp = new DockerTcpEndpoints(ctx.db, ctx.secrets)
    ctx.ipc.handle('tcpEndpoints', DockerIpc.tcpEndpoints, () => tcp.list())
    ctx.ipc.handle('saveTcp', DockerIpc.saveTcp, (input) => {
      try {
        const id = tcp.save(input)
        const source = tcpSource(id)
        ctx.db
          .prepare(
            `INSERT INTO docker_endpoints (id, host_id, read_only, added_at, updated_at)
             VALUES (?, ?, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET hidden = 0, updated_at = excluded.updated_at`
          )
          .run(endpointId(source), source, now(), now())
        changed()
        return { ok: true, id }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ctx.ipc.handle('pickPem', DockerIpc.pickPem, async (what) => {
      const files = await ctx.pickFiles({
        title:
          what === 'ca'
            ? t('Choose the CA certificate (ca.pem)')
            : what === 'cert'
              ? t('Choose the client certificate (cert.pem)')
              : t('Choose the client private key (key.pem)'),
        filters: [
          { name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] },
          { name: t('All files'), extensions: ['*'] }
        ]
      })
      const file = files[0]
      return file ? { name: file.name, content: file.content } : null
    })
    ctx.ipc.handle('deleteTcp', DockerIpc.deleteTcp, (id) => {
      tcp.delete(id)
      ctx.db.prepare('DELETE FROM docker_endpoints WHERE id = ?').run(endpointId(tcpSource(id)))
      changed()
    })
    // Registry (mật khẩu / token trong vault): renderer chỉ thấy tên, máy chủ, tên đăng nhập.
    const registries = new DockerRegistries(ctx.db, ctx.secrets)
    ctx.ipc.handle('registries', DockerIpc.registries, () => registries.list())
    ctx.ipc.handle('saveRegistry', DockerIpc.saveRegistry, (input) => {
      try {
        const id = registries.save(input)
        changed()
        return { ok: true, id }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ctx.ipc.handle('deleteRegistry', DockerIpc.deleteRegistry, (id) => {
      registries.delete(id)
      changed()
    })
    /** Cờ chỉ đọc đã lưu của một nguồn (null = máy này). */
    const readOnlyOf = (hostId: string | null): boolean => {
      const row = ctx.db
        .prepare('SELECT read_only FROM docker_endpoints WHERE id = ?')
        .get(endpointId(hostId)) as { read_only: number } | undefined
      return row?.read_only === 1
    }
    return {
      // Session Host hỏi cờ chỉ đọc (thao tác thay đổi, shell / exec) — không tin cờ renderer gửi.
      onHostRequest: (name, params): unknown => {
        if (name === 'readOnly') return readOnlyOf(DockerIpc.readOnlyQuery.parse(params))
        // Kéo / đẩy image riêng tư: mật khẩu giải mã ở đây, đi thẳng sang Session Host.
        if (name === 'registryAuth')
          return registries.resolve(DockerIpc.registryAuthQuery.parse(params))
        throw new Error(`Unknown request: ${name}`)
      },
      // Phiên trên máy này: không có gì cần giải mã — Session Host tự dò socket. Tab / terminal
      // của Docker trong WSL mang tên distro.
      resolveSession: (_kind, raw): DockerSessionConfig => {
        const params = raw as { wsl?: unknown; tcp?: unknown } | null
        // Engine TCP + TLS: main giải mã chứng chỉ, chỉ Session Host nhận.
        if (typeof params?.tcp === 'string') return { tcp: tcp.resolve(params.tcp) }
        const wsl = params?.wsl
        return DockerSessionConfig.parse(wsl === undefined ? {} : { wsl })
      }
    }
  }
}
