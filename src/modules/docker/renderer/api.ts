import {
  invokeModule,
  onModuleEvent,
  openModuleTab,
  openModuleTerminal,
  savedHost
} from '../../registry/renderer-kit'
import type { DockerEndpoint } from '../shared/ipc'
import type { DockerEngineParams, DockerLogsParams } from '../shared/ops'

/** IPC `module:docker:*`. */
export const dockerApi = {
  endpoints: () => invokeModule<DockerEndpoint[]>('docker', 'endpoints'),
  add: (hostId: string | null) => invokeModule<undefined>('docker', 'add', hostId),
  remove: (hostId: string | null) => invokeModule<undefined>('docker', 'remove', hostId),
  setReadOnly: (hostId: string | null, readOnly: boolean) =>
    invokeModule<undefined>('docker', 'setReadOnly', hostId, readOnly),
  onChanged: (listener: () => void) =>
    onModuleEvent('docker', 'changed', () => {
      listener()
    })
}

/** Tên nguồn: "This computer" hoặc nhãn host. */
export function sourceLabel(hostId: string | null | undefined): string {
  if (!hostId) return 'This computer'
  return savedHost(hostId)?.label ?? 'Server'
}

/** Mở tab Docker của một nguồn (và thêm nguồn vào thanh bên nếu chưa có). */
export function openDocker(hostId: string | null): string | null {
  void dockerApi.add(hostId).catch(() => undefined)
  const params: DockerEngineParams = {
    ...(hostId ? { hostId } : {}),
    label: sourceLabel(hostId)
  }
  return openModuleTab('docker', 'engine', params)
}

export function openLogs(
  hostId: string | undefined,
  container: { id: string; name: string }
): string | null {
  const params: DockerLogsParams = {
    ...(hostId ? { hostId } : {}),
    label: sourceLabel(hostId),
    container: container.id,
    name: container.name
  }
  return openModuleTab('docker', 'logs', params)
}

/** Shell vào container → tab terminal (trên máy này hoặc qua SSH tới host). */
export function openShell(
  hostId: string | undefined,
  container: { id: string; name: string }
): string {
  return openModuleTerminal(
    'docker',
    `${container.name} (shell)`,
    { container: container.id },
    hostId
  )
}
