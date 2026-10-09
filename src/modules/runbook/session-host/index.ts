import type { HostModule } from '../../registry/host-types'
import { runbookManifest } from '../manifest'
import { RunbookSessionConfig } from '../shared/runbook'
import { RunbookService } from './service'

/** Phần Session Host của Runbook: `local` (gọi HTTP từ máy này) và gắn vào kết nối SSH (chạy lệnh). */
export const runbookHost: HostModule = {
  manifest: runbookManifest,
  // Proxy / bí mật của bước HTTP: main phân giải, renderer không thấy.
  createSession: (_kind, config) =>
    new RunbookService({ config: RunbookSessionConfig.parse(config ?? {}) }),
  attachToSsh: (ctx) => new RunbookService({ ssh: ctx.ssh })
}
