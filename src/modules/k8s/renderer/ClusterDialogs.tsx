import type { FormKind } from '../shared/forms'
import type { ContextRef, DiscoveredKind, K8sOp, PortForwardInfo } from '../shared/ops'
import type { K8sObject, ResourceKind } from '../shared/resources'
import { t, tn, toast } from '../../registry/renderer-kit'
import { CreateResourceDialog } from './CreateResourceDialog'
import {
  DeleteDialog,
  DrainDialog,
  ForwardDialog,
  HistoryDialog,
  ScaleDialog,
  YamlEditor
} from './dialogs'
import type { YamlSource } from './YamlEditor'
import { BulkDialog, type BulkKind } from './Bulk'
import { DebugDialog } from './DebugDialog'
import { notify, nsOf, run } from './useK8sActions'
import { objectKey } from './useResourceList'

type Request = <T>(op: K8sOp) => Promise<T>

export type Dialog =
  | {
      kind: 'yaml'
      mode: 'view' | 'edit' | 'create'
      title: string
      text: string
      /** Sửa: đối tượng gốc (Tải lại / Ghi đè khi xung đột). */
      source?: YamlSource
    }
  | { kind: 'create'; initial: FormKind }
  | { kind: 'delete'; obj: K8sObject; force: boolean }
  | { kind: 'forward'; obj: K8sObject; ports: number[] }
  | { kind: 'scale'; obj: K8sObject }
  | { kind: 'drain'; obj: K8sObject }
  | { kind: 'history'; obj: K8sObject }
  | { kind: 'debug'; target: 'pod' | 'node'; obj: K8sObject }
  | { kind: 'bulk'; action: BulkKind; objects: K8sObject[] }
  | null

