import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X
} from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice
} from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { Pill, type Tone } from '../../../renderer/src/components/panels'
import {
  closeTabNow,
  ConnectionPrompt,
  confirmAction,
  environmentById,
  SessionPool,
  setModuleTabParams,
  setTabCloseGuard,
  t,
  tn,
  toast
} from '../../registry/renderer-kit'
import type { ModuleTabProps, RunbookPrompt } from '../../registry/renderer-types'
import {
  DEFAULT_TIMEOUT_SEC,
  RunbookInput,
  newStepId,
  previewParams,
  runbookVariables,
  type Runbook,
  type RunbookStep,
  type RunbookTabParams,
  type StepResult,
  type StepStatus
} from '../shared/runbook'
import {
  executeRunbook,
  planRun,
  prepareKinds,
  summarize,
  type EnvInfo,
  type PromptFn
} from '../shared/runner'
import { duplicateRunbook, exportToFile } from './actions'
import { runbookApi } from './api'
import { loadHistory, recordRun, type RunRecord } from './history'
import { resolveKind, resolveUiKind, useKindEntries } from './kinds'
import { useRunbooks } from './store'

interface Draft {
  name: string
  description: string
  steps: RunbookStep[]
}

const blank = (): Draft => ({ name: '', description: '', steps: [] })
const fromRunbook = (r: Runbook): Draft => ({
  name: r.name,
  description: r.description,
  steps: r.steps
})

const STATUS_TONE: Record<StepStatus, Tone> = {
  pending: 'muted',
  running: 'info',
  pass: 'ok',
  fail: 'bad',
  skipped: 'muted',
  blocked: 'warn'
}

const statusLabel = (s: StepStatus): string => {
  switch (s) {
    case 'pending':
      return t('Waiting')
    case 'running':
      return t('Running')
    case 'pass':
      return t('Passed')
    case 'fail':
      return t('Failed')
    case 'skipped':
      return t('Skipped')
    case 'blocked':
      return t('Blocked')
  }
}

const seconds = (ms: number | undefined): string =>
  ms === undefined ? '' : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

/** Môi trường (đã cấu hình) của một id — dạng cho chính sách chạy. */
function envInfo(id: string): EnvInfo | undefined {
  const e = environmentById(id)
  return e ? { id: e.id, name: e.name, confirm: e.confirm, readOnly: e.readOnly } : undefined
}

/** Tên bước hiển thị: tên người dùng đặt, không thì mô tả của bước. */
function stepTitle(step: RunbookStep): string {
  if (step.name) return step.name
  const kind = resolveUiKind(step.type)
  if (!kind || kind === 'disabled') return step.type
  const parsed = kind.params.safeParse(step.params)
  return parsed.success ? kind.summary(parsed.data) : kind.label()
}

/** Kết quả dạng văn bản để dán vào ticket. */
export function resultsText(
  name: string,
  steps: readonly RunbookStep[],
  results: readonly StepResult[]
): string {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const lines = results.map((r) => {
    const step = byId.get(r.stepId)
    const head = `${RESULT_MARK[r.status]} ${step ? stepTitle(step) : r.stepId}`
    const tail = [r.detail, seconds(r.durationMs)].filter(Boolean).join(' · ')
    return tail ? `${head} — ${tail}` : head
  })
  const s = summarize(results)
  return [
    `${name} — ${s.ok ? t('all steps passed') : t('{failed} failed, {passed} passed', { failed: s.failed, passed: s.passed })}`,
    ...lines
  ].join('\n')
}

// ——— Hộp thoại chạy: biến, cảnh báo, gõ lại tên trên Production ———

/** Bước lỗi / bị chặn / bị bỏ qua của lần chạy trước — "Chạy lại bước lỗi" chạy lại đúng các bước này. */
function rerunnable(results: readonly StepResult[] | null): Set<string> {
  return new Set(
    (results ?? [])
      .filter((r) => r.status === 'fail' || r.status === 'blocked' || r.status === 'skipped')
      .map((r) => r.stepId)
  )
}

