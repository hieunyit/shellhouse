import { useEffect, useMemo, useState } from 'react'
import { Copy, Loader2, RotateCw } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { SEVERITIES, type ScanFinding, type ScanResult, type Severity } from '@shared/trivy'
import { cleanError } from '../lib/format'
import { toast } from '../stores/toasts'
import { Pill, type Tone } from './panels'
import { Button, Checkbox, cx, Input, Modal, Notice } from './ui'

const TONE: Record<Severity, Tone> = {
  CRITICAL: 'bad',
  HIGH: 'bad',
  MEDIUM: 'warn',
  LOW: 'info',
  UNKNOWN: 'muted'
}

const LABEL: Record<Severity, () => string> = {
  CRITICAL: () => t('Critical'),
  HIGH: () => t('High'),
  MEDIUM: () => t('Medium'),
  LOW: () => t('Low'),
  UNKNOWN: () => t('Unknown')
}

/** Hiện tối đa chừng này dòng một lúc (image có thể hàng nghìn CVE) — "Show all" mở hết. */
const PAGE = 300

function csvCell(v: string | number | undefined): string {
  const s = v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function findingsCsv(findings: readonly ScanFinding[]): string {
  const head = [
    'severity',
    'id',
    'subject',
    'installed',
    'fixed',
    'title',
    'resolution',
    'line',
    'target'
  ]
  const rows = findings.map((f) =>
    [f.severity, f.id, f.subject, f.installed, f.fixed, f.title, f.resolution, f.line, f.target]
      .map(csvCell)
      .join(',')
  )
  return [head.join(','), ...rows].join('\n')
}

/**
 * Hộp thoại kết quả quét (Trivy): chạy `run` khi mở, hiện tiến trình / lỗi / bảng phát hiện. Dùng
 * chung cho quét image (Docker) và quét cấu hình (K8s). Đóng hộp = huỷ lệnh đang chạy.
 */
export function ScanDialog({
  title,
  run,
  onClose
}: {
  title: string
  run: (signal: AbortSignal) => Promise<ScanResult>
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<
    | { phase: 'running' }
    | { phase: 'error'; message: string }
    | { phase: 'done'; result: ScanResult }
  >({ phase: 'running' })
  const [attempt, setAttempt] = useState(0)
  const [severity, setSeverity] = useState<Severity | null>(null)
  const [fixableOnly, setFixableOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  // Hộp thoại mở cho đúng một đối tượng — chốt hàm chạy lúc mở (không chạy lại mỗi lần vẽ).
  const [runner] = useState(() => run)

  useEffect(() => {
    const abort = new AbortController()
    runner(abort.signal).then(
      (result) => {
        if (!abort.signal.aborted) setState({ phase: 'done', result })
      },
      (e: unknown) => {
        if (!abort.signal.aborted) setState({ phase: 'error', message: cleanError(e) })
      }
    )
    return () => {
      abort.abort()
    }
  }, [attempt, runner])

  const result = state.phase === 'done' ? state.result : null
  const shown = useMemo(() => {
    if (!result) return []
    const q = query.trim().toLowerCase()
    return result.findings.filter(
      (f) =>
        (severity === null || f.severity === severity) &&
        (!fixableOnly || f.fixed !== undefined) &&
        (q === '' ||
          f.id.toLowerCase().includes(q) ||
          f.subject.toLowerCase().includes(q) ||
          f.title.toLowerCase().includes(q))
    )
  }, [result, severity, fixableOnly, query])
  const hasVulns = result?.findings.some((f) => f.kind === 'vulnerability') === true
  const rows = all ? shown : shown.slice(0, PAGE)
  const total = result ? SEVERITIES.reduce((n, s) => n + result.summary[s], 0) : 0

  return (
    <Modal
      title={title}
      onClose={onClose}
      width="max-w-5xl"
      testId="scan-dialog"
      footer={
        <>
          {result && (
            <Button
              variant="ghost"
              data-testid="scan-copy"
              onClick={() => {
                void window.shellhouse.writeClipboard(findingsCsv(shown))
                toast.success(t('Copied {n} rows as CSV', { n: shown.length }))
              }}
            >
              <Copy size={13} /> {t('Copy as CSV')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {state.phase === 'running' && (
          <div className="flex flex-col gap-2" data-testid="scan-running">
            <div className="flex items-center gap-2 text-muted">
              <Loader2 size={14} className="animate-spin" />
              {t('Scanning with Trivy…')}
            </div>
            <p className="text-xs text-faint">
              {t(
                'The first scan downloads Trivy’s vulnerability database, which can take a few minutes. Closing this window cancels the scan.'
              )}
            </p>
          </div>
        )}
        {state.phase === 'error' && (
          <div className="flex flex-col gap-2">
            <Notice tone="danger" testId="scan-error">
              {state.message}
            </Notice>
            <div>
              <Button
                variant="ghost"
                data-testid="scan-retry"
                onClick={() => {
                  setState({ phase: 'running' })
                  setAttempt((n) => n + 1)
                }}
              >
                <RotateCw size={13} /> {t('Try again')}
              </Button>
            </div>
          </div>
        )}
        {result && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="font-mono text-fg" data-testid="scan-target">
                {result.target}
              </span>
              {result.os && <span>{result.os}</span>}
              <span>{new Date(result.at).toLocaleTimeString()}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="scan-summary">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid={`scan-sev-${s}`}
                  data-count={result.summary[s]}
                  aria-pressed={severity === s}
                  disabled={result.summary[s] === 0}
                  className={cx(
                    'flex items-center gap-1.5 rounded-ds-md border px-2 py-1 text-xs transition-colors',
                    severity === s
                      ? 'border-accent bg-accent-soft text-fg'
                      : 'border-line text-muted hover:bg-hover disabled:opacity-40'
                  )}
                  onClick={() => {
                    setSeverity(severity === s ? null : s)
                  }}
                >
                  <Pill tone={TONE[s]}>{LABEL[s]()}</Pill>
                  <span className="font-medium tabular-nums text-fg">{result.summary[s]}</span>
                </button>
              ))}
              {hasVulns && (
                <Checkbox
                  label={tn(result.fixable, '{n} has a fix', '{n} have a fix')}
                  checked={fixableOnly}
                  data-testid="scan-fixable"
                  onChange={(e) => {
                    setFixableOnly(e.target.checked)
                  }}
                />
              )}
              <Input
                className="ml-auto w-56"
                placeholder={t('Filter…')}
                value={query}
                data-testid="scan-filter"
                onChange={(e) => {
                  setQuery(e.target.value)
                }}
              />
            </div>
            {total === 0 ? (
              <Notice tone="success" testId="scan-clean">
                {t('Nothing found.')}
              </Notice>
            ) : (
              <>
                <div
                  className="max-h-[50vh] overflow-auto rounded-md border border-line"
                  data-testid="scan-table"
                >
                  <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-subtle text-left text-faint">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">{t('Severity')}</th>
                        <th className="px-2 py-1.5 font-medium">{t('ID')}</th>
                        <th className="px-2 py-1.5 font-medium">
                          {hasVulns ? t('Package') : t('Rule')}
                        </th>
                        {hasVulns && (
                          <>
                            <th className="px-2 py-1.5 font-medium">{t('Installed')}</th>
                            <th className="px-2 py-1.5 font-medium">{t('Fixed in')}</th>
                          </>
                        )}
                        <th className="px-2 py-1.5 font-medium">{t('Details')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((f, i) => (
                        <tr
                          key={`${f.id}|${f.subject}|${String(i)}`}
                          data-testid="scan-row"
                          data-id={f.id}
                          data-severity={f.severity}
                          className="border-t border-line align-top"
                        >
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            <Pill tone={TONE[f.severity]}>{LABEL[f.severity]()}</Pill>
                          </td>
                          <td className="px-2 py-1.5 font-mono whitespace-nowrap text-fg">
                            {f.id}
                          </td>
                          <td className="px-2 py-1.5 text-fg">{f.subject}</td>
                          {hasVulns && (
                            <>
                              <td className="px-2 py-1.5 font-mono text-muted">
                                {f.installed ?? ''}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-muted">
                                {f.kind === 'vulnerability' ? (f.fixed ?? t('no fix yet')) : ''}
                              </td>
                            </>
                          )}
                          <td className="px-2 py-1.5 text-muted">
                            {f.title}
                            {f.resolution && (
                              <div className="mt-0.5 text-faint">{f.resolution}</div>
                            )}
                            {f.line !== undefined && (
                              <div className="mt-0.5 text-faint">
                                {t('line {n}', { n: f.line })}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center gap-3 text-xs text-faint">
                  <span data-testid="scan-count">
                    {tn(shown.length, '{n} finding', '{n} findings')}
                  </span>
                  {!all && shown.length > PAGE && (
                    <Button
                      variant="ghost"
                      data-testid="scan-show-all"
                      onClick={() => {
                        setAll(true)
                      }}
                    >
                      {t('Show all')}
                    </Button>
                  )}
                  {result.truncated && (
                    <span>{t('The list is cut — the counts above are complete.')}</span>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
