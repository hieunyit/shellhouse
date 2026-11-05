import { useEffect, useRef, useState } from 'react'
import { newTaskRun } from './task-records'
import { ArrowRight, FileDown, RefreshCw } from 'lucide-react'
import {
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  Notice,
  Segmented,
  Select
} from '../../../renderer/src/components/ui'
import { Pill, type Tone } from '../../../renderer/src/components/panels'
import {
  bucketNameProblem,
  type S3AccountSummary,
  type S3Bucket,
  type S3BucketInfo,
  type S3Op,
  type S3SyncProgress,
  type SyncAction
} from '../shared/ops'
import { bucketsToCsv, bucketsToJson, type BucketExportRow } from '../shared/sync'
import type { BucketStats } from './S3BucketTable'
import { cleanError, formatSize } from './format'
import { eachLimit } from './stats-job'
import {
  confirmAction,
  formatDateTimeSeconds,
  formatDuration,
  formatNumber,
  formatRate,
  t,
  tn
} from '../../registry/renderer-kit'

type Run = (op: S3Op) => Promise<unknown>

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------- Export danh sách bucket ----------

/** Tên file gợi ý: "prod-eu-buckets-2026-10-01.csv". */
function exportName(account: string, format: 'csv' | 'json'): string {
  const slug =
    account
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 's3'
  return `${slug}-buckets-${new Date().toISOString().slice(0, 10)}.${format}`
}

/**
 * Export danh sách bucket của tài khoản (CSV mở bằng Excel / JSON): tên, region, ngày tạo; tuỳ
 * chọn số object + dung lượng (dùng lại số đã tính, đếm phần còn thiếu) và versioning / mã hoá.
 */
