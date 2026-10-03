import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { S3Op } from '../shared/ops'
import {
  CORS_TEMPLATE,
  lifecycleRuleProblem,
  newLifecycleRule,
  parseCorsJson,
  suggestRuleId,
  type S3CorsRule,
  type S3Feature,
  type S3LifecycleRule,
  type S3Versioning
} from '../shared/manage'
import {
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  Segmented,
  TextArea
} from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import { confirmAction, t, tn, toast } from '../../registry/renderer-kit'
import { FeatureNotice } from './S3Details'
import { cleanError } from './format'

export type BucketSettingsTab = 'versioning' | 'lifecycle' | 'cors'
type Run = (op: S3Op) => Promise<unknown>

/** Đọc một cấu hình (S3Feature); lỗi IPC cũng thành trạng thái 'error'. `reload` → đọc lại. */
function useFeature<T>(run: Run, op: S3Op): { value: S3Feature<T> | null; reload: () => void } {
  const [state, setState] = useState<{ gen: number; value: S3Feature<T> } | null>(null)
  const [gen, setGen] = useState(0)
  const json = JSON.stringify(op)
  useEffect(() => {
    let alive = true
    void run(JSON.parse(json) as S3Op)
      .catch((e: unknown) => ({ state: 'error' as const, message: cleanError(e) }))
      .then((value) => {
        if (alive) setState({ gen, value: value as S3Feature<T> })
      })
    return () => {
      alive = false
    }
  }, [run, json, gen])
  return {
    value: state?.gen === gen ? state.value : null,
    reload: () => {
      setGen((g) => g + 1)
    }
  }
}

function Loading(): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 py-6 text-xs text-faint">
      <RefreshCw size={12} className="animate-spin" /> {t('Loading…')}
    </p>
  )
}

/**
 * Cài đặt bucket: versioning (bật / tạm dừng), lifecycle (xem + thêm rule đơn giản), CORS (JSON).
 * Dịch vụ không hỗ trợ API nào thì phần đó hiện "Not supported by this provider".
 */
