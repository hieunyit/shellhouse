import type { MainModule } from '../../registry/main-types'
import { dockerManifest } from '../manifest'
import { DockerIpc, endpointId, type DockerEndpoint } from '../shared/ipc'
import m0001 from '../migrations/0001_endpoints.sql?raw'

interface Row {
  id: string
  host_id: string | null
  read_only: number
}

/** Phần main của Docker: danh sách nguồn (máy này / host SSH) và chế độ chỉ đọc. */
export const dockerMain: MainModule = {
  manifest: dockerManifest,
  migrations: [{ version: 1, name: 'endpoints', sql: m0001 }],
  activate(ctx) {
    const now = (): number => Date.now()
    const changed = (): void => {
      ctx.events.emit('changed', null)
    }
    const list = (): DockerEndpoint[] =>
      (
        ctx.db
          .prepare('SELECT id, host_id, read_only FROM docker_endpoints ORDER BY added_at')
          .all() as Row[]
      ).map((r) => ({ id: r.id, hostId: r.host_id, readOnly: r.read_only === 1 }))
    ctx.ipc.handle('endpoints', DockerIpc.endpoints, list)
    ctx.ipc.handle('add', DockerIpc.add, (hostId) => {
      ctx.db
        .prepare(
          `INSERT INTO docker_endpoints (id, host_id, read_only, added_at, updated_at)
           VALUES (?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`
        )
        .run(endpointId(hostId), hostId, now(), now())
      changed()
    })
    ctx.ipc.handle('remove', DockerIpc.remove, (hostId) => {
      ctx.db.prepare('DELETE FROM docker_endpoints WHERE id = ?').run(endpointId(hostId))
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
    return {
      // Phiên trên máy này: không có gì cần giải mã — Session Host tự dò socket.
      resolveSession: () => ({})
    }
  }
}