export function ExportBucketsDialog({
  account,
  buckets,
  stats,
  run,
  calculate,
  stop,
  onClose
}: {
  account: string
  buckets: S3Bucket[]
  stats: Readonly<Record<string, BucketStats>>
  run: Run
  /** Đếm các bucket chưa có số; trả về số của mọi bucket đã đếm. */
  calculate: (names: readonly string[]) => Promise<Record<string, BucketStats>>
  stop: () => void
  onClose: () => void
}): React.JSX.Element {
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [sizes, setSizes] = useState(true)
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const missing = buckets.filter((b) => stats[b.name]?.state !== 'done')

  const submit = async (): Promise<void> => {
    setError(null)
    const path = await window.shellhouse.pickSaveLocation(exportName(account, format))
    if (!path) return
    try {
      let counted: Record<string, BucketStats> = { ...stats }
      if (sizes && missing.length) {
        setBusy(
          tn(missing.length, 'Counting objects in {n} bucket…', 'Counting objects in {n} buckets…')
        )
        counted = { ...counted, ...(await calculate(missing.map((b) => b.name))) }
      }
      const infos: Record<string, S3BucketInfo> = {}
      if (details) {
        let done = 0
        setBusy(t('Reading bucket settings {done}/{total}…', { done: 0, total: buckets.length }))
        await eachLimit(buckets, 6, async (b) => {
          infos[b.name] = (await run({ op: 'bucketInfo', bucket: b.name }).catch(
            () => null
          )) as S3BucketInfo
          done++
          setBusy(t('Reading bucket settings {done}/{total}…', { done, total: buckets.length }))
        })
      }
      const rows: BucketExportRow[] = buckets.map((b) => {
        const s = counted[b.name]
        const ok = s?.state === 'done'
        return {
          bucket: b,
          objects: ok ? s.objects : null,
          bytes: ok ? s.bytes : null,
          info: infos[b.name] ?? null
        }
      })
      const options = { sizes, details }
      const content =
        format === 'csv'
          ? bucketsToCsv(account, rows, options)
          : bucketsToJson(account, rows, options)
      setBusy(t('Saving…'))
      await window.shellhouse.writeChosenFile(path, content)
      setSaved(path)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title={t('Export bucket list')}
      description={tn(buckets.length, '{n} bucket in {account}', '{n} buckets in {account}', {
        account
      })}
      onClose={() => {
        if (busy) stop()
        onClose()
      }}
      width="max-w-md"
      testId="s3-export-dialog"
      footer={
        saved ? (
          <Button variant="primary" onClick={onClose}>
            {t('Done')}
          </Button>
        ) : (
          <>
            {busy ? (
              <Button onClick={stop}>{t('Stop')}</Button>
            ) : (
              <Button onClick={onClose}>{t('Cancel')}</Button>
            )}
            <Button
              variant="primary"
              icon={<FileDown size={13} />}
              disabled={busy !== null}
              data-testid="s3-export-submit"
              onClick={() => void submit()}
            >
              {busy ? t('Exporting…') : t('Export…')}
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <Notice tone="success" testId="s3-export-done">
          {tn(buckets.length, 'Saved {n} bucket to', 'Saved {n} buckets to')}{' '}
          <span className="font-mono break-all">{saved}</span>
        </Notice>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label={t('Format')}>
            <div className="self-start">
              <Segmented
                value={format}
                onChange={setFormat}
                testIdPrefix="s3-export-format"
                options={[
                  { value: 'csv', label: 'CSV (Excel)' },
                  { value: 'json', label: 'JSON' }
                ]}
              />
            </div>
          </Field>
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              {t('Always included: bucket name, region, created date.')}
            </p>
            <Checkbox
              label={t('Object count and total size')}
              data-testid="s3-export-sizes"
              description={
                missing.length === 0
                  ? t('Already calculated for every bucket.')
                  : tn(
                      missing.length,
                      'Counts every object in {n} bucket not counted yet — large buckets take a while.',
                      'Counts every object in {n} buckets not counted yet — large buckets take a while.'
                    )
              }
              checked={sizes}
              onChange={(e) => {
                setSizes(e.target.checked)
              }}
            />
            <Checkbox
              label={t('Versioning and encryption')}
              data-testid="s3-export-details"
              description={t(
                'One request per bucket. Shown empty where the service does not support it.'
              )}
              checked={details}
              onChange={(e) => {
                setDetails(e.target.checked)
              }}
            />
          </div>
          {busy && (
            <p className="flex items-center gap-2 text-xs text-muted" data-testid="s3-export-busy">
              <RefreshCw size={12} className="animate-spin" /> {busy}
            </p>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      )}
    </Modal>
  )
}

// ---------- Đồng bộ ----------

const ACTION_TONE: Record<SyncAction, Tone> = { new: 'ok', update: 'info', delete: 'bad' }

function actionLabel(action: SyncAction): string {
  return action === 'new' ? t('new') : action === 'update' ? t('changed') : t('delete')
}

function phaseLabel(phase: S3SyncProgress['phase']): string {
  switch (phase) {
    case 'scanning':
      return t('Comparing…')
    case 'planned':
      return t('Preview')
    case 'copying':
      return t('Copying…')
    case 'deleting':
      return t('Deleting extra objects…')
    case 'waiting':
      return t('Waiting for the next sync')
    case 'done':
      return t('Finished')
    case 'stopped':
      return t('Stopped')
    case 'error':
      return t('Failed')
  }
}

/** Hiện ngay khi bấm (trước lần hỏi tiến độ đầu) — không nháy lại form. */
function startingProgress(
  dryRun: boolean,
  serverSide: boolean,
  intervalSeconds?: number,
  strategy: 'lookup' | 'inventory' = 'lookup'
): S3SyncProgress {
  return {
    phase: 'scanning',
    dryRun,
    serverSide,
    scanned: { source: 0, dest: 0 },
    strategy,
    listing: strategy === 'lookup',
    plan: { new: 0, update: 0, delete: 0, same: 0, bytes: 0 },
    done: { copied: 0, deleted: 0, bytes: 0, failed: 0 },
    bytesPerSecond: 0,
    concurrency: 0,
    active: [],
    sample: [],
    errors: [],
    error: null,
    ...(intervalSeconds === undefined
      ? {}
      : {
          continuous: {
            intervalSeconds,
            round: 1,
            completedRounds: 0,
            nextRunAt: null,
            totals: { copied: 0, deleted: 0, bytes: 0, failed: 0 }
          }
        })
  }
}

/** Thời gian còn lại theo tốc độ đã làm mượt: "3m 12s", "1h 20m"; chưa đủ dữ liệu → null. */
function eta(p: S3SyncProgress): string | null {
  if (p.bytesPerSecond <= 0 || p.plan.bytes <= p.done.bytes) return null
  const ms = ((p.plan.bytes - p.done.bytes) / p.bytesPerSecond) * 1000
  return formatDuration(Math.max(1000, ms))
}

export interface SyncSource {
  bucket: string
  prefix: string
}

/**
 * Đồng bộ một bucket / thư mục sang chỗ khác — cùng tài khoản (copy trên server) hoặc tài khoản S3
 * khác (kể cả nhà cung cấp khác: AWS → R2, MinIO → Wasabi…). Luôn có thể xem trước; chế độ Mirror
 * (xoá ở đích) bắt buộc xem trước để thấy số object sẽ bị xoá.
 */
export function SyncDialog({
  accountId,
  accounts,
  buckets,
  source,
  run,
  onClose,
  hidden = false,
  onBackground,
  onProgress,
  onFinished
}: {
  accountId: string
  accounts: S3AccountSummary[]
  buckets: S3Bucket[]
  source: SyncSource
  run: Run
  onClose: () => void
  hidden?: boolean
  onBackground: () => void
  onProgress: (
    progress: S3SyncProgress,
    destination: string,
    operation: { id: string; startedAt: number; stop: () => void }
  ) => void
  /** Đã ghi vào đích (để làm mới danh sách nếu đích là tài khoản này). */
  onFinished: (destAccountId: string) => void
}): React.JSX.Element {
  const [destAccount, setDestAccount] = useState(accountId)
  const [destBuckets, setDestBuckets] = useState<S3Bucket[] | null>(buckets)
  const [destBucket, setDestBucket] = useState('')
  const [destPrefix, setDestPrefix] = useState(source.prefix)
  const [mode, setMode] = useState<'copy' | 'mirror'>('copy')
  const [compare, setCompare] = useState<'etag' | 'size'>('etag')
  const [strategy, setStrategy] = useState<'lookup' | 'inventory'>('lookup')
  /** 0 = theo cài đặt (Settings → Modules → S3 storage). */
  const [threads, setThreads] = useState(0)
  const [continuous, setContinuous] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(300)
  const [progress, setProgress] = useState<S3SyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const jobId = useRef<string | null>(null)
  const stopRequested = useRef(false)
  const shouldStop = (): boolean => stopRequested.current
  const alive = useRef(true)
  /** Hàm (không đọc thẳng): TS không thu hẹp kiểu ref qua các lần await. */
  const isAlive = (): boolean => alive.current
  const sameAccount = destAccount === accountId
  const sourceName = accounts.find((a) => a.id === accountId)?.name ?? t('this account')

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (jobId.current) void run({ op: 'syncStop', id: jobId.current }).catch(() => undefined)
    }
  }, [run])

  // Bucket của tài khoản đích (gợi ý + biết có cần tạo bucket không).
  const pickAccount = (id: string): void => {
    setDestAccount(id)
    setDestBucket('')
    if (id === accountId) {
      setDestBuckets(buckets)
      return
    }
    setDestBuckets(null)
    run({ op: 'listBucketsOf', accountId: id }).then(
      (list) => {
        if (alive.current) setDestBuckets(list as S3Bucket[])
      },
      (e: unknown) => {
        if (!alive.current) return
        setDestBuckets([])
        setError(t('Could not list the buckets of that account: {error}', { error: cleanError(e) }))
      }
    )
  }

  const bucketName = destBucket.trim()
  const known = destBuckets?.some((b) => b.name === bucketName) ?? false
  const willCreate = destBuckets !== null && bucketName !== '' && !known
  const problem = !bucketName
    ? t('Choose a destination bucket')
    : willCreate
      ? bucketNameProblem(bucketName)
      : null
  const running =
    progress?.phase === 'scanning' ||
    progress?.phase === 'copying' ||
    progress?.phase === 'deleting' ||
    progress?.phase === 'waiting'

  const stop = (): void => {
    stopRequested.current = true
    if (jobId.current) void run({ op: 'syncStop', id: jobId.current }).catch(() => undefined)
  }

  /** `maxDelete`: chạy thật sau khi xem trước — không cho xoá nhiều hơn số đã thấy. */
  const start = async (dryRun: boolean, maxDelete?: number): Promise<void> => {
    setError(null)
    stopRequested.current = false
    const initial = startingProgress(
      dryRun,
      sameAccount,
      continuous && !dryRun ? intervalSeconds : undefined,
      mode === 'mirror' ? 'inventory' : strategy
    )
    let last = initial
    let refreshed = 0
    const operation = { ...newTaskRun(), stop }
    setProgress(initial)
    onProgress(initial, destLabel, operation)
    try {
      const id = (await run({
        op: 'syncStart',
        bucket: source.bucket,
        prefix: source.prefix,
        dest: {
          ...(sameAccount ? {} : { accountId: destAccount }),
          bucket: bucketName,
          prefix: destPrefix.trim()
        },
        mirror: mode === 'mirror',
        compare,
        ...(threads ? { concurrency: threads } : {}),
        createBucket: willCreate,
        dryRun,
        strategy: mode === 'mirror' ? 'inventory' : strategy,
        ...(continuous && !dryRun ? { intervalSeconds } : {}),
        ...(maxDelete !== undefined ? { maxDelete } : {})
      })) as string
      if (!isAlive()) {
        void run({ op: 'syncStop', id }).catch(() => undefined)
        return
      }
      jobId.current = id
      if (shouldStop()) void run({ op: 'syncStop', id }).catch(() => undefined)
      // Hỏi sớm (bucket nhỏ xong ngay), rồi đều đặn ~3 lần / giây cho thanh tiến độ mượt.
      for (
        let wait = 100;
        alive.current && jobId.current === id;
        wait = last.phase === 'waiting' ? 1000 : Math.min(300, wait * 2)
      ) {
        await sleep(wait)
        if (!isAlive() || jobId.current !== id) return
        const p = (await run({ op: 'syncPoll', id })) as S3SyncProgress
        if (!isAlive()) return
        last = p
        setProgress(p)
        onProgress(p, destLabel, operation)
        const changed = p.continuous
          ? p.continuous.totals.copied + p.continuous.totals.deleted
          : p.done.copied + p.done.deleted
        const roundFinished =
          p.phase === 'waiting' ||
          p.phase === 'done' ||
          p.phase === 'stopped' ||
          p.phase === 'error'
        if (!dryRun && roundFinished && changed > refreshed) {
          refreshed = changed
          onFinished(destAccount)
        }
        if (
          p.phase !== 'scanning' &&
          p.phase !== 'copying' &&
          p.phase !== 'deleting' &&
          p.phase !== 'waiting'
        ) {
          jobId.current = null
          return
        }
      }
    } catch (e) {
      if (jobId.current) void run({ op: 'syncStop', id: jobId.current }).catch(() => undefined)
      jobId.current = null
      if (alive.current) {
        const failed = {
          ...last,
          phase: 'error' as const,
          error: cleanError(e)
        }
        setProgress(failed)
        onProgress(failed, destLabel, operation)
        setError(cleanError(e))
      }
    }
  }

  const close = (): void => {
    if (running) onBackground()
    else onClose()
  }

  const p = progress
  const toCopy = p ? p.plan.new + p.plan.update : 0
  const copiedOrFailed = p ? p.done.copied + p.done.failed : 0
  const fraction =
    p && p.plan.bytes > 0
      ? Math.min(1, p.done.bytes / p.plan.bytes)
      : toCopy
        ? copiedOrFailed / toCopy
        : 0
  const planned = p?.phase === 'planned'
  const finished = p?.phase === 'done' || p?.phase === 'stopped' || p?.phase === 'error'
  const destLabel = `${sameAccount ? '' : `${accounts.find((a) => a.id === destAccount)?.name ?? ''}: `}s3://${bucketName}/${destPrefix.trim()}`

  if (hidden) return <></>
  return (
    <Modal
      title={t('Sync')}
      description={
        <>
          <span className="font-mono">
            s3://{source.bucket}/{source.prefix}
          </span>{' '}
          {t('in {account}', { account: sourceName })}
        </>
      }
      onClose={close}
      width="max-w-2xl"
      testId="s3-sync-dialog"
      footer={
        p === null && !running ? (
          <>
            <Button onClick={close}>{t('Cancel')}</Button>
            <Button
              disabled={!!problem || destBuckets === null}
              data-testid="s3-sync-preview"
              onClick={() => void start(true)}
            >
              {t('Preview')}
            </Button>
            {mode === 'copy' && (
              <Button
                variant="primary"
                disabled={!!problem || destBuckets === null}
                data-testid="s3-sync-start"
                onClick={() => void start(false)}
              >
                {t('Sync')}
              </Button>
            )}
          </>
        ) : running ? (
          <>
            <Button data-testid="s3-sync-background" onClick={onBackground}>
              {t('Run in background')}
            </Button>
            <Button data-testid="s3-sync-stop" onClick={stop}>
              {t('Stop')}
            </Button>
          </>
        ) : planned ? (
          <>
            <Button
              onClick={() => {
                setProgress(null)
              }}
            >
              Back
            </Button>
            <Button
              variant={p.plan.delete ? 'danger' : 'primary'}
              disabled={!continuous && toCopy === 0 && p.plan.delete === 0}
              data-testid="s3-sync-run"
              onClick={() =>
                void (async () => {
                  // Nguồn rỗng mà vẫn xoá ở đích (chọn nhầm thư mục…) → hỏi lại một lần nữa.
                  if (
                    p.scanned.source === 0 &&
                    p.plan.delete > 0 &&
                    !(await confirmAction({
                      title: t('Delete everything at the destination?'),
                      message: tn(
                        p.plan.delete,
                        'The source is empty. {n} object at the destination will be deleted.',
                        'The source is empty. {n} objects at the destination will be deleted.'
                      ),
                      confirmLabel: t('Delete all'),
                      danger: true
                    }))
                  )
                    return
                  await start(false, p.plan.delete)
                })()
              }
            >
              {continuous
                ? t('Start continuous sync')
                : toCopy === 0 && p.plan.delete === 0
                  ? t('Already in sync')
                  : p.plan.delete
                    ? t('Sync and delete {n}', { n: formatNumber(p.plan.delete) })
                    : tn(toCopy, 'Sync {n} object', 'Sync {n} objects')}
            </Button>
          </>
        ) : (
          <>
            {finished && (
              <Button
                onClick={() => {
                  setProgress(null)
                }}
              >
                Back
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {p === null && !running ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field label={t('Destination account')}>
              <Select
                data-testid="s3-sync-account"
                value={destAccount}
                onChange={(e) => {
                  pickAccount(e.target.value)
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.id === accountId ? ` (${t('this account')})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('Destination bucket')}
              hint={
                destBuckets === null
                  ? t('Loading buckets…')
                  : willCreate && !problem
                    ? t('This bucket will be created')
                    : undefined
              }
            >
              <Input
                mono
                list="s3-sync-buckets"
                data-testid="s3-sync-bucket"
                placeholder={t('bucket name')}
                value={destBucket}
                onChange={(e) => {
                  setDestBucket(e.target.value.toLowerCase())
                }}
              />
              <datalist id="s3-sync-buckets">
                {(destBuckets ?? [])
                  .filter((b) => !(sameAccount && b.name === source.bucket && !destPrefix))
                  .map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
              </datalist>
            </Field>
          </div>
          <Field label={t('Destination folder')} hint={t('Empty = the bucket root')}>
            <Input
              mono
              data-testid="s3-sync-prefix"
              placeholder="backups/2026/"
              value={destPrefix}
              onChange={(e) => {
                setDestPrefix(e.target.value)
              }}
            />
          </Field>
          <Field
            label={t('Mode')}
            hint={
              mode === 'copy'
                ? t(
                    'Copies objects that are new or changed. Nothing is deleted at the destination.'
                  )
                : t(
                    'Makes the destination identical: also deletes objects that are not in the source. You see the list before anything is deleted.'
                  )
            }
          >
            <div className="self-start">
              <Segmented
                value={mode}
                onChange={setMode}
                testIdPrefix="s3-sync-mode"
                options={[
                  { value: 'copy', label: t('Copy new & changed') },
                  { value: 'mirror', label: t('Mirror') }
                ]}
              />
            </div>
          </Field>
          {mode === 'copy' && (
            <Field
              label={t('Destination comparison')}
              hint={
                strategy === 'lookup'
                  ? t(
                      'Checks only keys found in the source and starts copying immediately. Best when the destination has many unrelated objects.'
                    )
                  : t(
                      'Lists both sides before copying. Can use fewer requests when both sides contain many of the same keys.'
                    )
              }
            >
              <Select
                data-testid="s3-sync-strategy"
                value={strategy}
                onChange={(e) => {
                  setStrategy(e.target.value as 'lookup' | 'inventory')
                }}
              >
                <option value="lookup">{t('Check source keys and copy immediately')}</option>
                <option value="inventory">{t('List both sides first')}</option>
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <Field label={t('Changed means')}>
              <Select
                value={compare}
                onChange={(e) => {
                  setCompare(e.target.value as 'etag' | 'size')
                }}
              >
                <option value="etag">{t('Different size or checksum (ETag)')}</option>
                <option value="size">
                  {t('Different size only (faster for very large uploads)')}
                </option>
              </Select>
            </Field>
            <Field
              label={t('Parallel transfers')}
              hint={threads ? undefined : t('From Settings → Modules → S3 storage')}
            >
              <Select
                data-testid="s3-sync-threads"
                value={String(threads)}
                onChange={(e) => {
                  setThreads(Number(e.target.value))
                }}
              >
                <option value="0">{t('Auto')}</option>
                {[1, 2, 4, 8, 16, 32, 64].map((n) => (
                  <option key={n} value={n}>
                    {t('{n} at a time', { n })}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Checkbox
            label={t('Continuous sync')}
            data-testid="s3-sync-continuous"
            checked={continuous}
            onChange={(e) => {
              setContinuous(e.target.checked)
            }}
            description={t(
              'Repeat until Stop while this tab and the app stay open. Each round uses the selected comparison and copies only new or changed objects.'
            )}
          />
          {continuous && (
            <Field
              label={t('Pause between sync rounds')}
              hint={t(
                'The pause starts after a round finishes. Choose a longer pause to reduce comparison requests.'
              )}
            >
              <Select
                data-testid="s3-sync-interval"
                value={String(intervalSeconds)}
                onChange={(e) => {
                  setIntervalSeconds(Number(e.target.value))
                }}
              >
                {[30, 60, 300, 900, 3600].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {formatDuration(seconds * 1000)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <p className="text-xs text-faint">
            {sameAccount
              ? t(
                  'Same account: objects are copied on the server — nothing goes through this computer.'
                )
              : t(
                  'Different accounts: each object is streamed from the source to the destination through this computer (nothing is written to disk).'
                )}
          </p>
          {problem && bucketName && <p className="text-xs text-danger">{problem}</p>}
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      ) : (
        <div
          className="flex flex-col gap-3"
          data-testid="s3-sync-progress"
          data-phase={p?.phase ?? 'scanning'}
        >
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-medium text-fg">
              {p?.listing && running && !p.dryRun
                ? t('Checking and copying…')
                : phaseLabel(p?.phase ?? 'scanning')}
            </span>
            <ArrowRight size={13} className="text-faint" />
            <span className="truncate font-mono text-xs text-muted" title={destLabel}>
              {destLabel}
            </span>
          </div>
          {p?.continuous && (
            <Notice tone="info" testId="s3-sync-continuous-status">
              {t('Round {round} · {copied} copied, {deleted} deleted in total.', {
                round: formatNumber(p.continuous.round),
                copied: formatNumber(p.continuous.totals.copied),
                deleted: formatNumber(p.continuous.totals.deleted)
              })}{' '}
              {p.phase === 'waiting' && p.continuous.nextRunAt !== null
                ? t('Next check at {time}. Stop cancels future rounds.', {
                    time: formatDateTimeSeconds(p.continuous.nextRunAt)
                  })
                : running
                  ? t('Continues in the background until Stop.')
                  : ''}
              {mode === 'mirror' && (
                <p>{t('Every round keeps the deletion limit approved in the preview.')}</p>
              )}
            </Notice>
          )}
          {planned && continuous && mode === 'mirror' && (
            <Notice tone="info">
              {t('Every round keeps the deletion limit approved in the preview.')}
            </Notice>
          )}
          {p?.phase === 'waiting' && (p.error || p.done.failed > 0) && (
            <Notice tone="warning">
              {t('The last round had errors. It will retry after the pause; Stop cancels retries.')}
            </Notice>
          )}
          {planned && p.plan.delete > 0 && p.scanned.source === 0 && (
            <Notice tone="danger" testId="s3-sync-empty-source">
              {t(
                'The source folder is empty — this sync would delete every object ({n}) in the destination. Check that you picked the right source.',
                { n: formatNumber(p.plan.delete) }
              )}
            </Notice>
          )}
          {(p === null || p.phase === 'scanning' || p.strategy === 'lookup') && (
            <p className="text-xs text-muted">
              {p?.strategy === 'lookup'
                ? t('Listed {source} source objects · checked {dest} matching destination keys.', {
                    source: formatNumber(p.scanned.source),
                    dest: formatNumber(p.scanned.dest)
                  })
                : t('Listed {source} objects at the source and {dest} at the destination…', {
                    source: formatNumber(p?.scanned.source ?? 0),
                    dest: formatNumber(p?.scanned.dest ?? 0)
                  })}
            </p>
          )}
          {p?.listing && running && (
            <p className="text-xs text-muted" data-testid="s3-sync-growing-plan">
              {t('Totals are discovered as the source is read.')}
            </p>
          )}
          {p && p.phase !== 'scanning' && p.phase !== 'error' && (
            <div className="flex flex-wrap gap-1.5 text-xs" data-testid="s3-sync-plan">
              <Pill tone="ok">{t('{n} new', { n: formatNumber(p.plan.new) })}</Pill>
              <Pill tone="info">{t('{n} changed', { n: formatNumber(p.plan.update) })}</Pill>
              {(mode === 'mirror' || p.plan.delete > 0) && (
                <Pill tone="bad">{t('{n} to delete', { n: formatNumber(p.plan.delete) })}</Pill>
              )}
              <Pill tone="muted">{t('{n} unchanged', { n: formatNumber(p.plan.same) })}</Pill>
              <span className="ml-auto text-muted">
                {t('{size} to copy', { size: formatSize(p.plan.bytes) })}
              </span>
            </div>
          )}
          {p &&
            (p.phase === 'copying' ||
              p.phase === 'deleting' ||
              p.phase === 'waiting' ||
              finished) &&
            !p.dryRun && (
              <div className="flex flex-col gap-1">
                {!p.listing && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
                    <div
                      className="h-full rounded-full bg-info transition-[width]"
                      style={{ width: `${Math.round(fraction * 100)}%` }}
                    />
                  </div>
                )}
                <div
                  className="flex justify-between text-xs text-muted tabular-nums"
                  data-testid="s3-sync-done"
                >
                  <span>
                    {p.listing
                      ? t('{n} copied', { n: formatNumber(p.done.copied) })
                      : t('{done} / {total} copied', {
                          done: formatNumber(p.done.copied),
                          total: formatNumber(toCopy)
                        })}
                    {p.plan.delete
                      ? ` · ${t('{n} deleted', { n: formatNumber(p.done.deleted) })}`
                      : ''}
                    {p.done.failed
                      ? ` · ${t('{n} failed', { n: formatNumber(p.done.failed) })}`
                      : ''}
                  </span>
                  <span>
                    {formatSize(p.done.bytes)} / {formatSize(p.plan.bytes)}
                    {p.bytesPerSecond ? ` · ${formatRate(p.bytesPerSecond)}` : ''}
                    {p.phase === 'copying' && !p.listing && eta(p)
                      ? ` · ${t('{time} left', { time: eta(p) ?? '' })}`
                      : ''}
                  </span>
                </div>
                {p.phase === 'copying' && p.active.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1" data-testid="s3-sync-active">
                    <span className="text-[11px] text-faint">
                      {t('{n} at a time', { n: p.concurrency })}
                      {p.serverSide ? ` · ${t('copied on the server')}` : ''}
                    </span>
                    {p.active.map((a) => (
                      <div key={a.key} className="flex items-center gap-2 text-xs">
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-muted"
                          title={a.key}
                        >
                          {a.key}
                        </span>
                        {!p.serverSide && a.size > 0 && (
                          <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-subtle">
                            <span
                              className="block h-full bg-info"
                              style={{
                                width: `${Math.min(100, Math.round((a.done / a.size) * 100))}%`
                              }}
                            />
                          </span>
                        )}
                        <span className="w-16 shrink-0 text-right text-faint tabular-nums">
                          {formatSize(a.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          {p?.error && <Notice tone="danger">{p.error}</Notice>}
          {error && <Notice tone="danger">{error}</Notice>}
          {p && p.errors.length > 0 && (
            <div className="max-h-28 overflow-auto rounded-md border border-danger/30 p-2 text-xs">
              {p.errors.map((e) => (
                <div key={e.key} className="flex gap-2">
                  <span className="truncate font-mono text-fg">{e.key}</span>
                  <span className="truncate text-danger">{e.message}</span>
                </div>
              ))}
            </div>
          )}
          {p && p.sample.length > 0 && planned && (
            <div className="max-h-64 overflow-auto rounded-md border border-line">
              {p.sample.map((it) => (
                <div
                  key={`${it.action}:${it.key}`}
                  className="flex items-center gap-2 border-b border-line px-2 py-1 text-xs last:border-0"
                  data-testid="s3-sync-item"
                >
                  <span className="w-16 shrink-0">
                    <Pill tone={ACTION_TONE[it.action]}>{actionLabel(it.action)}</Pill>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg" title={it.key}>
                    {it.key}
                  </span>
                  <span className="shrink-0 text-faint tabular-nums">{formatSize(it.size)}</span>
                </div>
              ))}
              {p.plan.new + p.plan.update + p.plan.delete > p.sample.length && (
                <p className="px-2 py-1 text-xs text-faint">
                  {t('…and {n} more', {
                    n: formatNumber(p.plan.new + p.plan.update + p.plan.delete - p.sample.length)
                  })}
                </p>
              )}
            </div>
          )}
          {finished && p.phase === 'done' && !p.dryRun && (
            <Notice tone={p.done.failed ? 'danger' : 'success'} testId="s3-sync-result">
              {p.done.failed
                ? tn(
                    p.done.failed,
                    'Finished with {n} error — run the sync again to retry it.',
                    'Finished with {n} errors — run the sync again to retry them.'
                  )
                : p.plan.delete
                  ? t('In sync: {copied} copied, {deleted} deleted.', {
                      copied: formatNumber(p.done.copied),
                      deleted: formatNumber(p.done.deleted)
                    })
                  : t('In sync: {copied} copied.', { copied: formatNumber(p.done.copied) })}
            </Notice>
          )}
        </div>
      )}
    </Modal>
  )
}
