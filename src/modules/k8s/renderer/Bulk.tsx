import { useRef, useState } from 'react'
import { Ban, Check, Copy, FileCode, RotateCw, Scale, Trash2, Unlock, X } from 'lucide-react'
import { Button, cx, Input, Modal, Notice } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatNumber, t, tn, toast } from '../../registry/renderer-kit'
import type { K8sOp } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import { mapLimit } from '../shared/watch'
import { useClusterGuard } from './confirm'

/**
 * Thao tác hàng loạt trên các dòng đang chọn (kiểu Lens / k9s): xoá, rollout restart, scale,
 * cordon / uncordon, sao chép tên / YAML. Hỏi trước (tóm tắt đối tượng; context production phải
 * gõ tên context), chạy song song có giới hạn, hiện tiến độ và kết quả từng đối tượng.
 */

type Request = <T>(op: K8sOp) => Promise<T>

export type BulkKind = 'delete' | 'restart' | 'scale' | 'cordon' | 'uncordon'

const WORKLOADS = ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps']
const SCALABLE = ['deployments.apps', 'statefulsets.apps', 'replicasets.apps']
/** Không xoá hàng loạt: node / namespace (quá nguy hiểm), event. */
const NO_BULK_DELETE = new Set(['nodes', 'namespaces', 'events'])
/** Số thao tác chạy cùng lúc. */
const PARALLEL = 4

/** Thao tác hàng loạt áp dụng được cho loại này (chỉ đọc → không có gì thay đổi cluster). */
export function bulkKinds(kindId: string, readOnly: boolean): BulkKind[] {
  if (readOnly) return []
  const out: BulkKind[] = []
  if (WORKLOADS.includes(kindId)) out.push('restart')
  if (SCALABLE.includes(kindId)) out.push('scale')
  if (kindId === 'nodes') out.push('cordon', 'uncordon')
  if (!NO_BULK_DELETE.has(kindId)) out.push('delete')
  return out
}

/** Phím tắt khi chọn nhiều dòng (giống phím của một dòng). */
export const BULK_KEYS: Record<string, BulkKind> = {
  'ctrl+d': 'delete',
  r: 'restart',
  S: 'scale',
  c: 'cordon'
}

const ns = (o: K8sObject): { namespace?: string } =>
  o.metadata.namespace ? { namespace: o.metadata.namespace } : {}
const label = (o: K8sObject): string =>
  o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name

function bulkTitle(kind: BulkKind, n: number): string {
  switch (kind) {
    case 'delete':
      return tn(n, 'Delete {n} object?', 'Delete {n} objects?')
    case 'restart':
      return tn(n, 'Restart {n} workload?', 'Restart {n} workloads?')
    case 'scale':
      return tn(n, 'Scale {n} workload', 'Scale {n} workloads')
    case 'cordon':
      return tn(n, 'Cordon {n} node?', 'Cordon {n} nodes?')
    case 'uncordon':
      return tn(n, 'Uncordon {n} node?', 'Uncordon {n} nodes?')
  }
}

function bulkLabel(kind: BulkKind): string {
  switch (kind) {
    case 'delete':
      return t('Delete')
    case 'restart':
      return t('Restart')
    case 'scale':
      return t('Scale')
    case 'cordon':
      return t('Cordon')
    case 'uncordon':
      return t('Uncordon')
  }
}

function bulkMessage(kind: BulkKind): string {
  switch (kind) {
    case 'delete':
      return t(
        'The objects are deleted from the cluster. Pods owned by a controller are recreated.'
      )
    case 'restart':
      return t('Starts a rolling restart of each workload: pods are replaced one by one.')
    case 'scale':
      return t('Sets the same number of replicas on every selected workload.')
    case 'cordon':
      return t('No new pods are scheduled on these nodes. Pods already on them keep running.')
    case 'uncordon':
      return t('New pods can be scheduled on these nodes again.')
  }
}

const ICONS: Record<BulkKind, React.ReactNode> = {
  delete: <Trash2 size={13} />,
  restart: <RotateCw size={13} />,
  scale: <Scale size={13} />,
  cordon: <Ban size={13} />,
  uncordon: <Unlock size={13} />
}

