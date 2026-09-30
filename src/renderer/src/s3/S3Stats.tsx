import { useEffect, useRef, useState } from 'react'
import { addStats, type S3Op, type S3StatsPage } from '@shared/s3'
import { Button, cx, Modal } from '../components/ui'
import { cleanError, formatSize } from './format'

/** Một dòng cần thống kê: cả bucket (prefix '') hoặc một "thư mục". */
export interface StatsTarget {
  bucket: string
  prefix: string
  label: string
}

type RowState = 'waiting' | 'running' | 'done' | 'stopped' | 'error'

interface Row {
  total: S3StatsPage
  state: RowState
  error: string | null
}

const EMPTY: S3StatsPage = { objects: 0, bytes: 0, byClass: {}, next: null }

/**
 * Thống kê số object + dung lượng (như "Bucket size" của S3 Browser). S3 không có API cho con số
 * này nên phải liệt kê toàn bộ object: quét từng đợt, cập nhật dần, dừng được bất cứ lúc nào.
 */
export function S3StatsDialog({
  targets,
  run,
  onClose
}: {
  targets: StatsTarget[]
  run: (op: S3Op) => Promise<unknown>
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>(() =>
    targets.map((_, i) => ({ total: EMPTY, state: i === 0 ? 'running' : 'waiting', error: null }))
  )
  const [scanning, setScanning] = useState(true)
  const stopRef = useRef(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    stopRef.current = false
    const life = { alive: true }
    // Hàm (không phải biến): TS không thu hẹp kiểu qua các lần await.
    const stopped = (): boolean => stopRef.current || !life.alive
    const patch = (i: number, change: Partial<Row>): void => {
      if (life.alive) setRows((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)))
    }
    void (async () => {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]
        if (!target) continue
        if (stopped()) {
          patch(i, { state: 'stopped' })
          continue
        }
        if (i > 0) patch(i, { state: 'running' })
        let total = EMPTY
        let token: string | undefined
        try {
          do {
            const page = (await run({
              op: 'stats',
              bucket: target.bucket,
              prefix: target.prefix,
              ...(token ? { token } : {})
            })) as S3StatsPage
            total = addStats(total, page)
            token = page.next ?? undefined
            patch(i, { total })
          } while (token && !stopped())
          patch(i, { state: token ? 'stopped' : 'done' })
        } catch (e) {
          patch(i, { state: 'error', error: cleanError(e) })
        }
      }
      if (life.alive) setScanning(false)
    })()
    return () => {
      life.alive = false
    }
  }, [targets, run, generation])

  const sum = rows.reduce((acc, r) => addStats(acc, r.total), EMPTY)
  const partial = rows.some((r) => r.state === 'stopped' || r.state === 'error')

  return (
    <Modal
      title={targets.length > 1 ? 'Bucket statistics' : `Size of ${targets[0]?.label ?? ''}`}
      description="Counts every current object (old versions and unfinished multipart uploads are not included)."
      onClose={onClose}
      width="max-w-2xl"
      testId="s3-stats"
      footer={
        <>
          {scanning ? (
            <Button
              data-testid="s3-stats-stop"
              onClick={() => {
                stopRef.current = true
              }}
            >
              Stop
            </Button>
          ) : (
            <Button
              onClick={() => {
                setRows(
                  targets.map((_, i) => ({
                    total: EMPTY,
                    state: i === 0 ? 'running' : 'waiting',
                    error: null
                  }))
                )
                setScanning(true)
                setGeneration((g) => g + 1)
              }}
            >
              Recalculate
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] overflow-auto" role="table" aria-label="Statistics">
        <div
          role="row"
          className="sticky top-0 grid grid-cols-[1fr_7rem_7rem_6rem] gap-2 border-b border-line bg-surface py-1.5 text-[11px] font-medium text-faint"
        >
          <span role="columnheader">{targets.length > 1 ? 'Bucket' : 'Location'}</span>
          <span role="columnheader" className="text-right">
            Objects
          </span>
          <span role="columnheader" className="text-right">
            Size
          </span>
          <span role="columnheader" className="text-right">
            Status
          </span>
        </div>
        {targets.map((t, i) => {
          const row = rows[i]
          if (!row) return null
          const classes = Object.entries(row.total.byClass).sort((a, b) => b[1].bytes - a[1].bytes)
          const showClasses =
            classes.length > 1 || (classes.length === 1 && classes[0]?.[0] !== 'STANDARD')
          return (
            <div
              key={`${t.bucket}/${t.prefix}`}
              role="row"
              data-testid="s3-stats-row"
              data-name={t.label}
              data-state={row.state}
              className="border-b border-line/60 py-1.5 text-[13px]"
            >
              <div className="grid grid-cols-[1fr_7rem_7rem_6rem] items-center gap-2">
                <span role="cell" className="truncate font-mono text-xs" title={t.label}>
                  {t.label}
                </span>
                <span
                  role="cell"
                  className="text-right tabular-nums"
                  data-testid="s3-stats-objects"
                >
                  {row.total.objects.toLocaleString('en-US')}
                </span>
                <span role="cell" className="text-right tabular-nums" data-testid="s3-stats-size">
                  {formatSize(row.total.bytes)}
                </span>
                <span
                  role="cell"
                  className={cx(
                    'text-right text-xs',
                    row.state === 'error' ? 'text-danger' : 'text-faint'
                  )}
                >
                  {row.state === 'running' && 'Counting…'}
                  {row.state === 'waiting' && 'Waiting'}
                  {row.state === 'done' && 'Done'}
                  {row.state === 'stopped' && 'Stopped'}
                  {row.state === 'error' && 'Failed'}
                </span>
              </div>
              {showClasses && (
                <p className="mt-0.5 text-[11px] text-faint">
                  {classes
                    .map(
                      ([cls, v]) =>
                        `${cls}: ${v.objects.toLocaleString('en-US')} · ${formatSize(v.bytes)}`
                    )
                    .join('   ')}
                </p>
              )}
              {row.error && <p className="mt-0.5 text-xs text-danger">{row.error}</p>}
            </div>
          )
        })}
        {targets.length > 1 && (
          <div
            className="grid grid-cols-[1fr_7rem_7rem_6rem] gap-2 py-2 text-[13px] font-semibold"
            data-testid="s3-stats-total"
          >
            <span>Total{partial ? ' (incomplete)' : ''}</span>
            <span className="text-right tabular-nums">{sum.objects.toLocaleString('en-US')}</span>
            <span className="text-right tabular-nums">{formatSize(sum.bytes)}</span>
            <span />
          </div>
        )}
      </div>
    </Modal>
  )
}
