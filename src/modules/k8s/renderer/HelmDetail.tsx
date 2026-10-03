import { useEffect, useMemo, useState } from 'react'
import { Copy, Eye, EyeOff, GitCompare, History, RotateCcw, Trash2, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  IconButton,
  Input,
  Modal,
  Notice,
  Segmented,
  Select
} from '../../../renderer/src/components/ui'
import {
  DefList,
  Heading,
  Pill,
  SidePanel,
  TabStrip
} from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatDateTime, formatRelative, t, tn, toast } from '../../registry/renderer-kit'
import type {
  HelmActionResult,
  HelmRelease,
  HelmReleaseDetail,
  HelmRevisionDetail,
  K8sOp
} from '../shared/ops'
import { maskSecretValues, parseManifest } from '../shared/helm'
import { useClusterGuard } from './confirm'
import { DiffView } from './DiffView'

type Request = <T>(op: K8sOp) => Promise<T>

/** Trạng thái Helm → màu (deployed xanh, failed đỏ, pending-* vàng). */
export function helmTone(status: string): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'deployed') return 'ok'
  if (status === 'failed') return 'bad'
  if (status.startsWith('pending') || status === 'uninstalling') return 'warn'
  return 'muted'
}

type Tab = 'overview' | 'values' | 'manifest' | 'history'