/** Thanh thao tác khi chọn nhiều dòng (thay chỗ số đếm trên breadcrumb). */
export function BulkBar({
  count,
  kinds,
  onRun,
  onCopyNames,
  onCopyYaml,
  onClear
}: {
  count: number
  kinds: BulkKind[]
  onRun: (kind: BulkKind) => void
  onCopyNames: () => void
  onCopyYaml: () => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-accent-soft/40 px-3 text-xs"
      data-testid="k8s-bulk-bar"
    >
      <span className="mr-2 font-medium text-fg tabular-nums" data-testid="k8s-bulk-count">
        {tn(count, '{n} selected', '{n} selected')}
      </span>
      {kinds.map((k) => (
        <Button
          key={k}
          size="sm"
          variant={k === 'delete' ? 'danger' : 'ghost'}
          icon={ICONS[k]}
          data-testid={`k8s-bulk-${k}`}
          onClick={() => {
            onRun(k)
          }}
        >
          {bulkLabel(k)}
          {k === 'scale' || k === 'delete' ? '…' : ''}
        </Button>
      ))}
      <span className="mx-1 h-4 w-px bg-line" />
      <Button size="sm" variant="ghost" icon={<Copy size={13} />} onClick={onCopyNames}>
        {t('Copy names')}
      </Button>
      <Button size="sm" variant="ghost" icon={<FileCode size={13} />} onClick={onCopyYaml}>
        {t('Copy YAML')}
      </Button>
      <button
        type="button"
        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg"
        title={t('Clear the selection (Esc)')}
        data-testid="k8s-bulk-clear"
        onClick={onClear}
      >
        <X size={12} />
        {t('Clear')}
      </button>
    </div>
  )
}

interface ItemResult {
  key: string
  ok: boolean
  error?: string
}