export function S3BucketSettingsDialog({
  run,
  bucket,
  initialTab = 'versioning',
  onClose,
  onVersioningChanged
}: {
  run: Run
  bucket: string
  initialTab?: BucketSettingsTab
  onClose: () => void
  onVersioningChanged?: (status: S3Versioning) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<BucketSettingsTab>(initialTab)
  return (
    <Modal
      title={t('Bucket settings')}
      description={<span className="font-mono">{bucket}</span>}
      onClose={onClose}
      width="max-w-2xl"
      testId="s3-bucket-settings"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('Close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="self-start">
          <Segmented
            value={tab}
            onChange={setTab}
            testIdPrefix="s3-settings-tab"
            options={[
              { value: 'versioning', label: t('Versioning') },
              { value: 'lifecycle', label: t('Lifecycle') },
              { value: 'cors', label: 'CORS' }
            ]}
          />
        </div>
        {tab === 'versioning' && (
          <VersioningPane run={run} bucket={bucket} onChanged={onVersioningChanged} />
        )}
        {tab === 'lifecycle' && <LifecyclePane run={run} bucket={bucket} />}
        {tab === 'cors' && <CorsPane run={run} bucket={bucket} />}
      </div>
    </Modal>
  )
}

// ---------- Versioning ----------

function VersioningPane({
  run,
  bucket,
  onChanged
}: {
  run: Run
  bucket: string
  onChanged?: ((status: S3Versioning) => void) | undefined
}): React.JSX.Element {
  const { value, reload } = useFeature<S3Versioning>(run, { op: 'getVersioning', bucket })
  const [busy, setBusy] = useState(false)
  if (!value) return <Loading />
  if (value.state !== 'ok') return <FeatureNotice feature={value} />
  const status = value.value

  const change = async (enable: boolean): Promise<void> => {
    const ok = await confirmAction(
      enable
        ? {
            title: t('Enable versioning on “{bucket}”?', { bucket }),
            message: t(
              'Every overwrite and delete keeps the previous version, so you can restore it later. Old versions keep using storage until you delete them or a lifecycle rule expires them. Versioning can be suspended later, but never turned off completely.'
            ),
            confirmLabel: t('Enable versioning'),
            testId: 's3-versioning-confirm'
          }
        : {
            title: t('Suspend versioning on “{bucket}”?', { bucket }),
            message: t(
              'New overwrites and deletes no longer keep the previous version. Versions that already exist stay in the bucket until you delete them.'
            ),
            confirmLabel: t('Suspend versioning'),
            danger: true,
            testId: 's3-versioning-confirm'
          }
    )
    if (!ok) return
    setBusy(true)
    try {
      await run({ op: 'setVersioning', bucket, enabled: enable })
      toast.success(
        enable
          ? t('Versioning enabled on “{bucket}”', { bucket })
          : t('Versioning suspended on “{bucket}”', { bucket })
      )
      onChanged?.(enable ? 'Enabled' : 'Suspended')
      reload()
    } catch (e) {
      toast.error(t('Could not change versioning'), { description: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="s3-versioning">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted">{t('Status')}</span>
        <span data-testid="s3-versioning-status" data-status={status}>
          {/* Tên trạng thái của S3 (như AWS console) — giữ nguyên, không dịch. */}
          {status === 'Enabled' ? (
            <Pill tone="ok">Enabled</Pill>
          ) : status === 'Suspended' ? (
            <Pill tone="warn">Suspended</Pill>
          ) : (
            <Pill tone="muted">Disabled</Pill>
          )}
        </span>
      </div>
      <p className="text-xs text-muted">
        {status === 'Enabled'
          ? t(
              'Overwritten and deleted objects keep their previous versions. Use “Show versions” in the object list to restore or permanently delete them.'
            )
          : status === 'Suspended'
            ? t(
                'Versioning is suspended: existing versions are kept, but new changes replace the current object.'
              )
            : t(
                'Overwriting or deleting an object removes it for good. Turn on versioning to keep earlier versions you can restore.'
              )}
      </p>
      <div>
        {status === 'Enabled' ? (
          <Button
            variant="danger"
            disabled={busy}
            data-testid="s3-versioning-suspend"
            onClick={() => void change(false)}
          >
            {t('Suspend versioning…')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy}
            data-testid="s3-versioning-enable"
            onClick={() => void change(true)}
          >
            {t('Enable versioning…')}
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------- Lifecycle ----------

/** Các hành động của một rule → câu ngắn. */
export function ruleActions(rule: S3LifecycleRule): string[] {
  const out: string[] = []
  if (rule.expireDays !== null)
    out.push(
      tn(
        rule.expireDays,
        'Expire current versions after {n} day',
        'Expire current versions after {n} days'
      )
    )
  if (rule.noncurrentDays !== null)
    out.push(
      tn(
        rule.noncurrentDays,
        'Delete old versions {n} day after they become noncurrent',
        'Delete old versions {n} days after they become noncurrent'
      )
    )
  if (rule.abortMultipartDays !== null)
    out.push(
      tn(
        rule.abortMultipartDays,
        'Abort unfinished multipart uploads after {n} day',
        'Abort unfinished multipart uploads after {n} days'
      )
    )
  return out
}

const sameRules = (a: readonly S3LifecycleRule[], b: readonly S3LifecycleRule[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** Ô "sau N ngày" của form thêm rule. */
function DaysOption({
  label,
  checked,
  days,
  onCheck,
  onDays,
  testId
}: {
  label: string
  checked: boolean
  days: string
  onCheck: (checked: boolean) => void
  onDays: (days: string) => void
  testId: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        label={label}
        checked={checked}
        data-testid={`${testId}-on`}
        onChange={(e) => {
          onCheck(e.target.checked)
        }}
        className="min-w-0 flex-1"
      />
      <Input
        type="number"
        min={1}
        aria-label={t('Days')}
        disabled={!checked}
        data-testid={`${testId}-days`}
        className="h-7 w-20 text-xs"
        value={days}
        onChange={(e) => {
          onDays(e.target.value)
        }}
      />
      <span className="w-10 text-xs text-faint">{t('days')}</span>
    </div>
  )
}

function LifecyclePane({ run, bucket }: { run: Run; bucket: string }): React.JSX.Element {
  const { value, reload } = useFeature<S3LifecycleRule[]>(run, { op: 'getLifecycle', bucket })
  /** null = chưa sửa gì (dùng đúng cấu hình đã lưu). */
  const [edited, setDraft] = useState<S3LifecycleRule[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    id: '',
    prefix: '',
    expire: false,
    expireDays: '30',
    noncurrent: false,
    noncurrentDays: '30',
    abort: true,
    abortDays: '7'
  })

  if (!value) return <Loading />
  if (value.state !== 'ok') return <FeatureNotice feature={value} />
  const saved = value.value
  const draft = edited ?? saved
  const dirty = edited !== null && !sameRules(saved, edited)

  const candidate = {
    id: form.id.trim(),
    prefix: form.prefix.trim(),
    expireDays: form.expire ? Number(form.expireDays) : null,
    noncurrentDays: form.noncurrent ? Number(form.noncurrentDays) : null,
    abortMultipartDays: form.abort ? Number(form.abortDays) : null
  }
  const problem = adding ? lifecycleRuleProblem(candidate, draft) : null

  const add = (): void => {
    if (problem) return
    setDraft([
      ...draft,
      newLifecycleRule({ ...candidate, id: candidate.id || suggestRuleId(candidate.prefix, draft) })
    ])
    setAdding(false)
    setForm((f) => ({ ...f, id: '', prefix: '' }))
  }

  const save = async (): Promise<void> => {
    if (draft.length === 0 && saved.length > 0) {
      const ok = await confirmAction({
        title: t('Remove every lifecycle rule?'),
        message: t('Objects will no longer expire automatically in “{bucket}”.', { bucket }),
        confirmLabel: t('Remove rules'),
        danger: true
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await run({ op: 'putLifecycle', bucket, rules: draft })
      toast.success(t('Saved the lifecycle rules of “{bucket}”', { bucket }))
      setDraft(null)
      reload()
    } catch (e) {
      toast.error(t('Could not save the lifecycle rules'), { description: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="s3-lifecycle">
      <p className="text-xs text-muted">
        {t(
          'Rules run once a day on the provider side: they expire objects, clean up old versions and abort unfinished uploads that still cost storage.'
        )}
      </p>
      {draft.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
          {t('No lifecycle rules.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {draft.map((rule, i) => (
            <li
              key={`${rule.id}:${String(i)}`}
              className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2"
              data-testid="s3-lifecycle-rule"
              data-name={rule.id}
            >
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-[var(--sh-accent)]"
                aria-label={t('Rule enabled')}
                title={rule.enabled ? t('Enabled') : t('Disabled')}
                checked={rule.enabled}
                onChange={(e) => {
                  setDraft(draft.map((r, j) => (j === i ? { ...r, enabled: e.target.checked } : r)))
                }}
              />
              <div className="min-w-0 flex-1 text-xs">
                <p className="flex items-center gap-2">
                  <span className="truncate font-medium text-fg">{rule.id}</span>
                  {!rule.enabled && <Pill tone="muted">{t('Disabled')}</Pill>}
                </p>
                <p className="mt-0.5 text-faint">
                  {rule.prefix ? (
                    <>
                      {t('Prefix')} <span className="font-mono text-muted">{rule.prefix}</span>
                    </>
                  ) : (
                    t('All objects in the bucket')
                  )}
                </p>
                {ruleActions(rule).map((a) => (
                  <p key={a} className="text-muted">
                    · {a}
                  </p>
                ))}
                {rule.extra.length > 0 && (
                  <p className="mt-0.5 text-faint">
                    {t('Also: {parts} (kept as is)', { parts: rule.extra.join(', ') })}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={t('Delete rule “{name}”', { name: rule.id })}
                title={t('Delete rule')}
                className="rounded p-1 text-faint hover:bg-danger-soft hover:text-danger"
                onClick={() => {
                  setDraft(draft.filter((_, j) => j !== i))
                }}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="flex flex-col gap-2.5 rounded-md border border-accent/40 bg-subtle/50 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('Rule name (optional)')}>
              <Input
                mono
                className="h-7 text-xs"
                data-testid="s3-rule-id"
                placeholder={suggestRuleId(form.prefix, draft)}
                value={form.id}
                onChange={(e) => {
                  setForm({ ...form, id: e.target.value })
                }}
              />
            </Field>
            <Field label={t('Prefix filter')}>
              <Input
                mono
                className="h-7 text-xs"
                data-testid="s3-rule-prefix"
                placeholder={t('empty = all objects, e.g. logs/')}
                value={form.prefix}
                onChange={(e) => {
                  setForm({ ...form, prefix: e.target.value })
                }}
              />
            </Field>
          </div>
          <DaysOption
            label={t('Expire current versions after')}
            checked={form.expire}
            days={form.expireDays}
            testId="s3-rule-expire"
            onCheck={(expire) => {
              setForm({ ...form, expire })
            }}
            onDays={(expireDays) => {
              setForm({ ...form, expireDays })
            }}
          />
          <DaysOption
            label={t('Delete noncurrent versions after')}
            checked={form.noncurrent}
            days={form.noncurrentDays}
            testId="s3-rule-noncurrent"
            onCheck={(noncurrent) => {
              setForm({ ...form, noncurrent })
            }}
            onDays={(noncurrentDays) => {
              setForm({ ...form, noncurrentDays })
            }}
          />
          <DaysOption
            label={t('Abort incomplete multipart uploads after')}
            checked={form.abort}
            days={form.abortDays}
            testId="s3-rule-abort"
            onCheck={(abort) => {
              setForm({ ...form, abort })
            }}
            onDays={(abortDays) => {
              setForm({ ...form, abortDays })
            }}
          />
          {problem && <p className="text-xs text-danger">{problem}</p>}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={!!problem}
              data-testid="s3-rule-add"
              onClick={add}
            >
              {t('Add rule')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false)
              }}
            >
              {t('Cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            icon={<Plus size={13} />}
            data-testid="s3-rule-new"
            onClick={() => {
              setAdding(true)
            }}
          >
            {t('Add rule…')}
          </Button>
        </div>
      )}
      {dirty && (
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <span className="min-w-0 flex-1 text-xs text-warning">
            {t('Unsaved changes — rules are applied only when you save.')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(null)
            }}
          >
            {t('Discard')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            data-testid="s3-lifecycle-save"
            onClick={() => void save()}
          >
            {busy ? t('Saving…') : t('Save rules')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------- CORS ----------

const corsText = (rules: readonly S3CorsRule[]): string =>
  rules.length ? JSON.stringify(rules, null, 2) : ''

function CorsPane({ run, bucket }: { run: Run; bucket: string }): React.JSX.Element {
  const { value, reload } = useFeature<S3CorsRule[]>(run, { op: 'getCors', bucket })
  /** null = chưa sửa gì (hiện đúng cấu hình đã lưu). */
  const [edited, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!value) return <Loading />
  if (value.state !== 'ok') return <FeatureNotice feature={value} />
  const saved = corsText(value.value)
  const text = edited ?? saved
  const parsed = parseCorsJson(text)
  const dirty = text.trim() !== saved.trim()

  const save = async (rules: S3CorsRule[]): Promise<void> => {
    if (rules.length === 0 && value.value.length > 0) {
      const ok = await confirmAction({
        title: t('Remove the CORS configuration?'),
        message: t('Web pages on other sites can no longer read objects from “{bucket}”.', {
          bucket
        }),
        confirmLabel: t('Remove CORS'),
        danger: true
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await run({ op: 'putCors', bucket, rules })
      toast.success(t('Saved the CORS configuration of “{bucket}”', { bucket }))
      setText(null)
      reload()
    } catch (e) {
      toast.error(t('Could not save the CORS configuration'), { description: cleanError(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="s3-cors">
      <p className="text-xs text-muted">
        {t(
          'Lets web pages on other sites read or upload objects directly from the browser. JSON list of rules, the same format as the AWS console.'
        )}
      </p>
      <TextArea
        rows={14}
        spellCheck={false}
        aria-label={t('CORS rules (JSON)')}
        data-testid="s3-cors-json"
        placeholder={t(
          'No CORS rules — the bucket is only reachable from apps, not from browsers on other sites.'
        )}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      {!parsed.ok ? (
        <p className="text-xs text-danger" data-testid="s3-cors-error">
          {parsed.error}
        </p>
      ) : (
        <p className="text-xs text-faint">
          {parsed.rules.length
            ? tn(parsed.rules.length, '{n} rule', '{n} rules')
            : t('Empty — saving removes the CORS configuration.')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {!text.trim() && (
          <Button
            size="sm"
            onClick={() => {
              setText(corsText(CORS_TEMPLATE))
            }}
          >
            {t('Insert example')}
          </Button>
        )}
        {value.value.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="s3-cors-remove"
            onClick={() => void save([])}
          >
            {t('Remove CORS…')}
          </Button>
        )}
        <span className="flex-1" />
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(null)
            }}
          >
            {t('Discard')}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || !parsed.ok || busy}
          data-testid="s3-cors-save"
          onClick={() => {
            if (parsed.ok) void save(parsed.rules)
          }}
        >
          {busy ? t('Saving…') : t('Save CORS')}
        </Button>
      </div>
    </div>
  )
}