/** Một revision (nhớ trong phiên chi tiết — revision cũ không đổi). */
function useRevision(
  request: Request,
  release: HelmRelease,
  revision: number | null,
  version: number
): { data: HelmRevisionDetail | null; error: string | null } {
  const [state, setState] = useState<{
    key: string
    data: HelmRevisionDetail | null
    error: string | null
  } | null>(null)
  const key = `${release.namespace}/${release.name}#${String(revision)}@${String(version)}`
  useEffect(() => {
    if (revision === null) return
    let cancelled = false
    request<HelmRevisionDetail>({
      op: 'helm.revision',
      namespace: release.namespace,
      name: release.name,
      revision
    }).then(
      (data) => {
        if (!cancelled) setState({ key, data, error: null })
      },
      (e: unknown) => {
        if (!cancelled) setState({ key, data: null, error: cleanError(e) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, release.namespace, release.name, revision, key])
  return state?.key === key ? state : { data: null, error: null }
}

/**
 * Chi tiết release (như Lens): tổng quan, values (giá trị bí mật che sẵn), manifest, lịch sử revision
 * — so sánh hai revision, rollback, uninstall. Không cần helm CLI; upgrade thì cần (render chart).
 */
export function HelmDetail({
  release,
  request,
  readOnly,
  onClose,
  onChanged
}: {
  release: HelmRelease
  request: Request
  readOnly: boolean
  onClose: () => void
  /** Đã rollback / uninstall → tải lại danh sách. */
  onChanged: (removed: boolean) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<HelmReleaseDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [version, setVersion] = useState(0)
  const [dialog, setDialog] = useState<
    | { kind: 'rollback'; revision: number }
    | { kind: 'uninstall' }
    | { kind: 'compare'; from: number; to: number }
    | null
  >(null)
  useEffect(() => {
    let cancelled = false
    request<HelmReleaseDetail>({
      op: 'helm.release',
      namespace: release.namespace,
      name: release.name
    }).then(
      (d) => {
        if (cancelled) return
        setDetail(d)
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, release.namespace, release.name, version])
  const d = detail ?? { ...release, values: '', notes: '', manifest: '', history: [] }
  const chart = `${d.chart}${d.chartVersion ? ` ${d.chartVersion}` : ''}`
  /** Revision để quay về mặc định: revision trước gần nhất (như `helm rollback <tên>`). */
  const previous = d.history.find((h) => h.revision < d.revision)?.revision ?? null
  const busyStatus = d.status.startsWith('pending-') || d.status === 'uninstalling'
  const changed = (removed: boolean): void => {
    setVersion((v) => v + 1)
    onChanged(removed)
  }

  return (
    <SidePanel storageKey="k8s-helm" defaultWidth={520} testId="k8s-helm-detail">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{release.name}</span>
            <Pill tone={helmTone(d.status)}>{d.status}</Pill>
          </div>
          <div className="truncate text-xs text-faint">
            {t('Helm release · {namespace} · revision {revision}', {
              namespace: release.namespace,
              revision: d.revision
            })}
          </div>
        </div>
        <IconButton label={t('Close')} size="sm" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={13} />}
            disabled={previous === null || busyStatus || !detail}
            title={
              previous === null
                ? t('There is no earlier revision to roll back to')
                : busyStatus
                  ? t('Another operation is in progress')
                  : t('Roll back to an earlier revision')
            }
            data-testid="k8s-helm-rollback"
            onClick={() => {
              if (previous !== null) setDialog({ kind: 'rollback', revision: previous })
            }}
          >
            {t('Roll back…')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={13} />}
            disabled={!detail}
            data-testid="k8s-helm-uninstall"
            onClick={() => {
              setDialog({ kind: 'uninstall' })
            }}
          >
            {t('Uninstall…')}
          </Button>
          <span
            className="ml-auto truncate text-[11px] text-faint"
            title={t('Upgrading renders the chart templates — run helm upgrade with the helm CLI.')}
          >
            {t('Upgrade needs the helm CLI')}
          </span>
        </div>
      )}
      <TabStrip<Tab>
        value={tab}
        onChange={setTab}
        testIdPrefix="k8s-helm-tab"
        tabs={[
          { id: 'overview', label: t('Overview') },
          { id: 'values', label: t('Values') },
          { id: 'manifest', label: t('Manifest') },
          { id: 'history', label: t('History'), count: d.history.length || undefined }
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
        {error && (
          <div className="mb-2">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
        {tab === 'overview' && (
          <div className="flex flex-col gap-4">
            <DefList
              items={[
                [t('Chart'), chart],
                [t('App version'), d.appVersion || '—'],
                [
                  t('Status'),
                  <Pill key="s" tone={helmTone(d.status)}>
                    {d.status}
                  </Pill>
                ],
                [t('Revision'), String(d.revision)],
                [
                  t('Updated'),
                  d.updated ? (
                    <span key="u" title={formatDateTime(d.updated)}>
                      {formatRelative(d.updated)}
                    </span>
                  ) : (
                    '—'
                  )
                ],
                [t('Description'), d.description || '—']
              ]}
            />
            {d.notes && (
              <section>
                <Heading>{t('Notes')}</Heading>
                <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg select-text">
                  {d.notes}
                </pre>
              </section>
            )}
          </div>
        )}
        {tab === 'values' && (
          <ValuesTab request={request} release={release} revision={d.revision} version={version} />
        )}
        {tab === 'manifest' && <Code text={detail ? d.manifest : t('Loading…')} />}
        {tab === 'history' && (
          <div className="flex flex-col text-xs" data-testid="k8s-helm-history">
            {d.history.map((h) => {
              const current = h.revision === d.revision
              return (
                <div
                  key={h.revision}
                  className="group flex items-center gap-2 border-b border-line py-1.5 last:border-0"
                  data-testid="k8s-helm-revision"
                >
                  <span className="w-8 shrink-0 text-right font-mono text-muted">{h.revision}</span>
                  <Pill tone={helmTone(h.status)}>{h.status}</Pill>
                  <span className="min-w-0 flex-1 truncate text-fg" title={h.description}>
                    {h.chart}-{h.chartVersion}
                    <span className="ml-2 text-faint">{h.description}</span>
                  </span>
                  <span className="shrink-0 text-faint" title={formatDateTime(h.updated)}>
                    {h.updated ? formatRelative(h.updated) : '—'}
                  </span>
                  {!current && (
                    <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <IconButton
                        size="sm"
                        label={t('Compare with revision {revision}', { revision: d.revision })}
                        onClick={() => {
                          setDialog({ kind: 'compare', from: h.revision, to: d.revision })
                        }}
                      >
                        <GitCompare size={13} />
                      </IconButton>
                      {!readOnly && !busyStatus && (
                        <IconButton
                          size="sm"
                          label={t('Roll back to revision {revision}', { revision: h.revision })}
                          data-testid="k8s-helm-rollback-to"
                          onClick={() => {
                            setDialog({ kind: 'rollback', revision: h.revision })
                          }}
                        >
                          <History size={13} />
                        </IconButton>
                      )}
                    </span>
                  )}
                </div>
              )
            })}
            {d.history.length > 1 && (
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<GitCompare size={13} />}
                  data-testid="k8s-helm-compare"
                  onClick={() => {
                    setDialog({ kind: 'compare', from: previous ?? d.revision, to: d.revision })
                  }}
                >
                  {t('Compare revisions…')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {dialog?.kind === 'compare' && (
        <CompareDialog
          request={request}
          release={release}
          revisions={d.history.map((h) => h.revision)}
          from={dialog.from}
          to={dialog.to}
          onClose={() => {
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'rollback' && (
        <RollbackDialog
          request={request}
          release={release}
          current={d.revision}
          revisions={d.history.filter((h) => h.revision !== d.revision)}
          initial={dialog.revision}
          onClose={() => {
            setDialog(null)
          }}
          onDone={() => {
            changed(false)
          }}
        />
      )}
      {dialog?.kind === 'uninstall' && (
        <UninstallDialog
          request={request}
          release={release}
          manifest={d.manifest}
          onClose={() => {
            setDialog(null)
          }}
          onDone={(keepHistory) => {
            setDialog(null)
            changed(!keepHistory)
            if (!keepHistory) onClose()
          }}
        />
      )}
    </SidePanel>
  )
}

function Code({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="overflow-auto font-mono text-[11px] leading-relaxed text-fg select-text">
      {text}
    </pre>
  )
}

/** Values: người dùng đặt / gộp với mặc định của chart; giá trị bí mật che, bấm mới hiện. */
function ValuesTab({
  request,
  release,
  revision,
  version
}: {
  request: Request
  release: HelmRelease
  revision: number
  version: number
}): React.JSX.Element {
  const [which, setWhich] = useState<'user' | 'all'>('user')
  const [reveal, setReveal] = useState(false)
  const { data, error } = useRevision(request, release, revision, version)
  const raw = data ? (which === 'user' ? data.values : data.computedValues) : ''
  const masked = useMemo(() => maskSecretValues(raw), [raw])
  const shown = reveal ? raw : masked.text
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Segmented<'user' | 'all'>
          value={which}
          onChange={setWhich}
          options={[
            { value: 'user', label: t('User-supplied') },
            { value: 'all', label: t('All (with chart defaults)') }
          ]}
          testIdPrefix="k8s-helm-values"
        />
        <span className="ml-auto flex items-center gap-1">
          {masked.masked > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={reveal ? <EyeOff size={13} /> : <Eye size={13} />}
              data-testid="k8s-helm-reveal"
              onClick={() => {
                setReveal(!reveal)
              }}
            >
              {reveal
                ? t('Hide secrets')
                : tn(masked.masked, 'Reveal {n} hidden value', 'Reveal {n} hidden values')}
            </Button>
          )}
          <IconButton
            size="sm"
            label={t('Copy')}
            disabled={!raw}
            onClick={() => {
              void window.shellhouse.writeClipboard(raw).then(() => {
                toast.success(t('Copied values'))
              })
            }}
          >
            <Copy size={13} />
          </IconButton>
        </span>
      </div>
      <p className="text-[11px] text-faint">
        {which === 'user'
          ? t('Values set for this release (helm get values).')
          : t(
              'Chart defaults merged with the values set for this release (helm get values --all).'
            )}
      </p>
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : (
        <div data-testid="k8s-helm-values">
          <Code
            text={
              data ? shown || t('# No values set — the chart defaults are used.') : t('Loading…')
            }
          />
        </div>
      )}
    </div>
  )
}

/** So sánh hai revision: manifest hoặc values (values bí mật vẫn che). */
function CompareDialog({
  request,
  release,
  revisions,
  from: initialFrom,
  to: initialTo,
  onClose
}: {
  request: Request
  release: HelmRelease
  revisions: number[]
  from: number
  to: number
  onClose: () => void
}): React.JSX.Element {
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [what, setWhat] = useState<'manifest' | 'values'>('manifest')
  const a = useRevision(request, release, from, 0)
  const b = useRevision(request, release, to, 0)
  const text = (r: HelmRevisionDetail | null): string =>
    !r ? '' : what === 'manifest' ? r.manifest : maskSecretValues(r.values).text
  const pick = (value: number, set: (n: number) => void, label: string): React.JSX.Element => (
    <Select
      aria-label={label}
      className="h-7 w-24 text-xs"
      value={String(value)}
      onChange={(e) => {
        set(Number(e.target.value))
      }}
    >
      {revisions.map((r) => (
        <option key={r} value={r}>
          {t('rev {revision}', { revision: r })}
        </option>
      ))}
    </Select>
  )
  const error = a.error ?? b.error
  return (
    <Modal
      title={t('Compare revisions of {name}', { name: release.name })}
      width="max-w-5xl"
      onClose={onClose}
      testId="k8s-helm-compare-dialog"
      bodyClassName="flex min-h-0 flex-col"
    >
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          {pick(from, setFrom, t('From revision'))}
          <span className="text-faint">→</span>
          {pick(to, setTo, t('To revision'))}
          <span className="ml-auto">
            <Segmented<'manifest' | 'values'>
              value={what}
              onChange={setWhat}
              options={[
                { value: 'manifest', label: t('Manifest') },
                { value: 'values', label: t('Values') }
              ]}
            />
          </span>
        </div>
        {error ? (
          <Notice tone="danger">{error}</Notice>
        ) : a.data && b.data ? (
          <DiffView
            className="h-[60vh]"
            left={text(a.data)}
            right={text(b.data)}
            leftLabel={t('revision {revision}', { revision: from })}
            rightLabel={t('revision {revision}', { revision: to })}
            testId="k8s-helm-diff"
          />
        ) : (
          <p className="py-6 text-center text-xs text-faint">{t('Loading…')}</p>
        )}
      </div>
    </Modal>
  )
}

/** Tóm tắt kết quả rollback / uninstall theo từng đối tượng. */
function ResultList({ result }: { result: HelmActionResult }): React.JSX.Element {
  const groups: [string, string[], string][] = [
    [t('Applied'), result.applied, 'text-success'],
    [t('Deleted'), result.deleted, 'text-muted'],
    [t('Kept (resource-policy: keep)'), result.kept, 'text-warning'],
    [t('Failed'), result.failed, 'text-danger']
  ]
  return (
    <div
      className="flex max-h-56 flex-col gap-2 overflow-auto text-xs"
      data-testid="k8s-helm-result"
    >
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([title, list, cls]) => (
          <section key={title}>
            <Heading>
              {title} · {list.length}
            </Heading>
            {list.map((x) => (
              <div key={x} className={cx('truncate font-mono text-[11px]', cls)} title={x}>
                {x}
              </div>
            ))}
          </section>
        ))}
    </div>
  )
}

/** Gõ tên release (context production) mới bấm được. */
function ProductionCheck({
  name,
  value,
  onChange
}: {
  name: string
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Notice tone="warning">
        {t('This is a production context. Type {name} to confirm.', { name })}
      </Notice>
      <Input
        mono
        data-testid="k8s-confirm-typed"
        placeholder={name}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </div>
  )
}

function RollbackDialog({
  request,
  release,
  current,
  revisions,
  initial,
  onClose,
  onDone
}: {
  request: Request
  release: HelmRelease
  current: number
  revisions: HelmReleaseDetail['history']
  initial: number
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { production } = useClusterGuard()
  const [target, setTarget] = useState(initial)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<HelmActionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const a = useRevision(request, release, current, 0)
  const b = useRevision(request, release, target, 0)
  const hooks = (b.data?.hooks ?? []).filter((h) =>
    h.events.some((e) => e === 'pre-rollback' || e === 'post-rollback')
  )
  const ok = !busy && !result && (!production || typed === release.name)
  const run = (): void => {
    if (!ok) return
    setBusy(true)
    setError(null)
    request<HelmActionResult>({
      op: 'helm.rollback',
      namespace: release.namespace,
      name: release.name,
      revision: target
    }).then(
      (r) => {
        setBusy(false)
        onDone()
        if (r.failed.length === 0) {
          toast.success(
            t('Rolled back {name} to revision {revision}', {
              name: release.name,
              revision: target
            }),
            {
              description: t('New revision {revision}', { revision: r.revision })
            }
          )
          onClose()
        } else setResult(r)
      },
      (e: unknown) => {
        setBusy(false)
        setError(cleanError(e))
      }
    )
  }
  return (
    <Modal
      title={t('Roll back {name}?', { name: release.name })}
      description={t(
        'Re-applies the manifest of the chosen revision as a new revision, like helm rollback.'
      )}
      width="max-w-5xl"
      onClose={onClose}
      testId="k8s-helm-rollback-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {result ? t('Close') : t('Cancel')}
          </Button>
          {!result && (
            <Button
              variant="danger"
              disabled={!ok}
              data-testid="k8s-helm-rollback-ok"
              onClick={run}
            >
              {busy ? t('Rolling back…') : t('Roll back to {revision}', { revision: target })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          {t('Revision')}
          <Select
            className="h-7 w-auto min-w-48 text-xs"
            value={String(target)}
            data-testid="k8s-helm-rollback-revision"
            disabled={busy || result !== null}
            onChange={(e) => {
              setTarget(Number(e.target.value))
            }}
          >
            {revisions.map((h) => (
              <option key={h.revision} value={h.revision}>
                {`${String(h.revision)} · ${h.status} · ${h.chart}-${h.chartVersion}`}
              </option>
            ))}
          </Select>
        </label>
        {hooks.length > 0 && (
          <Notice tone="warning">
            {tn(
              hooks.length,
              'This revision has {n} rollback hook ({names}). Hooks are not run (like --no-hooks).',
              'This revision has {n} rollback hooks ({names}). Hooks are not run (like --no-hooks).',
              { names: hooks.map((h) => h.name).join(', ') }
            )}
          </Notice>
        )}
        {a.error || b.error ? (
          <Notice tone="danger">{a.error ?? b.error}</Notice>
        ) : a.data && b.data ? (
          <DiffView
            className="h-[45vh]"
            left={a.data.manifest}
            right={b.data.manifest}
            leftLabel={t('current (revision {revision})', { revision: current })}
            rightLabel={t('revision {revision}', { revision: target })}
            testId="k8s-helm-rollback-diff"
          />
        ) : (
          <p className="py-6 text-center text-xs text-faint">{t('Loading…')}</p>
        )}
        <p className="text-[11px] text-faint">
          {t(
            'Objects only in the current revision are deleted (except helm.sh/resource-policy: keep). Server-side apply with field manager “helm”.'
          )}
        </p>
        {production && !result && (
          <ProductionCheck name={release.name} value={typed} onChange={setTyped} />
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {result && (
          <>
            <Notice tone="danger">
              {t('The rollback failed — revision {revision} is marked failed.', {
                revision: result.revision
              })}
            </Notice>
            <ResultList result={result} />
          </>
        )}
      </div>
    </Modal>
  )
}

function UninstallDialog({
  request,
  release,
  manifest,
  onClose,
  onDone
}: {
  request: Request
  release: HelmRelease
  manifest: string
  onClose: () => void
  onDone: (keepHistory: boolean) => void
}): React.JSX.Element {
  const { production } = useClusterGuard()
  const [keepHistory, setKeepHistory] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<HelmActionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const objects = useMemo(() => parseManifest(manifest), [manifest])
  const keep = objects.filter(
    (o) => o.obj.metadata.annotations?.['helm.sh/resource-policy'] === 'keep'
  )
  const ok = !busy && !result && (!production || typed === release.name)
  const run = (): void => {
    if (!ok) return
    setBusy(true)
    setError(null)
    request<HelmActionResult>({
      op: 'helm.uninstall',
      namespace: release.namespace,
      name: release.name,
      keepHistory
    }).then(
      (r) => {
        setBusy(false)
        if (r.failed.length === 0) {
          toast.success(t('Uninstalled {name}', { name: release.name }), {
            description: tn(r.deleted.length, 'Deleted {n} object', 'Deleted {n} objects')
          })
          onDone(keepHistory)
        } else setResult(r)
      },
      (e: unknown) => {
        setBusy(false)
        setError(cleanError(e))
      }
    )
  }
  return (
    <Modal
      title={t('Uninstall {name}?', { name: release.name })}
      description={t('Deletes the objects of the release, like helm uninstall.')}
      width="max-w-lg"
      onClose={onClose}
      testId="k8s-helm-uninstall-dialog"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              if (result) onDone(keepHistory)
              else onClose()
            }}
          >
            {result ? t('Close') : t('Cancel')}
          </Button>
          {!result && (
            <Button
              variant="danger"
              disabled={!ok}
              data-testid="k8s-helm-uninstall-ok"
              onClick={run}
            >
              {busy ? t('Uninstalling…') : t('Uninstall')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        <section>
          <Heading>{tn(objects.length, '{n} object', '{n} objects')}</Heading>
          <div className="max-h-40 overflow-auto font-mono text-[11px] text-muted">
            {objects.map((o) => (
              <div key={o.key} className="truncate">
                {o.label}
                {keep.includes(o) && (
                  <span className="ml-2 font-sans text-warning">{t('kept')}</span>
                )}
              </div>
            ))}
          </div>
        </section>
        {keep.length > 0 && (
          <p className="text-faint">
            {tn(
              keep.length,
              '{n} object has helm.sh/resource-policy: keep and stays on the cluster.',
              '{n} objects have helm.sh/resource-policy: keep and stay on the cluster.'
            )}
          </p>
        )}
        <Checkbox
          checked={keepHistory}
          onChange={(e) => {
            setKeepHistory(e.target.checked)
          }}
          label={t('Keep release history')}
          description={t('Like --keep-history: the release stays listed as uninstalled.')}
        />
        <p className="text-faint">
          {t(
            'Hooks (pre-delete / post-delete) are not run. Persistent volume claims created by StatefulSets are not deleted.'
          )}
        </p>
        {production && !result && (
          <ProductionCheck name={release.name} value={typed} onChange={setTyped} />
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {result && (
          <>
            <Notice tone="warning">
              {t('Uninstalled with errors — some objects could not be deleted.')}
            </Notice>
            <ResultList result={result} />
          </>
        )}
      </div>
    </Modal>
  )
}
