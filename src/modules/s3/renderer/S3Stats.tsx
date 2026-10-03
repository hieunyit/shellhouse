import { useEffect, useRef, useState } from 'react'
import { addStats, EMPTY_STATS, type S3Op, type S3Stats } from '../shared/ops'
import { Button, cx, Modal } from '../../../renderer/src/components/ui'
import { formatNumber, t } from '../../registry/renderer-kit'
import { cleanError, formatSize } from './format'
import { eachLimit, runStatsJob } from './stats-job'

/** Một dòng cần thống kê: cả bucket (prefix '') hoặc một "thư mục". */
export interface StatsTarget {
  bucket: string
  prefix: string
  label: string
}

type RowState = 'waiting' | 'running' | 'done' | 'stopped' | 'error'

interface Row {
  total: S3Stats
  state: RowState
  error: string | null
}

/** Số dòng đếm cùng lúc (mỗi dòng bên Session Host còn tự quét song song nhiều request). */
const PARALLEL_TARGETS = 3

const initialRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    total: EMPTY_STATS,
    state: i < PARALLEL_TARGETS ? 'running' : 'waiting',
    error: null
  }))

/**
 * Thống kê số object + dung lượng (như "Bucket size" của S3 Browser). S3 không có API cho con số
 * này nên phải liệt kê toàn bộ object: quét song song bên Session Host, cập nhật dần, dừng được.
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
  const [rows, setRows] = useState<Row[]>(() => initialRows(targets.length))
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
      await eachLimit(
        targets.map((target, i) => ({ target, i })),
        PARALLEL_TARGETS,
        async ({ target, i }) => {
          if (stopped()) {
            patch(i, { state: 'stopped' })
            return
          }
          patch(i, { state: 'running' })
          try {
            const { result, stopped: wasStopped } = await runStatsJob(
              run,
              target.bucket,
              target.prefix,
              (p) => {
                patch(i, { total: p })
              },
              stopped
            )
            patch(i, {
              total: result,
              state: result.error ? 'error' : wasStopped ? 'stopped' : 'done',
              error: result.error
            })
          } catch (e) {
            patch(i, { state: 'error', error: cleanError(e) })
          }
        }
      )
      if (life.alive) setScanning(false)
    })()
    return () => {
      life.alive = false
    }
  }, [targets, run, generation])

  const sum = rows.reduce((acc, r) => addStats(acc, r.total), EMPTY_STATS)
  const partial = rows.some((r) => r.state === 'stopped' || r.state === 'error')

  return (
    <Modal
      title={
        targets.length > 1
          ? t('Bucket statistics')
          : t('Size of {name}', { name: targets[0]?.label ?? '' })
      }
      description={t(
        'Counts every current object (old versions and unfinished multipart uploads are not included).'
      )}
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
              {t('Stop')}
            </Button>
          ) : (
            <Button
              onClick={() => {
                setRows(initialRows(targets.length))
                setScanning(true)
                setGeneration((g) => g + 1)
              }}
            >
              {t('Recalculate')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] overflow-auto" role="table" aria-label={t('Statistics')}>
        <div
          role="row"
          className="sticky top-0 grid grid-cols-[1fr_7rem_7rem_6rem] gap-2 border-b border-line bg-surface py-1.5 text-xs font-medium text-faint"
        >
          <span role="columnheader">{targets.length > 1 ? t('Bucket') : t('Location')}</span>
          <span role="columnheader" className="text-right">
            {t('Objects')}
          </span>
          <span role="columnheader" className="text-right">
            {t('Size')}
          </span>
          <span role="columnheader" className="text-right">
            {t('Status')}
          </span>
        </div>
        {targets.map((target, i) => {
          const row = rows[i]
          if (!row) return null
          const classes = Object.entries(row.total.byClass).sort((a, b) => b[1].bytes - a[1].bytes)
          const showClasses =
            classes.length > 1 || (classes.length === 1 && classes[0]?.[0] !== 'STANDARD')
          return (
            <div
              key={`${target.bucket}/${target.prefix}`}
              role="row"
              data-testid="s3-stats-row"
              data-name={target.label}
              data-state={row.state}
              className="border-b border-line/60 py-1.5 text-[13px]"
            >
              <div className="grid grid-cols-[1fr_7rem_7rem_6rem] items-center gap-2">
                <span role="cell" className="truncate font-mono text-xs" title={target.label}>
                  {target.label}
                </span>
                <span
                  role="cell"
                  className="text-right tabular-nums"
                  data-testid="s3-stats-objects"
                >
                  {formatNumber(row.total.objects)}
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
                  {row.state === 'running' && t('Counting…')}
                  {row.state === 'waiting' && t('Waiting')}
                  {row.state === 'done' && t('Done')}
                  {row.state === 'stopped' && t('Stopped')}
                  {row.state === 'error' && t('Failed')}
                </span>
              </div>
              {showClasses && (
                <p className="mt-0.5 text-xs text-faint">
                  {classes
                    .map(
                      ([cls, v]) => `${cls}: ${formatNumber(v.objects)} · ${formatSize(v.bytes)}`
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
            <span>{partial ? t('Total (incomplete)') : t('Total')}</span>
            <span className="text-right tabular-nums">{formatNumber(sum.objects)}</span>
            <span className="text-right tabular-nums">{formatSize(sum.bytes)}</span>
            <span />
          </div>
        )}
      </div>
    </Modal>
  )
}
