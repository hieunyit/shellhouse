import { useEffect, useRef, useState } from 'react'
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
        setBusy(`Counting objects in ${missing.length} bucket${missing.length === 1 ? '' : 's'}…`)
        counted = { ...counted, ...(await calculate(missing.map((b) => b.name))) }
      }
      const infos: Record<string, S3BucketInfo> = {}
      if (details) {
        let done = 0
        setBusy(`Reading bucket settings 0/${buckets.length}…`)
        await eachLimit(buckets, 6, async (b) => {
          infos[b.name] = (await run({ op: 'bucketInfo', bucket: b.name }).catch(
            () => null
          )) as S3BucketInfo
          done++
          setBusy(`Reading bucket settings ${done}/${buckets.length}…`)
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
      setBusy('Saving…')
      await run({ op: 'writeFile', localPath: path, content })
      setSaved(path)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title="Export bucket list"
      description={`${buckets.length} bucket${buckets.length === 1 ? '' : 's'} in ${account}`}
      onClose={() => {
        if (busy) stop()
        onClose()
      }}
      width="max-w-md"
      testId="s3-export-dialog"
      footer={
        saved ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            {busy ? (
              <Button onClick={stop}>Stop</Button>
            ) : (
              <Button onClick={onClose}>Cancel</Button>
            )}
            <Button
              variant="primary"
              icon={<FileDown size={13} />}
              disabled={busy !== null}
              data-testid="s3-export-submit"
              onClick={() => void submit()}
            >
              {busy ? 'Exporting…' : 'Export…'}
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <Notice tone="success" testId="s3-export-done">
          Saved {buckets.length} bucket{buckets.length === 1 ? '' : 's'} to{' '}
          <span className="font-mono break-all">{saved}</span>
        </Notice>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Format">
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
              Always included: bucket name, region, created date.
            </p>
            <Checkbox
              label="Object count and total size"
              data-testid="s3-export-sizes"
              description={
                missing.length === 0
                  ? 'Already calculated for every bucket.'
                  : `Counts every object in ${missing.length} bucket${missing.length === 1 ? '' : 's'} not counted yet — large buckets take a while.`
              }
              checked={sizes}
              onChange={(e) => {
                setSizes(e.target.checked)
              }}
            />
            <Checkbox
              label="Versioning and encryption"
              data-testid="s3-export-details"
              description="One request per bucket. Shown empty where the service does not support it."
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
const PHASE: Record<S3SyncProgress['phase'], string> = {
  scanning: 'Comparing…',
  planned: 'Preview',
  copying: 'Copying…',
  deleting: 'Deleting extra objects…',
  done: 'Finished',
  stopped: 'Stopped',
  error: 'Failed'
}

/** Hiện ngay khi bấm (trước lần hỏi tiến độ đầu) — không nháy lại form. */
function startingProgress(dryRun: boolean, serverSide: boolean): S3SyncProgress {
  return {
    phase: 'scanning',
    dryRun,
    serverSide,
    scanned: { source: 0, dest: 0 },
    plan: { new: 0, update: 0, delete: 0, same: 0, bytes: 0 },
    done: { copied: 0, deleted: 0, bytes: 0, failed: 0 },
    bytesPerSecond: 0,
    concurrency: 0,
    active: [],
    sample: [],
    errors: [],
    error: null
  }
}

/** Thời gian còn lại theo tốc độ đã làm mượt: "3 min", "1 h 20 min"; chưa đủ dữ liệu → null. */
function eta(p: S3SyncProgress): string | null {
  if (p.bytesPerSecond <= 0 || p.plan.bytes <= p.done.bytes) return null
  const s = Math.round((p.plan.bytes - p.done.bytes) / p.bytesPerSecond)
  if (s < 60) return `${Math.max(1, s)} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
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
  onFinished
}: {
  accountId: string
  accounts: S3AccountSummary[]
  buckets: S3Bucket[]
  source: SyncSource
  run: Run
  onClose: () => void
  /** Đã ghi vào đích (để làm mới danh sách nếu đích là tài khoản này). */
  onFinished: (destAccountId: string) => void
}): React.JSX.Element {
  const [destAccount, setDestAccount] = useState(accountId)
  const [destBuckets, setDestBuckets] = useState<S3Bucket[] | null>(buckets)
  const [destBucket, setDestBucket] = useState('')
  const [destPrefix, setDestPrefix] = useState(source.prefix)
  const [mode, setMode] = useState<'copy' | 'mirror'>('copy')
  const [compare, setCompare] = useState<'etag' | 'size'>('etag')
  /** 0 = theo cài đặt (Settings → Modules → S3 storage). */
  const [threads, setThreads] = useState(0)
  const [progress, setProgress] = useState<S3SyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const jobId = useRef<string | null>(null)
  const alive = useRef(true)
  /** Hàm (không đọc thẳng): TS không thu hẹp kiểu ref qua các lần await. */
  const isAlive = (): boolean => alive.current
  const sameAccount = destAccount === accountId
  const sourceName = accounts.find((a) => a.id === accountId)?.name ?? 'this account'

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
        setError(`Could not list the buckets of that account: ${cleanError(e)}`)
      }
    )
  }

  const bucketName = destBucket.trim()
  const known = destBuckets?.some((b) => b.name === bucketName) ?? false
  const willCreate = destBuckets !== null && bucketName !== '' && !known
  const problem = !bucketName
    ? 'Choose a destination bucket'
    : willCreate
      ? bucketNameProblem(bucketName)
      : null
  const running =
    progress?.phase === 'scanning' ||
    progress?.phase === 'copying' ||
    progress?.phase === 'deleting'

  const start = async (dryRun: boolean): Promise<void> => {
    setError(null)
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
        dryRun
      })) as string
      jobId.current = id
      setProgress(startingProgress(dryRun, sameAccount))
      // Hỏi sớm (bucket nhỏ xong ngay), rồi đều đặn ~3 lần / giây cho thanh tiến độ mượt.
      for (let wait = 100; alive.current && jobId.current === id; wait = Math.min(300, wait * 2)) {
        await sleep(wait)
        const p = (await run({ op: 'syncPoll', id })) as S3SyncProgress
        if (!isAlive()) return
        setProgress(p)
        if (p.phase !== 'scanning' && p.phase !== 'copying' && p.phase !== 'deleting') {
          jobId.current = null
          if (!dryRun && (p.done.copied || p.done.deleted)) onFinished(destAccount)
          return
        }
      }
    } catch (e) {
      jobId.current = null
      if (alive.current) setError(cleanError(e))
    }
  }

  const stop = (): void => {
    if (jobId.current) void run({ op: 'syncStop', id: jobId.current }).catch(() => undefined)
  }

  const close = (): void => {
    if (running && !window.confirm('Stop the sync? Objects copied so far stay at the destination.'))
      return
    onClose()
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

  return (
    <Modal
      title="Sync"
      description={
        <>
          <span className="font-mono">
            s3://{source.bucket}/{source.prefix}
          </span>{' '}
          in {sourceName}
        </>
      }
      onClose={close}
      width="max-w-2xl"
      testId="s3-sync-dialog"
      footer={
        p === null && !running ? (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              disabled={!!problem || destBuckets === null}
              data-testid="s3-sync-preview"
              onClick={() => void start(true)}
            >
              Preview
            </Button>
            {mode === 'copy' && (
              <Button
                variant="primary"
                disabled={!!problem || destBuckets === null}
                data-testid="s3-sync-start"
                onClick={() => void start(false)}
              >
                Sync
              </Button>
            )}
          </>
        ) : running ? (
          <Button data-testid="s3-sync-stop" onClick={stop}>
            Stop
          </Button>
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
              disabled={toCopy === 0 && p.plan.delete === 0}
              data-testid="s3-sync-run"
              onClick={() => void start(false)}
            >
              {toCopy === 0 && p.plan.delete === 0
                ? 'Already in sync'
                : p.plan.delete
                  ? `Sync and delete ${p.plan.delete.toLocaleString('en')}`
                  : `Sync ${toCopy.toLocaleString('en')} object${toCopy === 1 ? '' : 's'}`}
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
            <Field label="Destination account">
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
                    {a.id === accountId ? ' (this account)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Destination bucket"
              hint={
                destBuckets === null
                  ? 'Loading buckets…'
                  : willCreate && !problem
                    ? 'This bucket will be created'
                    : undefined
              }
            >
              <Input
                mono
                list="s3-sync-buckets"
                data-testid="s3-sync-bucket"
                placeholder="bucket name"
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
          <Field label="Destination folder" hint="Empty = the bucket root">
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
            label="Mode"
            hint={
              mode === 'copy'
                ? 'Copies objects that are new or changed. Nothing is deleted at the destination.'
                : 'Makes the destination identical: also deletes objects that are not in the source. You see the list before anything is deleted.'
            }
          >
            <div className="self-start">
              <Segmented
                value={mode}
                onChange={setMode}
                testIdPrefix="s3-sync-mode"
                options={[
                  { value: 'copy', label: 'Copy new & changed' },
                  { value: 'mirror', label: 'Mirror' }
                ]}
              />
            </div>
          </Field>
          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <Field label="Changed means">
              <Select
                value={compare}
                onChange={(e) => {
                  setCompare(e.target.value as 'etag' | 'size')
                }}
              >
                <option value="etag">Different size or checksum (ETag)</option>
                <option value="size">Different size only (faster for very large uploads)</option>
              </Select>
            </Field>
            <Field
              label="Parallel transfers"
              hint={threads ? undefined : 'From Settings → Modules → S3 storage'}
            >
              <Select
                data-testid="s3-sync-threads"
                value={String(threads)}
                onChange={(e) => {
                  setThreads(Number(e.target.value))
                }}
              >
                <option value="0">Auto</option>
                {[1, 2, 4, 8, 16, 32, 64].map((n) => (
                  <option key={n} value={n}>
                    {n} at a time
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-faint">
            {sameAccount
              ? 'Same account: objects are copied on the server — nothing goes through this computer.'
              : 'Different accounts: each object is streamed from the source to the destination through this computer (nothing is written to disk).'}
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
            <span className="font-medium text-fg">{PHASE[p?.phase ?? 'scanning']}</span>
            <ArrowRight size={13} className="text-faint" />
            <span className="truncate font-mono text-xs text-muted" title={destLabel}>
              {destLabel}
            </span>
          </div>
          {(p === null || p.phase === 'scanning') && (
            <p className="text-xs text-muted">
              Listed {(p?.scanned.source ?? 0).toLocaleString('en')} objects at the source and{' '}
              {(p?.scanned.dest ?? 0).toLocaleString('en')} at the destination…
            </p>
          )}
          {p && p.phase !== 'scanning' && p.phase !== 'error' && (
            <div className="flex flex-wrap gap-1.5 text-xs" data-testid="s3-sync-plan">
              <Pill tone="ok">{`${p.plan.new.toLocaleString('en')} new`}</Pill>
              <Pill tone="info">{`${p.plan.update.toLocaleString('en')} changed`}</Pill>
              {(mode === 'mirror' || p.plan.delete > 0) && (
                <Pill tone="bad">{`${p.plan.delete.toLocaleString('en')} to delete`}</Pill>
              )}
              <Pill tone="muted">{`${p.plan.same.toLocaleString('en')} unchanged`}</Pill>
              <span className="ml-auto text-muted">{formatSize(p.plan.bytes)} to copy</span>
            </div>
          )}
          {p && (p.phase === 'copying' || p.phase === 'deleting' || finished) && !p.dryRun && (
            <div className="flex flex-col gap-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
                <div
                  className="h-full rounded-full bg-accent-solid transition-[width]"
                  style={{ width: `${Math.round(fraction * 100)}%` }}
                />
              </div>
              <div
                className="flex justify-between text-xs text-muted tabular-nums"
                data-testid="s3-sync-done"
              >
                <span>
                  {p.done.copied.toLocaleString('en')} / {toCopy.toLocaleString('en')} copied
                  {p.plan.delete ? ` · ${p.done.deleted.toLocaleString('en')} deleted` : ''}
                  {p.done.failed ? ` · ${p.done.failed.toLocaleString('en')} failed` : ''}
                </span>
                <span>
                  {formatSize(p.done.bytes)} / {formatSize(p.plan.bytes)}
                  {p.bytesPerSecond ? ` · ${formatSize(p.bytesPerSecond)}/s` : ''}
                  {p.phase === 'copying' && eta(p) ? ` · ${eta(p)} left` : ''}
                </span>
              </div>
              {p.phase === 'copying' && p.active.length > 0 && (
                <div className="mt-1 flex flex-col gap-1" data-testid="s3-sync-active">
                  <span className="text-[11px] text-faint">
                    {p.concurrency} at a time{p.serverSide ? ' · copied on the server' : ''}
                  </span>
                  {p.active.map((a) => (
                    <div key={a.key} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono text-muted" title={a.key}>
                        {a.key}
                      </span>
                      {!p.serverSide && a.size > 0 && (
                        <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-subtle">
                          <span
                            className="block h-full bg-accent-solid"
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
                    <Pill tone={ACTION_TONE[it.action]}>{it.action}</Pill>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg" title={it.key}>
                    {it.key}
                  </span>
                  <span className="shrink-0 text-faint tabular-nums">{formatSize(it.size)}</span>
                </div>
              ))}
              {p.plan.new + p.plan.update + p.plan.delete > p.sample.length && (
                <p className="px-2 py-1 text-xs text-faint">
                  …and{' '}
                  {(p.plan.new + p.plan.update + p.plan.delete - p.sample.length).toLocaleString(
                    'en'
                  )}{' '}
                  more
                </p>
              )}
            </div>
          )}
          {finished && p.phase === 'done' && !p.dryRun && (
            <Notice tone={p.done.failed ? 'danger' : 'success'} testId="s3-sync-result">
              {p.done.failed
                ? `Finished with ${p.done.failed.toLocaleString('en')} error${p.done.failed === 1 ? '' : 's'} — run the sync again to retry them.`
                : `In sync: ${p.done.copied.toLocaleString('en')} copied${p.plan.delete ? `, ${p.done.deleted.toLocaleString('en')} deleted` : ''}.`}
            </Notice>
          )}
        </div>
      )}
    </Modal>
  )
}
