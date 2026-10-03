import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Square } from 'lucide-react'
import type { S3BulkJob, S3JobProgress, S3Op } from '../shared/ops'
import { cx } from '../../../renderer/src/components/ui'
import { formatNumber, t, tn } from '../../registry/renderer-kit'
import { cleanError } from './format'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface RunningJob {
  id: string
  /** "Deleting “logs”", "Moving 3 items to backups/"… */
  label: string
  /** Loại việc cho số đã xong: "deleted", "copied", "moved". */
  verb: string
  progress: S3JobProgress | null
}

/** Câu tóm tắt lỗi của một việc nền (lỗi chặn, hoặc số object lỗi + vài key đầu). */
export function jobErrorText(label: string, p: S3JobProgress): string | null {
  if (p.error) return `${label}: ${p.error}`
  if (p.failed === 0) return null
  const first = p.errors
    .slice(0, 3)
    .map((e) => `${e.key} (${e.message})`)
    .join(', ')
  const more = p.failed > 3 ? t(', and {n} more', { n: formatNumber(p.failed - 3) }) : ''
  return `${label}: ${tn(p.failed, '{n} object failed — {detail}', '{n} objects failed — {detail}', { detail: `${first}${more}` })}`
}

/** "12 deleted" / "12 deleted of 40" theo loại việc. */
function doneText(verb: string, done: number, total: number | null): string {
  const n = formatNumber(done)
  if (total === null)
    return verb === 'deleted'
      ? t('{n} deleted', { n })
      : verb === 'moved'
        ? t('{n} moved', { n })
        : t('{n} copied', { n })
  const params = { n, total: formatNumber(total) }
  return verb === 'deleted'
    ? t('{n} deleted of {total}', params)
    : verb === 'moved'
      ? t('{n} moved of {total}', params)
      : t('{n} copied of {total}', params)
}

/**
 * Xoá / copy / move / đổi tên chạy nền trong Session Host; giao diện chỉ hỏi tiến độ (~3 lần / giây)
 * và hiện một dòng có nút Stop — không chặn cả tab bằng hộp thoại.
 */
export function useBulkJobs(
  run: (op: S3Op) => Promise<unknown>,
  onFinished: (job: RunningJob, progress: S3JobProgress) => void
): {
  jobs: RunningJob[]
  start: (job: S3BulkJob, label: string, verb: string) => Promise<void>
  stop: (id: string) => void
} {
  const [jobs, setJobs] = useState<RunningJob[]>([])
  const alive = useRef(true)
  const isAlive = (): boolean => alive.current
  const finished = useRef(onFinished)
  useEffect(() => {
    finished.current = onFinished
  })

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const start = useCallback(
    async (spec: S3BulkJob, label: string, verb: string): Promise<void> => {
      const id = (await run({ op: 'jobStart', job: spec })) as string
      const entry: RunningJob = { id, label, verb, progress: null }
      setJobs((all) => [...all, entry])
      try {
        for (let wait = 100; ; wait = Math.min(400, wait * 2)) {
          await sleep(wait)
          if (!isAlive()) return
          const p = (await run({ op: 'jobPoll', id })) as S3JobProgress
          if (!isAlive()) return
          setJobs((all) => all.map((j) => (j.id === id ? { ...j, progress: p } : j)))
          if (p.phase !== 'running') {
            finished.current(entry, p)
            return
          }
        }
      } catch (e) {
        if (isAlive())
          finished.current(entry, {
            phase: 'error',
            found: 0,
            done: 0,
            failed: 0,
            scanning: false,
            errors: [],
            error: cleanError(e)
          })
      } finally {
        if (isAlive()) setJobs((all) => all.filter((j) => j.id !== id))
      }
    },
    [run]
  )

  const stop = useCallback(
    (id: string): void => {
      void run({ op: 'jobStop', id }).catch(() => undefined)
    },
    [run]
  )

  return { jobs, start, stop }
}

/** Các việc nền đang chạy (trên danh sách Transfers). */
export function JobsPanel({
  jobs,
  onStop
}: {
  jobs: RunningJob[]
  onStop: (id: string) => void
}): React.JSX.Element | null {
  if (jobs.length === 0) return null
  return (
    <div className="shrink-0 border-t border-line bg-surface px-1.5 py-1" data-testid="s3-jobs">
      {jobs.map((j) => {
        const p = j.progress
        const total = p && !p.scanning ? p.found : null
        const pct = total ? Math.min(100, Math.floor(((p?.done ?? 0) / total) * 100)) : null
        return (
          <div
            key={j.id}
            className="flex h-7 items-center gap-2 px-1 text-xs"
            data-testid="s3-job"
            data-phase={p?.phase ?? 'running'}
          >
            <RefreshCw size={12} className="shrink-0 animate-spin text-faint" />
            <span className="min-w-0 flex-1 truncate text-fg">{j.label}</span>
            <span className={cx('shrink-0 tabular-nums', p?.failed ? 'text-danger' : 'text-muted')}>
              {p
                ? [
                    doneText(j.verb, p.done, total),
                    total === null && p.found ? t('{n} found', { n: formatNumber(p.found) }) : '',
                    p.failed ? t('{n} failed', { n: formatNumber(p.failed) }) : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('Starting…')}
            </span>
            {pct !== null && (
              <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-subtle">
                <span
                  className="block h-full rounded-full bg-accent-solid"
                  style={{ width: `${pct}%` }}
                />
              </span>
            )}
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-danger"
              data-testid="s3-job-stop"
              onClick={() => {
                onStop(j.id)
              }}
            >
              <Square size={10} /> {t('Stop')}
            </button>
          </div>
        )
      })}
    </div>
  )
}
