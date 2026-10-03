import type { MutationResult } from '@shared/hosts'
import {
  invokeModule,
  onModuleEvent,
  openModuleTab,
  openModuleTerminal,
  t
} from '../../registry/renderer-kit'
import type { ContextEntry, ContextList, ContextSettings, ImportResult } from '../shared/ipc'
import type { ContextRef, K8sClusterParams, K8sLogsParams, K8sTerminalParams } from '../shared/ops'

/** IPC `module:k8s:*`. */
export const k8sApi = {
  contexts: () => invokeModule<ContextList>('k8s', 'contexts'),
  setContext: (ref: ContextRef, patch: Partial<ContextSettings>) =>
    invokeModule<undefined>('k8s', 'setContext', ref, patch),
  importKubeconfig: (name: string, yaml: string) =>
    invokeModule<MutationResult>('k8s', 'importKubeconfig', name, yaml),
  removeImported: (id: string) => invokeModule<undefined>('k8s', 'removeImported', id),
  deleteContext: (ref: ContextRef) =>
    invokeModule<{ ok: true; backup: string | null } | { ok: false; message: string }>(
      'k8s',
      'deleteContext',
      ref
    ),
  renameImported: (id: string, name: string) =>
    invokeModule<undefined>('k8s', 'renameImported', id, name),
  /** Hộp thoại chọn file kubeconfig → nhúng chứng chỉ → lưu vào vault. */
  importFiles: () => invokeModule<ImportResult>('k8s', 'importFiles'),
  onChanged: (listener: () => void) =>
    onModuleEvent('k8s', 'changed', () => {
      listener()
    })
}

export function openCluster(c: ContextEntry): string | null {
  const params: K8sClusterParams = {
    ref: c.ref,
    label: c.name,
    ...(c.settings.bastionHostId ? { bastionHostId: c.settings.bastionHostId } : {}),
    ...(c.settings.namespace ? { namespace: c.settings.namespace } : {})
  }
  return openModuleTab('k8s', 'cluster', params)
}

export function openPodLogs(params: K8sLogsParams): string | null {
  return openModuleTab('k8s', 'logs', params)
}

/** Shell vào pod → tab terminal (qua bastion SSH nếu context cần). */
export function openPodShell(params: K8sTerminalParams, bastionHostId?: string): string {
  return openModuleTerminal(
    'k8s',
    t('{name} (shell)', {
      name: `${params.pod}${params.container ? `/${params.container}` : ''}`
    }),
    params,
    bastionHostId
  )
}