function RunDialog({
  name: rawName,
  steps,
  rerun,
  onClose,
  onRun
}: {
  name: string
  /** Các bước sẽ chạy (cả runbook, hoặc chỉ các bước lỗi khi chạy lại). */
  steps: readonly RunbookStep[]
  rerun: boolean
  onClose: () => void
  onRun: (values: Record<string, string>) => void
}): React.JSX.Element {
  const variables = useMemo(() => runbookVariables(steps), [steps])
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v.name, v.defaultValue ?? '']))
  )
  const [typed, setTyped] = useState('')
  // Loại bước nạp xong dữ liệu (danh sách context K8s…) thì môi trường của đích mới đúng.
  const [prepared, setPrepared] = useState(false)
  useEffect(() => {
    let live = true
    void prepareKinds(steps, resolveKind).then(() => {
      if (live) setPrepared(true)
    })
    return () => {
      live = false
    }
  }, [steps])
  // Tính mỗi lần vẽ (rẻ): theo giá trị biến (đích có thể nằm trong biến) và sau khi `prepared`.
  const plan = planRun(steps, resolveKind, envInfo, values)
  const missing = variables.filter((v) => v.defaultValue === null && (values[v.name] ?? '') === '')
  const needTyped = plan.typed.length > 0
  const name = rawName.trim()
  const ok = prepared && missing.length === 0 && (!needTyped || typed === name)
  const blockedSteps = steps.filter((s) => plan.blocked.has(s.id))
  return (
    <Modal
      title={
        rerun
          ? t('Run the failed steps of “{name}” again?', { name })
          : t('Run “{name}”?', { name })
      }
      description={tn(steps.length, '{n} step, in order', '{n} steps, in order')}
      onClose={onClose}
      width="max-w-lg"
      testId="runbook-run-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="runbook-run-confirm"
            disabled={!ok}
            onClick={() => {
              onRun(values)
            }}
          >
            <Play size={13} /> {t('Run')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {variables.map((v) => (
          <Field
            key={v.name}
            label={v.name}
            hint={
              v.defaultValue === null
                ? t('Required')
                : t('Default: {value}', { value: v.defaultValue || '—' })
            }
          >
            <Input
              mono
              data-testid={`runbook-var-${v.name}`}
              value={values[v.name] ?? ''}
              onChange={(e) => {
                setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
              }}
            />
          </Field>
        ))}
        {blockedSteps.length > 0 && (
          <Notice tone="warning" testId="runbook-run-blocked">
            {t(
              'Commands do not run on a read-only environment. These steps will be blocked: {steps}',
              {
                steps: blockedSteps.map(stepTitle).join(', ')
              }
            )}
          </Notice>
        )}
        {needTyped && (
          <>
            <Notice tone="warning" testId="runbook-run-production">
              {t('This runbook reaches {env}. Type its name to run it.', {
                env: plan.typed.join(', ')
              })}
            </Notice>
            <Input
              mono
              autoFocus
              placeholder={name}
              data-testid="runbook-run-typed"
              value={typed}
              onPaste={(e) => {
                e.preventDefault()
              }}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ok) onRun(values)
              }}
            />
          </>
        )}
      </div>
    </Modal>
  )
}

// ——— Một bước ———