/** Hộp xác nhận + tiến độ + kết quả của một thao tác hàng loạt. */
export function BulkDialog({
  kind,
  kindId,
  objects,
  contextName,
  request,
  onClose,
  onDeleted
}: {
  kind: BulkKind
  kindId: string
  objects: K8sObject[]
  /** Tên context (production → phải gõ lại). */
  contextName: string
  request: Request
  onClose: () => void
  onDeleted?: (keys: string[]) => void
}): React.JSX.Element {
  const { production } = useClusterGuard()
  const [typed, setTyped] = useState('')
  const [replicas, setReplicas] = useState('1')
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm')
  const [results, setResults] = useState<ItemResult[]>([])
  const cancelled = useRef(false)
  const n = objects.length
  const replicaCount = Number(replicas)
  const replicasOk = kind !== 'scale' || (/^\d+$/.test(replicas) && replicaCount <= 10_000)
  const ok = replicasOk && (!production || typed === contextName)
  const failed = results.filter((r) => !r.ok)
  const shown = objects.slice(0, 12)

  const opFor = (o: K8sObject): K8sOp => {
    switch (kind) {
      case 'delete':
        return { op: 'delete', kind: kindId, ...ns(o), name: o.metadata.name }
      case 'restart':
        return {
          op: 'rolloutRestart',
          kind: kindId as 'deployments.apps',
          namespace: o.metadata.namespace ?? '',
          name: o.metadata.name
        }
      case 'scale':
        return {
          op: 'scale',
          kind: kindId as 'deployments.apps',
          namespace: o.metadata.namespace ?? '',
          name: o.metadata.name,
          replicas: replicaCount
        }
      case 'cordon':
      case 'uncordon':
        return { op: 'cordon', node: o.metadata.name, unschedulable: kind === 'cordon' }
    }
  }

  const run = (): void => {
    if (!ok || phase !== 'confirm') return
    setPhase('running')
    cancelled.current = false
    void mapLimit(objects, PARALLEL, async (o): Promise<ItemResult> => {
      if (cancelled.current) return { key: label(o), ok: false, error: t('Skipped') }
      let r: ItemResult
      try {
        await request(opFor(o))
        r = { key: label(o), ok: true }
      } catch (e) {
        r = { key: label(o), ok: false, error: cleanError(e) }
      }
      setResults((prev) => [...prev, r])
      return r
    }).then((all) => {
      const bad = all.filter((r) => !r.ok)
      if (kind === 'delete') onDeleted?.(all.filter((r) => r.ok).map((r) => r.key))
      if (bad.length === 0) {
        toast.success(
          tn(all.length, '{action}: {n} object done', '{action}: {n} objects done', {
            action: bulkLabel(kind)
          })
        )
        onClose()
      } else setPhase('done')
    })
  }

  const progress = results.length / Math.max(1, n)
  return (
    <Modal
      title={bulkTitle(kind, n)}
      description={bulkMessage(kind)}
      onClose={() => {
        // Đang chạy: dừng các việc chưa bắt đầu (việc đang gửi vẫn xong).
        cancelled.current = true
        onClose()
      }}
      testId="k8s-bulk-dialog"
      footer={
        phase === 'confirm' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              variant={kind === 'delete' || kind === 'cordon' ? 'danger' : 'primary'}
              disabled={!ok}
              data-testid="k8s-bulk-ok"
              onClick={run}
            >
              {kind === 'scale'
                ? t('Scale to {n}', { n: replicasOk ? formatNumber(replicaCount) : '?' })
                : tn(n, '{action} {n} object', '{action} {n} objects', {
                    action: bulkLabel(kind)
                  })}
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={phase === 'running'} onClick={onClose}>
            {t('Close')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        {phase === 'confirm' && (
          <>
            <div
              className="max-h-48 overflow-auto rounded-md border border-line bg-subtle px-2 py-1.5 font-mono text-[11px] text-muted"
              data-testid="k8s-bulk-targets"
            >
              {shown.map((o) => (
                <div key={label(o)} className="truncate">
                  {label(o)}
                </div>
              ))}
              {n > shown.length && (
                <div className="font-sans text-faint">
                  {tn(n - shown.length, 'and {n} more', 'and {n} more')}
                </div>
              )}
            </div>
            {kind === 'scale' && (
              <label className="flex items-center gap-2 text-muted">
                {t('Replicas')}
                <Input
                  className="h-7 w-24 text-xs"
                  inputMode="numeric"
                  autoFocus
                  data-testid="k8s-bulk-replicas"
                  value={replicas}
                  onChange={(e) => {
                    setReplicas(e.target.value.trim())
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') run()
                  }}
                />
              </label>
            )}
            {kind === 'scale' && replicasOk && replicaCount === 0 && (
              <Notice tone="warning">
                {t('Scaling to 0 stops every pod of these workloads.')}
              </Notice>
            )}
            {production && (
              <>
                <Notice tone="warning">
                  {t('This is a production context. Type {name} to confirm.', {
                    name: contextName
                  })}
                </Notice>
                <Input
                  mono
                  autoFocus={kind !== 'scale'}
                  data-testid="k8s-confirm-typed"
                  placeholder={contextName}
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') run()
                  }}
                />
              </>
            )}
          </>
        )}
        {phase !== 'confirm' && (
          <>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                <div
                  className={cx(
                    'h-full rounded-full transition-[width]',
                    failed.length ? 'bg-warning' : 'bg-accent'
                  )}
                  style={{ width: `${String(Math.round(progress * 100))}%` }}
                />
              </div>
              <span className="text-faint tabular-nums" data-testid="k8s-bulk-progress">
                {formatNumber(results.length)}/{formatNumber(n)}
              </span>
            </div>
            {phase === 'done' && (
              <Notice tone="warning">
                {t('{ok} succeeded, {failed} failed.', {
                  ok: formatNumber(results.length - failed.length),
                  failed: formatNumber(failed.length)
                })}
              </Notice>
            )}
            <div className="max-h-56 overflow-auto" data-testid="k8s-bulk-results">
              {results.map((r) => (
                <div key={r.key} className="flex items-start gap-1.5 py-0.5">
                  {r.ok ? (
                    <Check size={12} className="mt-0.5 shrink-0 text-success" />
                  ) : (
                    <X size={12} className="mt-0.5 shrink-0 text-danger" />
                  )}
                  <span className="shrink-0 font-mono text-[11px] text-fg">{r.key}</span>
                  {r.error && <span className="min-w-0 text-danger">{r.error}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Sao chép YAML của nhiều đối tượng (ngăn bởi ---). */
export async function copyYaml(
  request: Request,
  kindId: string,
  objects: readonly K8sObject[]
): Promise<void> {
  const texts = await mapLimit(objects, PARALLEL, (o) =>
    request<string>({ op: 'get', kind: kindId, ...ns(o), name: o.metadata.name, format: 'yaml' })
  )
  await window.shellhouse.writeClipboard(texts.map((x) => x.trimEnd()).join('\n---\n') + '\n')
  toast.success(
    tn(objects.length, 'Copied the YAML of {n} object', 'Copied the YAML of {n} objects')
  )
}