/** Hộp thoại của tab cluster (YAML, tạo, xoá, forward, scale, drain, lịch sử rollout). */
export function ClusterDialogs({
  dialog,
  setDialog,
  request,
  kindId,
  kind,
  scopeNs,
  allNamespaces,
  clusterNamespace,
  production,
  readOnly,
  detailKey,
  setDetailKey,
  openRef,
  onForwardStarted,
  contextRef,
  contextName,
  bastionHostId,
  onBulkDeleted
}: {
  dialog: Dialog
  setDialog: (d: Dialog) => void
  request: Request
  kindId: string
  kind: DiscoveredKind | ResourceKind | undefined
  scopeNs: readonly string[]
  allNamespaces: readonly string[]
  clusterNamespace: string | undefined
  production: boolean
  readOnly: boolean
  detailKey: string | null
  setDetailKey: (key: string | null) => void
  openRef: (kind: string, ns: string | undefined, name: string) => void
  /** Vừa bắt đầu port-forward → mở khung danh sách forward. */
  onForwardStarted: () => void
  contextRef: ContextRef
  /** Tên context (production: thao tác hàng loạt phải gõ lại). */
  contextName: string
  bastionHostId: string | undefined
  /** Xoá hàng loạt xong → bỏ chọn các dòng đã xoá. */
  onBulkDeleted: (keys: string[]) => void
}): React.JSX.Element | null {
  if (!dialog) return null
  return (
    <>
      {dialog.kind === 'yaml' && (
        <YamlEditor
          title={dialog.title}
          initial={dialog.text}
          mode={dialog.mode}
          namespace={scopeNs.length === 1 ? scopeNs[0] : undefined}
          request={request}
          source={dialog.source}
          onClose={() => {
            setDialog(null)
          }}
          onDone={(text) => {
            notify(text)
          }}
        />
      )}
      {dialog.kind === 'debug' && (
        <DebugDialog
          target={dialog.target}
          obj={dialog.obj}
          request={request}
          contextRef={contextRef}
          bastionHostId={bastionHostId}
          namespaces={allNamespaces}
          defaultNamespace={
            scopeNs.length === 1 ? (scopeNs[0] ?? 'default') : (clusterNamespace ?? 'default')
          }
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog.kind === 'bulk' && (
        <BulkDialog
          kind={dialog.action}
          kindId={kindId}
          objects={dialog.objects}
          contextName={contextName}
          request={request}
          onClose={() => {
            setDialog(null)
          }}
          onDeleted={onBulkDeleted}
        />
      )}
      {dialog.kind === 'create' && (
        <CreateResourceDialog
          request={request}
          namespaces={allNamespaces}
          defaultNamespace={scopeNs[0] ?? clusterNamespace ?? 'default'}
          initialKind={dialog.initial}
          onClose={() => {
            setDialog(null)
          }}
          onEditYaml={(text) => {
            setDialog({ kind: 'yaml', mode: 'create', title: t('Create from YAML'), text })
          }}
          onCreated={(createdKind, ns, name, summary) => {
            toast.success(t('Created {name}', { name }), {
              description: summary,
              action: {
                label: t('Open'),
                run: () => {
                  openRef(createdKind, ns, name)
                }
              }
            })
            if (createdKind !== 'namespaces') openRef(createdKind, ns, name)
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <DeleteDialog
          obj={dialog.obj}
          force={dialog.force}
          production={production}
          onClose={() => {
            setDialog(null)
          }}
          onDelete={() => {
            const { obj, force } = dialog
            setDialog(null)
            if (detailKey === objectKey(obj)) setDetailKey(null)
            const what =
              `${(obj.kind ?? kind?.kind ?? '').toLowerCase()} ${obj.metadata.name}`.trim()
            run(
              {
                loading: t('Deleting {what}…', { what }),
                success: t('Deleted {what}', { what }),
                error: t('Could not delete {what}', { what })
              },
              () =>
                request({
                  op: 'delete',
                  kind: kindId,
                  ...nsOf(obj),
                  name: obj.metadata.name,
                  ...(force ? { force: true } : {})
                })
            )
          }}
        />
      )}
      {dialog.kind === 'forward' && (
        <ForwardDialog
          obj={dialog.obj}
          ports={dialog.ports}
          onClose={() => {
            setDialog(null)
          }}
          onForward={(local, remote) => {
            const target = dialog.obj
            const ports = {
              local: String(local),
              name: target.metadata.name,
              remote: String(remote)
            }
            setDialog(null)
            onForwardStarted()
            run(
              {
                loading: t('Forwarding to {name}:{remote}…', ports),
                // Cổng "tự chọn" (0) → hiện cổng thật mà server đã cấp.
                success: (started) =>
                  t('Forwarding localhost:{local} → {name}:{remote}', {
                    ...ports,
                    local: String(started[0]?.localPort || local)
                  }),
                error: t('Could not forward to {name}', { name: target.metadata.name })
              },
              () =>
                request<PortForwardInfo[]>({
                  op: 'portForward',
                  namespace: target.metadata.namespace ?? '',
                  target: `${kindId === 'pods' ? 'pod' : 'service'}/${target.metadata.name}`,
                  ports: [[local, remote]]
                })
            )
          }}
        />
      )}
      {dialog.kind === 'scale' && (
        <ScaleDialog
          obj={dialog.obj}
          production={production}
          onClose={() => {
            setDialog(null)
          }}
          onScale={(replicas) => {
            const target = dialog.obj
            const name = target.metadata.name
            setDialog(null)
            run(
              {
                loading: t('Scaling {name} to {replicas}…', { name, replicas: String(replicas) }),
                success: tn(
                  replicas,
                  'Scaled {name} to {n} replica',
                  'Scaled {name} to {n} replicas',
                  { name }
                ),
                error: t('Could not scale {name}', { name })
              },
              () =>
                request({
                  op: 'scale',
                  kind: kindId as 'deployments.apps',
                  namespace: target.metadata.namespace ?? '',
                  name,
                  replicas
                })
            )
          }}
        />
      )}
      {dialog.kind === 'drain' && (
        <DrainDialog
          node={dialog.obj}
          production={production}
          request={request}
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog.kind === 'history' && (
        <HistoryDialog
          obj={dialog.obj}
          request={request}
          readOnly={readOnly}
          onClose={() => {
            setDialog(null)
          }}
          onDone={(text) => {
            notify(text)
          }}
        />
      )}
    </>
  )
}