function StepCard({
  index,
  step,
  count,
  result,
  onChange,
  onMove,
  onRemove,
  expanded,
  onToggle
}: {
  index: number
  step: RunbookStep
  count: number
  result: StepResult | undefined
  /** Thu gọn = chỉ dòng tiêu đề + kết quả (khi chỉ cần chạy, không sửa). */
  expanded: boolean
  onToggle: () => void
  onChange: (next: RunbookStep) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element {
  const kind = resolveUiKind(step.type)
  const usable = kind && kind !== 'disabled' ? kind : null
  const parsed = usable?.params.safeParse(previewParams(step.params))
  const Icon = usable?.icon
  const incomplete = Boolean(usable && parsed && !parsed.success && !result)
  const showResult = result !== undefined && result.status !== 'pending'
  const showBody = expanded || kind === 'disabled' || kind === undefined || showResult
  return (
    <div
      className="rounded-ds-lg border border-line bg-surface"
      data-testid="runbook-step"
      data-index={index}
      data-type={step.type}
      data-status={result?.status ?? 'idle'}
      data-expanded={expanded}
    >
      <div className={cx('flex items-center gap-2 px-3 py-2', showBody && 'border-b border-line')}>
        <IconButton
          label={expanded ? t('Collapse step') : t('Edit step')}
          size="sm"
          aria-expanded={expanded}
          data-testid="runbook-step-toggle"
          onClick={onToggle}
        >
          <ChevronRight
            size={13}
            className={cx('transition-transform duration-150', expanded && 'rotate-90')}
          />
        </IconButton>
        <span className="w-5 text-xs text-faint tabular-nums">{index + 1}</span>
        {Icon && <Icon size={14} className="shrink-0 text-muted" />}
        <span className="shrink-0 text-xs font-medium text-muted">
          {usable ? usable.label() : step.type}
        </span>
        <Input
          className="min-w-0 flex-1"
          placeholder={
            usable && parsed?.success ? usable.summary(parsed.data) : t('Name (optional)')
          }
          data-testid="runbook-step-name"
          value={step.name}
          onChange={(e) => {
            onChange({ ...step, name: e.target.value })
          }}
        />
        {incomplete && (
          <span className="shrink-0 text-xs text-warning" data-testid="runbook-step-incomplete">
            {t('Incomplete')}
          </span>
        )}
        <IconButton
          label={t('Move up')}
          size="sm"
          disabled={index === 0}
          data-testid="runbook-step-up"
          onClick={() => {
            onMove(-1)
          }}
        >
          <ArrowUp size={13} />
        </IconButton>
        <IconButton
          label={t('Move down')}
          size="sm"
          disabled={index === count - 1}
          data-testid="runbook-step-down"
          onClick={() => {
            onMove(1)
          }}
        >
          <ArrowDown size={13} />
        </IconButton>
        <IconButton
          label={t('Remove step')}
          size="sm"
          data-testid="runbook-step-remove"
          onClick={onRemove}
        >
          <X size={13} />
        </IconButton>
      </div>
      {showBody && (
        <div className="flex flex-col gap-3 p-3">
          {kind === 'disabled' && (
            <Notice tone="warning">
              {t('The module for this step is turned off — turn it on in Settings › Modules')}
            </Notice>
          )}
          {kind === undefined && (
            <Notice tone="warning">{t('Unknown step type “{type}”', { type: step.type })}</Notice>
          )}
          {usable && expanded && (
            <usable.Editor
              value={step.params}
              onChange={(params) => {
                onChange({ ...step, params })
              }}
            />
          )}
          {expanded && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-xs text-muted">
                {t('Give up after')}
                <TimeoutInput
                  value={step.timeoutSec}
                  onChange={(timeoutSec) => {
                    onChange({ ...step, timeoutSec })
                  }}
                />
                {t('seconds')}
              </label>
              <Checkbox
                label={t('Keep going if this step fails')}
                checked={step.continueOnFail}
                data-testid="runbook-step-continue"
                onChange={(e) => {
                  onChange({ ...step, continueOnFail: e.target.checked })
                }}
              />
            </div>
          )}
          {result && result.status !== 'pending' && (
            <div
              className="flex flex-col gap-1.5 border-t border-line pt-2.5"
              data-testid="runbook-step-result"
              data-status={result.status}
            >
              <div className="flex items-center gap-2 text-xs">
                <Pill tone={STATUS_TONE[result.status]}>{statusLabel(result.status)}</Pill>
                <span className="min-w-0 flex-1 text-fg" data-testid="runbook-step-detail">
                  {result.detail}
                </span>
                <span className="text-faint tabular-nums">{seconds(result.durationMs)}</span>
              </div>
              {result.output && (
                <pre
                  className="max-h-48 overflow-auto rounded-md bg-subtle p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted"
                  data-testid="runbook-step-output"
                >
                  {result.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const RESULT_MARK: Record<StepStatus, string> = {
  pass: '✓',
  fail: '✗',
  blocked: '⊘',
  skipped: '–',
  running: '…',
  pending: '·'
}

/** Một lần chạy cũ: bấm để xem từng bước (kết quả, chi tiết, đầu ra đã che bí mật), chép được. */
function HistoryRow({
  run,
  name,
  steps
}: {
  run: RunRecord
  name: string
  steps: readonly RunbookStep[]
}): React.JSX.Element {
  const byId = new Map(steps.map((s) => [s.id, s]))
  return (
    <li data-testid="runbook-history-row" data-ok={run.ok}>
      <details className="group">
        <summary
          className={cx(
            'flex cursor-pointer items-center gap-3 rounded-ds-md px-1 py-0.5 select-none hover:bg-ds-hover',
            run.ok ? 'text-success' : 'text-danger'
          )}
        >
          <ChevronRight
            size={12}
            className="shrink-0 text-faint transition-transform duration-150 group-open:rotate-90"
          />
          <span className="tabular-nums">{new Date(run.at).toLocaleString()}</span>
          <span>{run.ok ? t('Passed') : t('Failed')}</span>
          <span className="text-faint tabular-nums">{seconds(run.durationMs)}</span>
        </summary>
        <div className="mt-1 mb-2 ml-5 flex flex-col gap-1.5" data-testid="runbook-history-detail">
          {run.results.map((r) => {
            const step = byId.get(r.stepId)
            return (
              <div key={r.stepId} className="flex flex-col gap-1" data-status={r.status}>
                <div className="flex items-baseline gap-2">
                  <span className="w-3 shrink-0 text-center text-muted">
                    {RESULT_MARK[r.status]}
                  </span>
                  <span className="shrink-0 text-fg">
                    {step ? stepTitle(step) : t('(step removed since)')}
                  </span>
                  <span className="min-w-0 flex-1 text-muted">{r.detail}</span>
                  <span className="shrink-0 text-faint tabular-nums">{seconds(r.durationMs)}</span>
                </div>
                {r.output && (
                  <pre className="ml-5 max-h-32 overflow-auto rounded-md bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">
                    {r.output}
                  </pre>
                )}
              </div>
            )
          })}
          <div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="runbook-history-copy"
              onClick={() => {
                void window.shellhouse.writeClipboard(
                  `${new Date(run.at).toLocaleString()}\n${resultsText(name, steps, run.results)}`
                )
                toast.success(t('Copied'))
              }}
            >
              <Copy size={12} /> {t('Copy results')}
            </Button>
          </div>
        </div>
      </details>
    </li>
  )
}

/** Ô số giây: gõ tự do (xoá hết để gõ lại), chỉ nhận số 1…3600; rời ô thì trả về giá trị đang dùng. */
function TimeoutInput({
  value,
  onChange
}: {
  value: number
  onChange: (n: number) => void
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      mono
      inputMode="numeric"
      className="w-16"
      data-testid="runbook-step-timeout"
      value={text ?? String(value)}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value !== '' && Number.isInteger(n) && n >= 1 && n <= 3600) onChange(n)
      }}
      onBlur={() => {
        setText(null)
      }}
    />
  )
}

// ——— Tab ———

function Editor({
  tabId,
  runbook,
  active
}: {
  tabId: string
  runbook: Runbook | undefined
  active: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => (runbook ? fromRunbook(runbook) : blank()))
  const [baseline, setBaseline] = useState<string>(() =>
    JSON.stringify(runbook ? fromRunbook(runbook) : blank())
  )
  const [savedId, setSavedId] = useState<string | undefined>(runbook?.id)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Hộp thoại chạy đang mở: cả runbook, hoặc chỉ các bước lỗi (chạy lại). */
  const [runOpen, setRunOpen] = useState<'all' | 'failed' | null>(null)
  const [results, setResults] = useState<StepResult[] | null>(null)
  const [running, setRunning] = useState(false)
  /** Lần chạy gần nhất bị người dùng dừng. */
  const [stopped, setStopped] = useState(false)
  /** Bước đang mở form sửa: runbook mới mở hết; runbook đã lưu mở ra để chạy → thu gọn. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [prompt, setPrompt] = useState<{
    prompt: NonNullable<RunbookPrompt>
    answer: (ok: boolean, answers: string[]) => void
  } | null>(null)
  const [history, setHistory] = useState<RunRecord[]>(() =>
    runbook ? loadHistory(runbook.id) : []
  )
  const abortRef = useRef<AbortController | null>(null)
  const { menu, open: openMenu } = useContextMenu()
  const kinds = useKindEntries()

  const dirty = JSON.stringify(draft) !== baseline
  // Đóng tab khi đang chạy → dừng.
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )
  // Đóng tab khi còn thay đổi chưa lưu / đang chạy → hỏi trước.
  useEffect(
    () =>
      setTabCloseGuard(tabId, () => {
        if (running)
          return {
            title: t('Stop the runbook?'),
            message: t('The runbook is still running. Closing the tab stops it.'),
            confirmLabel: t('Stop and close')
          }
        if (dirty)
          return {
            title: t('Discard unsaved changes?'),
            message: t('This runbook has changes that are not saved.'),
            confirmLabel: t('Discard')
          }
        return null
      }),
    [tabId, dirty, running]
  )

  const patch = (next: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...next }))
  }
  const setStep = (i: number, step: RunbookStep): void => {
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? step : s)) }))
  }
  const addStep = (type: string): void => {
    const kind = resolveUiKind(type)
    if (!kind || kind === 'disabled') return
    const id = newStepId(new Set(draft.steps.map((s) => s.id)))
    setExpanded((prev) => new Set(prev).add(id))
    setDraft((d) => ({
      ...d,
      steps: [
        ...d.steps,
        {
          id,
          name: '',
          type,
          params: kind.defaults(),
          timeoutSec: DEFAULT_TIMEOUT_SEC,
          continueOnFail: false
        }
      ]
    }))
    setResults(null)
  }

  const save = async (): Promise<boolean> => {
    const input = RunbookInput.safeParse({
      ...(savedId ? { id: savedId } : {}),
      name: draft.name,
      description: draft.description,
      steps: draft.steps
    })
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? t('Check the runbook'))
      return false
    }
    setSaving(true)
    setError(null)
    const r = await runbookApi.save(input.data).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e)
    }))
    setSaving(false)
    if (!r.ok) {
      setError(r.message)
      return false
    }
    setSavedId(r.id)
    setBaseline(JSON.stringify(draft))
    // Danh sách phải có runbook mới TRƯỚC khi tab đổi sang `id` (không thì nháy "không còn nữa").
    await useRunbooks.getState().reload()
    setModuleTabParams(tabId, { id: r.id })
    toast.success(t('Saved'))
    return true
  }

  const remove = async (): Promise<void> => {
    if (!savedId) return
    const ok = await confirmAction({
      title: t('Delete “{name}”?', { name: draft.name }),
      message: t('The runbook and its steps are deleted. This cannot be undone.'),
      confirmLabel: t('Delete'),
      danger: true,
      testId: 'runbook-delete-confirm'
    })
    if (!ok) return
    abortRef.current?.abort()
    await runbookApi.remove(savedId)
    void useRunbooks.getState().reload()
    toast.success(t('Deleted'))
    closeTabNow(tabId)
  }

  const start = (values: Record<string, string>, only: ReadonlySet<string> | null): void => {
    setRunOpen(null)
    const all = draft.steps
    const steps = only ? all.filter((s) => only.has(s.id)) : all
    // Chạy lại bước lỗi: giữ kết quả các bước đã đạt, thay kết quả các bước chạy lại.
    const prior = only ? new Map((results ?? []).map((r) => [r.stepId, r])) : null
    const merge = (partial: readonly StepResult[]): StepResult[] => {
      if (!prior) return [...partial]
      const fresh = new Map(partial.map((r) => [r.stepId, r]))
      return all.map(
        (s) => fresh.get(s.id) ?? prior.get(s.id) ?? { stepId: s.id, status: 'pending', detail: '' }
      )
    }
    const plan = planRun(steps, resolveKind, envInfo, values)
    const controller = new AbortController()
    // Cùng đích (host, cluster, engine) → một phiên cho cả lần chạy: chỉ hỏi mật khẩu một lần.
    const pool = new SessionPool()
    abortRef.current = controller
    setRunning(true)
    setStopped(false)
    setError(null)
    const began = Date.now()
    const onPrompt: PromptFn = (p, answer) => {
      setPrompt(p ? { prompt: p as NonNullable<RunbookPrompt>, answer } : null)
    }
    void executeRunbook({
      steps,
      values,
      kindOf: resolveKind,
      plan,
      signal: controller.signal,
      onPrompt,
      pool,
      onUpdate: (partial) => {
        setResults(merge(partial))
      }
    }).then((partial) => {
      pool.closeAll()
      const final = merge(partial)
      setRunning(false)
      setPrompt(null)
      abortRef.current = null
      if (controller.signal.aborted) {
        setStopped(true)
        return
      }
      if (savedId)
        setHistory(
          recordRun(savedId, {
            at: began,
            ok: summarize(final).ok,
            durationMs: Date.now() - began,
            results: final
          })
        )
    })
  }

  const summary = results ? summarize(results) : null
  const finished =
    results !== null &&
    !running &&
    results.every((r) => r.status !== 'pending' && r.status !== 'running')
  const canRun = draft.name.trim() !== '' && draft.steps.length > 0 && !running
  const failedIds = useMemo(
    () => (finished ? rerunnable(results) : new Set<string>()),
    [finished, results]
  )
  const dialogSteps = useMemo(
    () => (runOpen === 'failed' ? draft.steps.filter((s) => failedIds.has(s.id)) : draft.steps),
    [runOpen, draft.steps, failedIds]
  )
  const resultOf = (id: string): StepResult | undefined => results?.find((r) => r.stepId === id)

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface"
      data-testid="runbook-view"
      data-active={active}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Input
            autoFocus={!runbook}
            className="min-w-0 flex-1 text-sm font-semibold"
            placeholder={t('Runbook name')}
            data-testid="runbook-name"
            value={draft.name}
            onChange={(e) => {
              patch({ name: e.target.value })
            }}
          />
          {dirty && (
            <span className="text-xs text-warning" data-testid="runbook-dirty">
              {t('Unsaved changes')}
            </span>
          )}
          <Button
            variant="ghost"
            data-testid="runbook-save"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {t('Save')}
          </Button>
          {savedId && (
            <IconButton
              label={t('Duplicate')}
              data-testid="runbook-duplicate"
              disabled={draft.name.trim() === ''}
              onClick={() => void duplicateRunbook(draft)}
            >
              <CopyPlus size={14} />
            </IconButton>
          )}
          <IconButton
            label={t('Export…')}
            data-testid="runbook-export"
            disabled={draft.name.trim() === '' || draft.steps.length === 0}
            onClick={() => void exportToFile([draft], draft.name)}
          >
            <Download size={14} />
          </IconButton>
          {savedId && (
            <IconButton
              label={t('Delete runbook')}
              data-testid="runbook-delete"
              onClick={() => void remove()}
            >
              <Trash2 size={14} />
            </IconButton>
          )}
          {running ? (
            <Button
              variant="danger"
              data-testid="runbook-stop"
              onClick={() => {
                abortRef.current?.abort()
              }}
            >
              <Square size={12} /> {t('Stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="runbook-run"
              disabled={!canRun}
              onClick={() => {
                setRunOpen('all')
              }}
            >
              <Play size={13} /> {t('Run')}
            </Button>
          )}
        </div>
        <Input
          placeholder={t('What is this for? (optional)')}
          data-testid="runbook-description"
          value={draft.description}
          onChange={(e) => {
            patch({ description: e.target.value })
          }}
        />
        {error && (
          <Notice tone="danger" testId="runbook-error">
            {error}
          </Notice>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        {summary && finished && (
          <Notice
            tone={stopped ? 'warning' : summary.ok ? 'success' : 'danger'}
            testId="runbook-summary"
          >
            <div className="flex items-center gap-3">
              <span data-testid="runbook-summary-text" data-ok={summary.ok} data-stopped={stopped}>
                {stopped
                  ? t('Stopped — {passed} passed, {failed} failed, {skipped} not run', {
                      passed: summary.passed,
                      failed: summary.failed,
                      skipped: summary.skipped
                    })
                  : summary.ok
                    ? tn(summary.passed, 'All {n} step passed', 'All {n} steps passed')
                    : t('{passed} passed, {failed} failed, {skipped} skipped', {
                        passed: summary.passed,
                        failed: summary.failed,
                        skipped: summary.skipped
                      })}
              </span>
              {failedIds.size > 0 && (
                <Button
                  variant="ghost"
                  data-testid="runbook-rerun-failed"
                  disabled={!canRun}
                  onClick={() => {
                    setRunOpen('failed')
                  }}
                >
                  <RotateCcw size={13} /> {t('Run failed steps again')}
                </Button>
              )}
              <Button
                variant="ghost"
                data-testid="runbook-copy-results"
                onClick={() => {
                  void window.shellhouse.writeClipboard(
                    resultsText(draft.name, draft.steps, results)
                  )
                  toast.success(t('Copied'))
                }}
              >
                <Copy size={13} /> {t('Copy results')}
              </Button>
            </div>
          </Notice>
        )}
        {draft.steps.length === 0 && (
          <div
            className="rounded-ds-lg border border-dashed border-line p-6 text-center text-xs text-faint"
            data-testid="runbook-empty"
          >
            {t('No steps yet. Add the first check — for example an HTTP health URL.')}
          </div>
        )}
        {/* Đang chạy: khoá sửa (bộ chạy đang dùng bản bước lúc bấm Chạy). */}
        <fieldset disabled={running} className="contents" data-testid="runbook-steps">
          {draft.steps.map((step, i) => (
            <StepCard
              key={step.id}
              index={i}
              step={step}
              count={draft.steps.length}
              result={resultOf(step.id)}
              expanded={expanded.has(step.id)}
              onToggle={() => {
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (!next.delete(step.id)) next.add(step.id)
                  return next
                })
              }}
              onChange={(next) => {
                setStep(i, next)
              }}
              onMove={(dir) => {
                setDraft((d) => {
                  const steps = [...d.steps]
                  const [moved] = steps.splice(i, 1)
                  if (moved) steps.splice(i + dir, 0, moved)
                  return { ...d, steps }
                })
                setResults(null)
              }}
              onRemove={() => {
                setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))
                setResults(null)
              }}
            />
          ))}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              data-testid="runbook-add-step"
              disabled={running}
              onClick={(e) => {
                const entries: MenuEntry[] = kinds.map(({ type, kind }) => {
                  const Icon = kind.icon
                  return {
                    id: `runbook-add-${type}`,
                    label: kind.label(),
                    icon: <Icon size={14} />,
                    onSelect: () => {
                      addStep(type)
                    }
                  }
                })
                openMenu(e, entries)
              }}
            >
              <Plus size={13} /> {t('Add step')}
            </Button>
            {draft.steps.length > 1 && (
              <Button
                variant="ghost"
                data-testid="runbook-toggle-all"
                onClick={() => {
                  setExpanded(expanded.size > 0 ? new Set() : new Set(draft.steps.map((s) => s.id)))
                }}
              >
                {expanded.size > 0 ? t('Collapse all') : t('Edit all steps')}
              </Button>
            )}
          </div>
        </fieldset>

        {history.length > 0 && (
          <details className="mt-2 text-xs" data-testid="runbook-history">
            <summary className="cursor-pointer text-muted select-none">
              {tn(history.length, 'Last run', 'Last {n} runs')}
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {history.map((h) => (
                <HistoryRow key={h.at} run={h} name={draft.name} steps={draft.steps} />
              ))}
            </ul>
          </details>
        )}
      </div>
      {menu}
      {runOpen && (
        <RunDialog
          name={draft.name}
          steps={dialogSteps}
          rerun={runOpen === 'failed'}
          onClose={() => {
            setRunOpen(null)
          }}
          onRun={(values) => {
            start(values, runOpen === 'failed' ? failedIds : null)
          }}
        />
      )}
      {prompt && <ConnectionPrompt prompt={prompt.prompt} onAnswer={prompt.answer} />}
    </div>
  )
}

export function RunbookTab({
  tabId,
  params,
  active
}: ModuleTabProps<RunbookTabParams>): React.JSX.Element {
  const loaded = useRunbooks((s) => s.loaded)
  const runbooks = useRunbooks((s) => s.runbooks)
  useEffect(() => {
    void useRunbooks.getState().reload()
  }, [])
  // Tab mở lúc khởi động: đợi danh sách đọc xong rồi mới dựng form (không điền thiếu rồi đổi).
  if (params.id && !loaded) return <div className="p-6 text-xs text-faint">{t('Loading…')}</div>
  const runbook = params.id ? runbooks.find((r) => r.id === params.id) : undefined
  if (params.id && !runbook)
    return (
      <div className="p-6" data-testid="runbook-missing">
        <Notice tone="warning">{t('This runbook no longer exists.')}</Notice>
      </div>
    )
  // Khoá theo tab: lưu runbook mới (tab đổi sang `id`) không dựng lại form — giữ kết quả vừa chạy.
  return <Editor key={tabId} tabId={tabId} runbook={runbook} active={active} />
}
