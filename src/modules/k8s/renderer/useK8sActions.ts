import { useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import { showCommands, t, toast } from '../../registry/renderer-kit'
import { resourceCommands } from '../shared/commands'
import type { DiscoveredKind, K8sClusterParams, K8sOp } from '../shared/ops'
import { selectorString, type K8sObject, type ResourceKind } from '../shared/resources'
import { containersOf, type ActionHandlers } from './actions'
import { openPodLogs, openPodShell } from './api'
import type { Dialog } from './ClusterDialogs'
import type { Guard } from './confirm'

type Request = <T>(op: K8sOp) => Promise<T>

/** Thông báo nổi (toast); lỗi "Tiêu đề: chi tiết" tách thành tiêu đề + mô tả. */
export function notify(text: string, tone: 'success' | 'danger' = 'success'): void {
  if (tone === 'success') {
    toast.success(text)
    return
  }
  const at = text.indexOf(': ')
  if (at > 0 && at < 60) toast.error(text.slice(0, at), { description: text.slice(at + 2) })
  else toast.error(text)
}

/** Thao tác có toast "đang chạy" → xong / lỗi (kèm lý do từ API server). */
export function run<T>(
  messages: { loading: string; success: string | ((result: T) => string); error: string },
  fn: () => Promise<T>
): void {
  void toast
    .promise(fn(), {
      ...messages,
      error: messages.error,
      group: messages.loading
    })
    .catch(() => undefined)
}

export const nsOf = (obj: K8sObject): { namespace?: string } =>
  obj.metadata.namespace ? { namespace: obj.metadata.namespace } : {}

/**
 * Thao tác trên đối tượng đang chọn (menu chuột phải, phím tắt, chi tiết). Thao tác thay đổi cluster
 * hỏi trước qua `guard` (production → gõ tên).
 */
export function useK8sActions({
  params,
  refKey,
  kindId,
  kind,
  production,
  request,
  guard,
  setDialog,
  openRef
}: {
  params: K8sClusterParams
  refKey: string
  kindId: string
  kind: DiscoveredKind | ResourceKind | undefined
  production: boolean
  request: Request
  guard: Guard
  setDialog: (d: Dialog) => void
  openRef: (kind: string, ns: string | undefined, name: string) => void
}): ActionHandlers {
  /** Production: hỏi một lần mỗi tab trước khi sửa bằng editor ngoài (mỗi lần lưu là ghi lên cluster). */
  const [externalEditOk] = useState(() => new Set<string>())
  return {
    copyCommand: (obj) => {
      const replicas = (obj.spec?.['replicas'] as number | undefined) ?? undefined
      const lines = resourceCommands({
        ref: params.ref,
        kindId,
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
        containers: containersOf(obj),
        replicas
      })
      showCommands(
        t('{kind} {name} as kubectl', { kind: obj.kind ?? kindId, name: obj.metadata.name }),
        lines.map((l) => ({ label: commandLabel(l.id), command: l.command }))
      )
    },
    logs: (obj, opts) => {
      const base = {
        ref: params.ref,
        ...(params.bastionHostId ? { bastionHostId: params.bastionHostId } : {}),
        namespace: obj.metadata.namespace ?? ''
      }
      if (kindId === 'pods') {
        const first = containersOf(obj)[0]
        openPodLogs({
          ...base,
          pod: obj.metadata.name,
          ...(opts?.allContainers ? { allContainers: true } : first ? { container: first } : {})
        })
        return
      }
      const sel = selectorString(obj.spec?.['selector'])
      if (!sel) {
        notify(t('{name} has no pod selector', { name: obj.metadata.name }), 'danger')
        return
      }
      openPodLogs({
        ...base,
        selector: sel,
        title: `${(kind?.kind ?? kindId).toLowerCase()}/${obj.metadata.name}`
      })
    },
    shell: (obj, container) => {
      const c = container ?? containersOf(obj)[0]
      openPodShell(
        {
          ref: params.ref,
          namespace: obj.metadata.namespace ?? '',
          pod: obj.metadata.name,
          ...(c ? { container: c } : {})
        },
        params.bastionHostId
      )
    },
    yaml: (obj) => {
      request<string>({
        op: 'get',
        kind: kindId,
        ...nsOf(obj),
        name: obj.metadata.name,
        format: 'yaml'
      }).then(
        (text) => {
          setDialog({
            kind: 'yaml',
            mode: 'view',
            title: `${obj.kind ?? ''} ${obj.metadata.name}`,
            text
          })
        },
        (e: unknown) => {
          notify(cleanError(e), 'danger')
        }
      )
    },
    edit: (obj) => {
      request<string>({
        op: 'get',
        kind: kindId,
        ...nsOf(obj),
        name: obj.metadata.name,
        format: 'yaml'
      }).then(
        (text) => {
          setDialog({
            kind: 'yaml',
            mode: 'edit',
            title: t('Edit {kind} {name}', { kind: obj.kind ?? '', name: obj.metadata.name }),
            text,
            source: { kind: kindId, ...nsOf(obj), name: obj.metadata.name }
          })
        },
        (e: unknown) => {
          notify(cleanError(e), 'danger')
        }
      )
    },
    editExternal: (obj) => {
      void (async () => {
        // Production: mỗi lần lưu trong editor là ghi thẳng lên cluster → hỏi một lần cho tab này.
        if (production && !externalEditOk.has(refKey)) {
          const ok = await guard({
            title: t('Edit {name} in your editor?', { name: obj.metadata.name }),
            message: t(
              'Every time you save the file, it is applied to the cluster — there is no extra confirmation per save.'
            ),
            confirmLabel: t('Open editor'),
            name: obj.metadata.name
          })
          if (!ok) return
          externalEditOk.add(refKey)
        }
        run(
          {
            loading: t('Opening {name} in your editor…', { name: obj.metadata.name }),
            success: t('Editing {name} — every save is applied to the cluster', {
              name: obj.metadata.name
            }),
            error: t('Could not edit {name}', { name: obj.metadata.name })
          },
          async () => {
            const localPath = await window.shellhouse.prepareRemoteEdit(
              `${obj.metadata.name}.${kindId}.yaml`
            )
            await request({
              op: 'edit',
              kind: kindId,
              ...nsOf(obj),
              name: obj.metadata.name,
              localPath
            })
            await window.shellhouse.openInEditor(localPath)
          }
        )
      })()
    },
    forward: (obj) => {
      const ports =
        kindId === 'pods'
          ? (
              (obj.spec?.['containers'] as { ports?: { containerPort: number }[] }[] | undefined) ??
              []
            ).flatMap((c) => (c.ports ?? []).map((p) => p.containerPort))
          : ((obj.spec?.['ports'] as { port: number }[] | undefined) ?? []).map((p) => p.port)
      setDialog({ kind: 'forward', obj, ports })
    },
    debug: (obj) => {
      setDialog({ kind: 'debug', target: kindId === 'nodes' ? 'node' : 'pod', obj })
    },
    scale: (obj) => {
      setDialog({ kind: 'scale', obj })
    },
    restart: (obj) => {
      void (async () => {
        const ok = await guard({
          title: t('Restart {name}?', { name: obj.metadata.name }),
          message: t('Starts a rolling restart: pods are replaced one by one with new ones.'),
          confirmLabel: t('Restart'),
          name: obj.metadata.name
        })
        if (!ok) return
        run(
          {
            loading: t('Restarting {name}…', { name: obj.metadata.name }),
            success: t('Rolling restart started for {name}', { name: obj.metadata.name }),
            error: t('Could not restart {name}', { name: obj.metadata.name })
          },
          () =>
            request({
              op: 'rolloutRestart',
              kind: kindId as 'deployments.apps',
              namespace: obj.metadata.namespace ?? '',
              name: obj.metadata.name
            })
        )
      })()
    },
    pause: (obj, paused) => {
      const name = obj.metadata.name
      run(
        paused
          ? {
              loading: t('Pausing the rollout of {name}…', { name }),
              success: t('Rollout of {name} paused', { name }),
              error: t('Could not pause the rollout of {name}', { name })
            }
          : {
              loading: t('Resuming the rollout of {name}…', { name }),
              success: t('Rollout of {name} resumed', { name }),
              error: t('Could not resume the rollout of {name}', { name })
            },
        () =>
          request({
            op: 'rolloutPause',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            paused
          })
      )
    },
    history: (obj) => {
      setDialog({ kind: 'history', obj })
    },
    scan: (obj) => {
      setDialog({ kind: 'scan', obj })
    },
    remove: (obj, force) => {
      setDialog({ kind: 'delete', obj, force })
    },
    cordon: (obj, unschedulable) => {
      void (async () => {
        const name = obj.metadata.name
        const ok = await guard({
          title: unschedulable ? t('Cordon {name}?', { name }) : t('Uncordon {name}?', { name }),
          message: unschedulable
            ? t('No new pods are scheduled on this node. Pods already on it keep running.')
            : t('New pods can be scheduled on this node again.'),
          confirmLabel: unschedulable ? t('Cordon') : t('Uncordon'),
          name: obj.metadata.name,
          // Uncordon chỉ mở lại lịch — hỏi khi production.
          onlyProduction: !unschedulable
        })
        if (!ok) return
        run(
          unschedulable
            ? {
                loading: t('Cordoning {name}…', { name }),
                success: t('Cordoned {name}', { name }),
                error: t('Could not cordon {name}', { name })
              }
            : {
                loading: t('Uncordoning {name}…', { name }),
                success: t('Uncordoned {name}', { name }),
                error: t('Could not uncordon {name}', { name })
              },
          () => request({ op: 'cordon', node: obj.metadata.name, unschedulable })
        )
      })()
    },
    drain: (obj) => {
      setDialog({ kind: 'drain', obj })
    },
    trigger: (obj) => {
      void toast
        .promise(
          request<string>({
            op: 'cronTrigger',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name
          }),
          {
            loading: t('Starting a job from {name}…', { name: obj.metadata.name }),
            success: (job) => t('Started job {job}', { job }),
            error: t('Could not start a job from {name}', { name: obj.metadata.name }),
            action: (job) => ({
              label: t('Show job'),
              run: () => {
                openRef('jobs.batch', obj.metadata.namespace, job)
              }
            })
          }
        )
        .catch(() => undefined)
    },
    argoSync: (obj, prune) => {
      void (async () => {
        const name = obj.metadata.name
        const ok = await guard({
          title: prune ? t('Sync {name} and prune?', { name }) : t('Sync {name}?', { name }),
          message: prune
            ? t('Resources that are no longer in Git are deleted from the cluster.')
            : t('Applies what is in Git to the cluster.'),
          confirmLabel: prune ? t('Sync and prune') : t('Sync'),
          danger: prune,
          name: obj.metadata.name,
          onlyProduction: !prune
        })
        if (!ok) return
        run(
          {
            loading: t('Syncing {name}…', { name }),
            success: prune
              ? t('Sync started for {name} (with prune)', { name })
              : t('Sync started for {name}', { name }),
            error: t('Could not sync {name}', { name })
          },
          () =>
            request({
              op: 'argoSync',
              namespace: obj.metadata.namespace ?? '',
              name: obj.metadata.name,
              prune
            })
        )
      })()
    },
    argoRefresh: (obj, hard) => {
      run(
        {
          loading: t('Refreshing {name}…', { name: obj.metadata.name }),
          success: hard
            ? t('Hard refresh requested for {name}', { name: obj.metadata.name })
            : t('Refresh requested for {name}', { name: obj.metadata.name }),
          error: t('Could not refresh {name}', { name: obj.metadata.name })
        },
        () =>
          request({
            op: 'argoRefresh',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            hard
          })
      )
    },
    suspend: (obj, suspend) => {
      const name = obj.metadata.name
      run(
        suspend
          ? {
              loading: t('Suspending {name}…', { name }),
              success: t('Schedule of {name} suspended', { name }),
              error: t('Could not suspend {name}', { name })
            }
          : {
              loading: t('Resuming {name}…', { name }),
              success: t('Schedule of {name} resumed', { name }),
              error: t('Could not resume {name}', { name })
            },
        () =>
          request({
            op: 'cronSuspend',
            namespace: obj.metadata.namespace ?? '',
            name: obj.metadata.name,
            suspend
          })
      )
    }
  }
}

/** Nhãn của từng lệnh kubectl (dịch lúc vẽ). */
export function commandLabel(id: string): string {
  switch (id) {
    case 'get':
      return t('Show as YAML')
    case 'describe':
      return t('Describe')
    case 'logs':
      return t('Follow logs')
    case 'logs-previous':
      return t('Logs of the previous container')
    case 'exec':
      return t('Open a shell')
    case 'rollout-status':
      return t('Rollout status')
    case 'restart':
      return t('Restart')
    case 'scale':
      return t('Scale')
    case 'cordon':
      return t('Cordon')
    case 'drain':
      return t('Drain')
    case 'delete':
      return t('Delete')
    default:
      return id
  }
}
