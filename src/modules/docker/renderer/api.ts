import {
  invokeModule,
  onModuleEvent,
  openModuleTab,
  openModuleTerminal,
  savedHost,
  t
} from '../../registry/renderer-kit'
import {
  tcpIdOf,
  wslDistroOf,
  type DockerEndpoint,
  type DockerRegistry,
  type DockerTcpEndpoint,
  type RegistryInput,
  type TcpEndpointInput,
  type WslDistroInfo
} from '../shared/ipc'
import type { DockerEngineParams, DockerLogsParams } from '../shared/ops'

/** IPC `module:docker:*`. */
export const dockerApi = {
  endpoints: () => invokeModule<DockerEndpoint[]>('docker', 'endpoints'),
  add: (hostId: string | null) => invokeModule<undefined>('docker', 'add', hostId),
  remove: (hostId: string | null) => invokeModule<undefined>('docker', 'remove', hostId),
  hide: (hostId: string) => invokeModule<undefined>('docker', 'hide', hostId),
  setReadOnly: (hostId: string | null, readOnly: boolean) =>
    invokeModule<undefined>('docker', 'setReadOnly', hostId, readOnly),
  wslDistros: () => invokeModule<WslDistroInfo[]>('docker', 'wslDistros'),
  registries: () => invokeModule<DockerRegistry[]>('docker', 'registries'),
  saveRegistry: (input: RegistryInput) =>
    invokeModule<{ ok: true; id: string } | { ok: false; message: string }>(
      'docker',
      'saveRegistry',
      input
    ),
  deleteRegistry: (id: string) => invokeModule<undefined>('docker', 'deleteRegistry', id),
  tcpEndpoints: () => invokeModule<DockerTcpEndpoint[]>('docker', 'tcpEndpoints'),
  saveTcp: (input: TcpEndpointInput) =>
    invokeModule<{ ok: true; id: string } | { ok: false; message: string }>(
      'docker',
      'saveTcp',
      input
    ),
  deleteTcp: (id: string) => invokeModule<undefined>('docker', 'deleteTcp', id),
  pickPem: (what: 'ca' | 'cert' | 'key') =>
    invokeModule<{ name: string; content: string } | null>('docker', 'pickPem', what),
  onChanged: (listener: () => void) =>
    onModuleEvent('docker', 'changed', () => {
      listener()
    })
}

/** Tên các engine TCP + TLS (store điền khi tải danh sách) — để `sourceLabel` trả lời ngay. */
const tcpNames = new Map<string, string>()
export function rememberTcpNames(list: readonly DockerTcpEndpoint[]): void {
  tcpNames.clear()
  for (const e of list) tcpNames.set(e.id, e.name)
}

/** Tên nguồn: "This computer", "Ubuntu (WSL)", tên engine TCP hoặc nhãn host. */
export function sourceLabel(hostId: string | null | undefined): string {
  if (!hostId) return t('This computer')
  const tcp = tcpIdOf(hostId)
  if (tcp) return tcpNames.get(tcp) ?? t('Server')
  const wsl = wslDistroOf(hostId)
  if (wsl) return `${wsl} (WSL)`
  return savedHost(hostId)?.label ?? t('Server')
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

/** Log cả Compose project (mọi container, tiền tố tên). */
export function openProjectLogs(
  hostId: string | undefined,
  project: string,
  containers: { id: string; name: string }[]
): string | null {
  const params: DockerLogsParams = {
    ...(hostId ? { hostId } : {}),
    label: sourceLabel(hostId),
    name: project,
    containers: containers.slice(0, 50).map((c) => ({ id: c.id, name: c.name }))
  }
  return openModuleTab('docker', 'logs', params)
}

/** Shell vào container → tab terminal (trên máy này hoặc qua SSH tới host). */
export function openShell(
  hostId: string | undefined,
  container: { id: string; name: string },
  options: { command?: string[] | undefined; user?: string | undefined } = {}
): string {
  const wsl = wslDistroOf(hostId)
  return openModuleTerminal(
    'docker',
    `${container.name} (${options.command?.join(' ') ?? t('shell')})`,
    {
      container: container.id,
      ...(options.command ? { command: options.command } : {}),
      ...(options.user ? { user: options.user } : {}),
      ...(wsl ? { wsl } : {}),
      // Host SSH: Session Host hỏi main cờ chỉ đọc (chặn shell ở chế độ chỉ đọc).
      ...(hostId && !wsl ? { hostId } : {})
    },
    // WSL: phiên module trên máy này (không phải host SSH).
    wsl ? undefined : hostId
  )
}

/** Địa chỉ để mở cổng đã publish: localhost hoặc tên server của host SSH. */
export function publishHost(hostId: string | undefined): string {
  // Máy này / WSL 2 (cổng mở trong distro dùng được qua localhost).
  if (!hostId || wslDistroOf(hostId)) return 'localhost'
  return savedHost(hostId)?.address.split('@').pop() ?? 'localhost'
}
