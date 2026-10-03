import { useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button, Checkbox, Input, Modal, Notice, Select } from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import { t, tn, toast } from '../../registry/renderer-kit'
import type { DrainResult, K8sOp, RolloutRevision } from '../shared/ops'
import { age, type K8sObject } from '../shared/resources'
import { useClusterGuard } from './confirm'

type Request = <T>(op: K8sOp) => Promise<T>

export function DeleteDialog({
  obj,
  force,
  production,
  onClose,
  onDelete
}: {
  obj: K8sObject
  force: boolean
  production: boolean
  onClose: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const ok = !production || typed === obj.metadata.name
  return (
    <Modal
      title={
        force
          ? t('Kill {kind} {name}?', { kind: obj.kind ?? '', name: obj.metadata.name })
          : t('Delete {kind} {name}?', { kind: obj.kind ?? '', name: obj.metadata.name })
      }
      onClose={onClose}
      testId="k8s-delete-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!ok}
            data-testid="k8s-delete-confirm"
            onClick={onDelete}
          >
            {force ? t('Kill') : t('Delete')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px]">
        <p className="text-muted">
          {obj.metadata.namespace
            ? `${t('Namespace {namespace}.', { namespace: obj.metadata.namespace })} `
            : ''}
          {force
            ? t('The pod is removed immediately, without waiting for it to shut down.')
            : t('This cannot be undone.')}
        </p>
        {production && (
          <>
            <Notice tone="warning">
              {t('This is a production context. Type the name to confirm.')}
            </Notice>
            <Input
              autoFocus
              mono
              data-testid="k8s-delete-typed"
              placeholder={obj.metadata.name}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

export function ForwardDialog({
  obj,
  ports,
  onClose,
  onForward
}: {
  obj: K8sObject
  ports: number[]
  onClose: () => void
  onForward: (local: number, remote: number) => void
}): React.JSX.Element {
  const [remote, setRemote] = useState(String(ports[0] ?? ''))
  const [local, setLocal] = useState('')
  const r = Number(remote)
  const l = local.trim() === '' ? 0 : Number(local)
  const valid =
    Number.isInteger(r) && r > 0 && r < 65536 && Number.isInteger(l) && l >= 0 && l < 65536
  return (
    <Modal
      title={t('Forward a port to {name}', { name: obj.metadata.name })}
      onClose={onClose}
      testId="k8s-forward-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="k8s-forward-start"
            onClick={() => {
              onForward(l, r)
            }}
          >
            {t('Start')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-[13px]">
        <label className="flex flex-col gap-1">
          <span className="text-muted">{t('Port in the cluster')}</span>
          {ports.length > 0 ? (
            <Select
              data-testid="k8s-forward-remote"
              value={remote}
              onChange={(e) => {
                setRemote(e.target.value)
              }}
            >
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              mono
              data-testid="k8s-forward-remote"
              value={remote}
              onChange={(e) => {
                setRemote(e.target.value)
              }}
            />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">{t('Port on this computer')}</span>
          <Input
            mono
            placeholder={t('auto')}
            data-testid="k8s-forward-local"
            value={local}
            onChange={(e) => {
              setLocal(e.target.value)
            }}
          />
        </label>
      </div>
    </Modal>
  )
}

export function ScaleDialog({
  obj,
  production,
  onClose,
  onScale
}: {
  obj: K8sObject
  production: boolean
  onClose: () => void
  onScale: (replicas: number) => void
}): React.JSX.Element {
  const current = typeof obj.spec?.['replicas'] === 'number' ? obj.spec['replicas'] : 0
  const [value, setValue] = useState(String(current))
  const [typed, setTyped] = useState('')
  const n = Number(value)
  const valid =
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 10_000 &&
    n !== current &&
    (!production || typed === obj.metadata.name)
  return (
    <Modal
      title={t('Scale {name}', { name: obj.metadata.name })}
      description={tn(current, 'Currently {n} replica', 'Currently {n} replicas')}
      onClose={onClose}
      testId="k8s-scale-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="k8s-scale-apply"
            onClick={() => {
              onScale(n)
            }}
          >
            {t('Scale')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            aria-label={t('Fewer replicas')}
            disabled={n <= 0}
            onClick={() => {
              setValue(String(Math.max(0, n - 1)))
            }}
          >
            <Minus size={14} />
          </Button>
          <Input
            autoFocus
            mono
            className="w-24 text-center text-lg"
            data-testid="k8s-scale-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value.replace(/\D/g, ''))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) onScale(n)
            }}
          />
          <Button
            variant="secondary"
            aria-label={t('More replicas')}
            data-testid="k8s-scale-more"
            onClick={() => {
              setValue(String(n + 1))
            }}
          >
            <Plus size={14} />
          </Button>
        </div>
        {n === 0 && current > 0 && (
          <Notice tone="warning" testId="k8s-scale-zero">
            {t(
              'Scaling to 0 stops every pod of {name} — it serves nothing until you scale it up again.',
              { name: obj.metadata.name }
            )}
          </Notice>
        )}
        {production && (
          <>
            <Notice tone="warning">{t('Production context — type the name to confirm.')}</Notice>
            <Input
              mono
              placeholder={obj.metadata.name}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

const drainSummary = (r: DrainResult): string =>
  [
    t('Evicted {evicted} · skipped {skipped}', {
      evicted: r.evicted.length,
      skipped: r.skipped.length
    }),
    ...(r.failed.length ? [t('failed {n}', { n: r.failed.length })] : []),
    ...(r.blocked?.length ? [t('blocked by {n}', { n: r.blocked.length })] : [])
  ].join(' · ')

export function DrainDialog({
  node,
  production,
  request,
  onClose
}: {
  node: K8sObject
  production: boolean
  request: Request
  onClose: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<DrainResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [grace, setGrace] = useState('')
  const [timeout, setTimeoutText] = useState('300')
  const [emptyDir, setEmptyDir] = useState(false)
  const [force, setForce] = useState(false)
  const name = node.metadata.name
  const graceN = grace.trim() === '' ? undefined : Number(grace)
  const timeoutN = Number(timeout)
  const optionsValid =
    (graceN === undefined || (Number.isInteger(graceN) && graceN >= 0 && graceN <= 3600)) &&
    Number.isInteger(timeoutN) &&
    timeoutN >= 1 &&
    timeoutN <= 3600
  // Đóng hộp thoại khi đang drain: drain vẫn chạy trên Session Host → báo kết quả bằng toast.
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  const ok = !busy && optionsValid && (!production || typed === name)
  const start = (): void => {
    if (!ok) return
    setBusy(true)
    setError(null)
    request<DrainResult>({
      op: 'drain',
      node: name,
      ...(graceN !== undefined ? { gracePeriodSeconds: graceN } : {}),
      ...(emptyDir ? { deleteEmptyDirData: true } : {}),
      ...(force ? { force: true } : {}),
      timeoutSeconds: timeoutN
    }).then(
      (r) => {
        if (open.current) {
          setResult(r)
          setBusy(false)
          return
        }
        const problems = [...(r.blocked ?? []), ...r.failed]
        if (problems.length)
          toast.error(t('Drain of {name} did not finish', { name }), {
            description: drainSummary(r),
            details: problems.join('\n')
          })
        else toast.success(t('Drained {name}', { name }), { description: drainSummary(r) })
      },
      (e: unknown) => {
        if (open.current) {
          setError(cleanError(e))
          setBusy(false)
        } else toast.error(t('Could not drain {name}', { name }), { description: cleanError(e) })
      }
    )
  }
  return (
    <Modal
      title={t('Drain {name}?', { name })}
      description={t(
        'Cordons the node, then evicts its pods so they are rescheduled elsewhere. DaemonSet and static pods stay.'
      )}
      onClose={onClose}
      testId="k8s-drain-dialog"
      footer={
        result ? (
          <>
            {(result.blocked?.length ?? 0) > 0 && (
              <Button
                variant="ghost"
                data-testid="k8s-drain-retry"
                onClick={() => {
                  // Chưa evict gì: bật force / delete emptyDir rồi chạy lại.
                  setResult(null)
                }}
              >
                {t('Change options and retry')}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {t('Close')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {busy ? t('Run in background') : t('Cancel')}
            </Button>
            <Button variant="danger" disabled={!ok} data-testid="k8s-drain-confirm" onClick={start}>
              {busy ? t('Draining…') : t('Drain')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2">
        {busy && (
          <p className="text-xs text-muted">
            {t(
              'Evicting pods… You can close this window — the drain keeps running and the result shows up as a notification.'
            )}
          </p>
        )}
        {!result && !busy && (
          <div className="flex flex-col gap-2 text-[13px]" data-testid="k8s-drain-options">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">{t('Grace period (seconds)')}</span>
                <Input
                  mono
                  placeholder={t('pod default')}
                  data-testid="k8s-drain-grace"
                  value={grace}
                  onChange={(e) => {
                    setGrace(e.target.value.replace(/\D/g, ''))
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">{t('Give up after (seconds)')}</span>
                <Input
                  mono
                  data-testid="k8s-drain-timeout"
                  value={timeout}
                  onChange={(e) => {
                    setTimeoutText(e.target.value.replace(/\D/g, ''))
                  }}
                />
              </label>
            </div>
            <Checkbox
              label={t('Delete emptyDir data')}
              description={t('Also evict pods that use emptyDir volumes — that data is lost.')}
              checked={emptyDir}
              data-testid="k8s-drain-emptydir"
              onChange={(e) => {
                setEmptyDir(e.target.checked)
              }}
            />
            <Checkbox
              label={t('Force')}
              description={t(
                'Also evict pods without a controller — they are not recreated anywhere.'
              )}
              checked={force}
              data-testid="k8s-drain-force"
              onChange={(e) => {
                setForce(e.target.checked)
              }}
            />
          </div>
        )}
        {production && !result && !busy && (
          <>
            <Notice tone="warning">
              {t('This is a production context. Type the node name to confirm.')}
            </Notice>
            <Input
              autoFocus
              mono
              data-testid="k8s-drain-typed"
              placeholder={name}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') start()
              }}
            />
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {result && (
          <div className="flex flex-col gap-2 text-xs" data-testid="k8s-drain-result">
            <p className="text-fg">{drainSummary(result)}</p>
            {(result.blocked?.length ?? 0) > 0 && (
              <Notice tone="warning">
                {t(
                  'Nothing was evicted: these pods block the drain. Turn on “Delete emptyDir data” or “Force” to evict them too.'
                )}
                <span className="mt-1 block font-mono">{result.blocked?.join(', ')}</span>
              </Notice>
            )}
            {result.failed.map((f) => (
              <p key={f} className="text-danger">
                {f}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

export function HistoryDialog({
  obj,
  request,
  readOnly,
  onClose,
  onDone
}: {
  obj: K8sObject
  request: Request
  readOnly: boolean
  onClose: () => void
  onDone: (text: string) => void
}): React.JSX.Element {
  const [list, setList] = useState<RolloutRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { guard } = useClusterGuard()
  const ns = obj.metadata.namespace ?? ''
  useEffect(() => {
    request<RolloutRevision[]>({
      op: 'rolloutHistory',
      namespace: ns,
      name: obj.metadata.name
    }).then(setList, (e: unknown) => {
      setError(cleanError(e))
    })
  }, [request, ns, obj.metadata.name])
  return (
    <Modal
      title={t('Rollout history — {name}', { name: obj.metadata.name })}
      width="max-w-2xl"
      onClose={onClose}
      testId="k8s-history"
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!list && !error && <p className="text-xs text-faint">{t('Loading…')}</p>}
      {list && (
        <div className="flex flex-col divide-y divide-line text-xs">
          {list.map((r) => (
            <div
              key={r.revision}
              className="flex items-center gap-3 py-2"
              data-testid="k8s-revision"
            >
              <span className="w-10 font-mono text-fg">#{r.revision}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-fg">{r.images.join(', ')}</div>
                <div className="text-faint">
                  {r.replicaSet} · {t('{age} ago', { age: age(Date.parse(r.created)) })} ·{' '}
                  {tn(r.replicas, '{n} pod', '{n} pods')}
                </div>
              </div>
              {r.current ? (
                <Pill tone="ok">{t('current')}</Pill>
              ) : (
                !readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="k8s-rollback"
                    disabled={busy}
                    onClick={() => {
                      void guard({
                        title: t('Roll {name} back to revision {revision}?', {
                          name: obj.metadata.name,
                          revision: r.revision
                        }),
                        message: t(
                          'Pods are replaced with the template of revision {revision} ({images}).',
                          { revision: r.revision, images: r.images.join(', ') }
                        ),
                        confirmLabel: t('Roll back'),
                        name: obj.metadata.name
                      }).then((ok) => {
                        if (!ok) return
                        setBusy(true)
                        request({
                          op: 'rollback',
                          namespace: ns,
                          name: obj.metadata.name,
                          revision: r.revision
                        }).then(
                          () => {
                            onDone(
                              t('Rolled {name} back to revision {revision}', {
                                name: obj.metadata.name,
                                revision: r.revision
                              })
                            )
                            onClose()
                          },
                          (e: unknown) => {
                            setBusy(false)
                            setError(cleanError(e))
                          }
                        )
                      })
                    }}
                  >
                    {t('Roll back')}
                  </Button>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

export { YamlEditor } from './YamlEditor'

/** Chọn container khi pod có nhiều container (shell). */
export function ContainerPicker({
  containers,
  onPick,
  onClose
}: {
  containers: string[]
  onPick: (c: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(containers[0] ?? '')
  return (
    <Modal
      title={t('Open a shell')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onPick(value)
            }}
          >
            {t('Open')}
          </Button>
        </>
      }
    >
      <Select
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
        }}
      >
        {containers.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
    </Modal>
  )
}
