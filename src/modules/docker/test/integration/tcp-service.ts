import { EngineClient } from '../../session-host/engine'
import { ApiBackend } from '../../session-host/api-backend'
import { DockerService } from '../../session-host/service'
import { connectTls, describeTlsError } from '../../session-host/tls'
import type { DockerTcpConfig } from '../../shared/ops'

/**
 * Cùng dây nối với `tcpService` trong session-host/index.ts (không cần HostModuleContext): kết nối
 * TLS → `ping` → Engine API; việc cần `docker` CLI báo "chưa hỗ trợ".
 */
export function tcpServiceForTest(cfg: DockerTcpConfig): { service: DockerService } {
  const unsupported = <T>(): Promise<T> =>
    Promise.reject(new Error('This needs the docker command line, which is not available'))
  const service = new DockerService({
    cli: { exec: unsupported, spawn: unsupported },
    connect: async (signal) => {
      const engine = new EngineClient(() => connectTls(cfg))
      await engine.ping(signal).catch((e: unknown) => {
        throw describeTlsError(e, cfg)
      })
      return new ApiBackend(engine)
    },
    openPty: unsupported,
    reprobeCli: false,
    emit: () => undefined,
    log: () => undefined
  })
  return { service }
}
