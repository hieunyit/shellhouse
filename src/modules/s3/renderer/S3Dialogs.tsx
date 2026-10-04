import { useEffect, useState } from 'react'
import { File, Folder, History } from 'lucide-react'
import {
  bucketNameProblem,
  objectNameProblem,
  type S3Bucket,
  type S3BucketInfo,
  type S3BulkJob,
  type S3Entry,
  type S3Op
} from '../shared/ops'
import { shortVersionId, type S3Version } from '../shared/manage'
import { Button, Checkbox, Input, Modal, Notice, Select } from '../../../renderer/src/components/ui'
import { formatNumber, t, tn } from '../../registry/renderer-kit'
import { cleanError } from './format'
import { ShareLink } from './ShareLink'

export type S3DialogState =
  | { kind: 'mkdir' }
  | { kind: 'bucket' }
  | { kind: 'delete'; entries: S3Entry[] }
  | { kind: 'link'; entry: S3Entry }
  | { kind: 'rename'; entry: S3Entry }
  | { kind: 'copy'; entries: S3Entry[]; move: boolean }
  /** Xoá vĩnh viễn phiên bản / delete marker (phải gõ "delete" để xác nhận khi có dữ liệu). */
  | { kind: 'deleteVersions'; versions: S3Version[] }
  | null

/** Đếm object trước khi xoá thư mục: tối đa chừng này (hơn thì hiện "hơn 10,000"). */
const COUNT_LIMIT = 10_000

/** Từ phải gõ để xoá vĩnh viễn phiên bản (luôn tiếng Anh như GitHub / AWS console). */
const CONFIRM_WORD = 'delete'

/** Tên ngắn cho dòng việc nền: “logs” hoặc "3 items". */
function itemsLabel(entries: readonly S3Entry[]): string {
  return entries.length === 1
    ? `“${entries[0]?.name ?? ''}”`
    : tn(entries.length, '{n} item', '{n} items')
}

/** Hộp thoại của trình quản lý S3 (bucket / thư mục mới, xoá, link, đổi tên, copy/move). */
export function S3Dialog({
  dialog,
  buckets,
  bucket,
  prefix,
  run,
  onClose,
  onDone,
  onJob,
  typeName
}: {
  dialog: NonNullable<S3DialogState>
  buckets: S3Bucket[]
  bucket: string | null
  prefix: string
  run: (op: S3Op) => Promise<unknown>
  onClose: () => void
  onDone: (kind: NonNullable<S3DialogState>['kind']) => Promise<void>
  /**
   * Thư mục (có thể rất nhiều object): chạy nền có tiến độ + Stop thay vì chờ trong hộp thoại.
   * Hộp thoại đóng ngay; lỗi hiện ở thanh lỗi của tab.
   */
  onJob: (job: S3BulkJob, label: string, verb: string) => void
  /**
   * Môi trường của tài khoản yêu cầu gõ tên khi xoá (Production): phải gõ đúng chuỗi này (tên
   * object, hoặc "3 items") thì nút Delete mới bật; không dán được.
   */
  typeName?: string | undefined
}): React.JSX.Element {
  const [value, setValue] = useState(dialog.kind === 'rename' ? dialog.entry.name : '')
  const [destBucket, setDestBucket] = useState(bucket ?? '')
  const [destPrefix, setDestPrefix] = useState(prefix)
  const [overwrite, setOverwrite] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Xoá: số object sẽ bị xoá (null = đang đếm) và versioning của bucket. */
  const [count, setCount] = useState<{ count: number; more: boolean } | null>(null)
  const [versioning, setVersioning] = useState<S3BucketInfo['versioning']>(null)
  const deleteKeys = dialog.kind === 'delete' ? dialog.entries.map((e) => e.key).join('\n') : ''

  useEffect(() => {
    if (!deleteKeys || bucket === null) return
    let cancelled = false
    const keys = deleteKeys.split('\n')
    if (keys.some((k) => k.endsWith('/')))
      void run({ op: 'countObjects', bucket, keys, limit: COUNT_LIMIT }).then(
        (r) => {
          if (!cancelled) setCount(r as { count: number; more: boolean })
        },
        () => undefined
      )
    void run({ op: 'versioning', bucket }).then(
      (v) => {
        if (!cancelled) setVersioning(v as S3BucketInfo['versioning'])
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [deleteKeys, bucket, run])

  const problem =
    dialog.kind === 'bucket'
      ? value
        ? bucketNameProblem(value)
        : t('Enter a name')
      : dialog.kind === 'mkdir'
        ? !value.trim() || value.includes('/')
          ? t('Enter a folder name (no “/”)')
          : null
        : dialog.kind === 'rename'
          ? objectNameProblem(value)
          : dialog.kind === 'copy'
            ? destBucket
              ? destPrefix.startsWith('/') || destPrefix.includes('//')
                ? t('Use a path like logs/2024/ (no leading “/”)')
                : null
              : t('Choose a bucket')
            : dialog.kind === 'deleteVersions' &&
                dialog.versions.some((v) => !v.deleteMarker) &&
                value.trim().toLowerCase() !== CONFIRM_WORD
              ? t('Type “{word}” to confirm', { word: CONFIRM_WORD })
              : dialog.kind === 'delete' && typeName !== undefined && value !== typeName
                ? t('Type {name} to confirm', { name: typeName })
                : null

  const submit = async (): Promise<void> => {
    // Link chia sẻ có nút riêng (ShareLink) — Enter trong ô thời hạn không đóng hộp thoại.
    if (problem || dialog.kind === 'link') return
    setBusy(true)
    setError(null)
    try {
      if (dialog.kind === 'bucket') await run({ op: 'createBucket', bucket: value })
      if (dialog.kind === 'mkdir' && bucket !== null)
        await run({ op: 'mkdir', bucket, key: `${prefix}${value.trim()}/` })
      if (dialog.kind === 'delete' && bucket !== null) {
        const keys = dialog.entries.map((e) => e.key)
        if (dialog.entries.some((e) => e.isFolder)) {
          onJob(
            { kind: 'delete', bucket, keys },
            t('Deleting {items}', { items: itemsLabel(dialog.entries) }),
            'deleted'
          )
          onClose()
          return
        }
        await run({ op: 'delete', bucket, keys })
      }
      if (dialog.kind === 'rename' && bucket !== null) {
        const job = {
          kind: 'rename',
          bucket,
          key: dialog.entry.key,
          name: value,
          overwrite: false
        } as const
        if (dialog.entry.isFolder) {
          onJob(
            job,
            t('Renaming “{name}” to “{to}”', { name: dialog.entry.name, to: value }),
            'moved'
          )
          onClose()
          return
        }
        await run({ ...job, op: 'rename' })
      }
      if (dialog.kind === 'copy' && bucket !== null) {
        const job = {
          kind: 'copy',
          bucket,
          keys: dialog.entries.map((e) => e.key),
          destBucket,
          destPrefix: destPrefix.trim(),
          move: dialog.move,
          overwrite
        } as const
        if (dialog.entries.some((e) => e.isFolder)) {
          const params = {
            items: itemsLabel(dialog.entries),
            to: `${destBucket}/${job.destPrefix}`
          }
          onJob(
            job,
            dialog.move
              ? t('Moving {items} to {to}', params)
              : t('Copying {items} to {to}', params),
            dialog.move ? 'moved' : 'copied'
          )
          onClose()
          return
        }
        await run({ ...job, op: 'copy' })
      }
      if (dialog.kind === 'deleteVersions' && bucket !== null) {
        await run({
          op: 'deleteVersions',
          bucket,
          items: dialog.versions.map((v) => ({ key: v.key, versionId: v.versionId }))
        })
      }
      await onDone(dialog.kind)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const titles = {
    bucket: t('New bucket'),
    mkdir: t('New folder'),
    delete: t('Delete'),
    link: t('Share link'),
    rename: t('Rename'),
    copy: dialog.kind === 'copy' && dialog.move ? t('Move to') : t('Copy to'),
    deleteVersions: t('Delete permanently')
  } as const
  const submitLabel = {
    bucket: t('Create'),
    mkdir: t('Create'),
    delete: t('Delete'),
    link: '',
    rename: t('Rename'),
    copy: dialog.kind === 'copy' && dialog.move ? t('Move') : t('Copy'),
    deleteVersions: t('Delete permanently')
  } as const
  const folders = dialog.kind === 'delete' ? dialog.entries.filter((e) => e.isFolder).length : 0
  const danger = dialog.kind === 'delete' || dialog.kind === 'deleteVersions'

  return (
    <Modal
      title={titles[dialog.kind]}
      description={
        dialog.kind === 'link' ? (
          <span className="font-mono break-all">{dialog.entry.name}</span>
        ) : undefined
      }
      onClose={onClose}
      width="max-w-md"
      testId="s3-dialog"
      footer={
        <>
          <Button onClick={onClose}>{dialog.kind === 'link' ? t('Close') : t('Cancel')}</Button>
          {dialog.kind !== 'link' && (
            <Button
              variant={danger ? 'danger' : 'primary'}
              disabled={!!problem || busy}
              data-testid="s3-dialog-submit"
              onClick={() => void submit()}
            >
              {busy && dialog.kind !== 'bucket' && dialog.kind !== 'mkdir'
                ? t('Working…')
                : submitLabel[dialog.kind]}
            </Button>
          )}
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {(dialog.kind === 'bucket' || dialog.kind === 'mkdir') && (
          <Input
            autoFocus
            mono
            data-testid="s3-dialog-input"
            placeholder={dialog.kind === 'bucket' ? 'my-bucket' : t('folder name')}
            value={value}
            onChange={(e) => {
              setValue(dialog.kind === 'bucket' ? e.target.value.toLowerCase() : e.target.value)
            }}
          />
        )}
        {dialog.kind === 'rename' && (
          <Input
            autoFocus
            mono
            data-testid="s3-dialog-input"
            value={value}
            onFocus={(e) => {
              // Chọn phần tên, chừa đuôi file (như Explorer / Finder).
              const dot = dialog.entry.isFolder ? -1 : value.lastIndexOf('.')
              e.target.setSelectionRange(0, dot > 0 ? dot : value.length)
            }}
            onChange={(e) => {
              setValue(e.target.value)
            }}
          />
        )}
        {dialog.kind === 'copy' && (
          <>
            <p className="text-[13px]">
              {dialog.entries.length === 1 ? (
                <>
                  {dialog.move ? t('Move') : t('Copy')}{' '}
                  <strong className="break-all">{dialog.entries[0]?.name}</strong>
                </>
              ) : dialog.move ? (
                tn(dialog.entries.length, 'Move {n} item', 'Move {n} items')
              ) : (
                tn(dialog.entries.length, 'Copy {n} item', 'Copy {n} items')
              )}{' '}
              {t('to:')}
            </p>
            <Select
              aria-label={t('Destination bucket')}
              data-testid="s3-copy-bucket"
              value={destBucket}
              onChange={(e) => {
                setDestBucket(e.target.value)
              }}
            >
              {buckets.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Input
              mono
              aria-label={t('Destination folder')}
              placeholder={t('Folder (empty = bucket root), e.g. backups/2024/')}
              data-testid="s3-copy-prefix"
              value={destPrefix}
              onChange={(e) => {
                setDestPrefix(e.target.value)
              }}
            />
            <Checkbox
              label={t('Replace objects that already exist')}
              checked={overwrite}
              onChange={(e) => {
                setOverwrite(e.target.checked)
              }}
            />
            <p className="text-xs text-faint">
              {t('Objects are copied on the server — nothing is downloaded to this computer.')}
            </p>
          </>
        )}
        {(value || dialog.kind === 'copy') && dialog.kind !== 'deleteVersions' && problem && (
          <p className="text-xs text-danger">{problem}</p>
        )}
        {dialog.kind === 'delete' && (
          <>
            <p className="text-[13px]">
              {dialog.entries.length === 1 ? (
                <>
                  {t('Delete')} <strong className="break-all">{dialog.entries[0]?.name}</strong>
                  {folders > 0 ? ` ${t('and everything inside it?')}` : '?'}
                </>
              ) : folders > 0 ? (
                tn(
                  dialog.entries.length,
                  'Delete this {n} item, including everything inside the folders?',
                  'Delete these {n} items, including everything inside the folders?'
                )
              ) : (
                tn(dialog.entries.length, 'Delete this {n} item?', 'Delete these {n} items?')
              )}
            </p>
            {dialog.entries.length > 1 && (
              <ul className="max-h-32 overflow-auto rounded-md border border-line bg-subtle px-2.5 py-1.5 font-mono text-xs text-muted">
                {dialog.entries.slice(0, 50).map((e) => (
                  <li key={e.key} className="flex items-center gap-1.5 truncate py-0.5">
                    {e.isFolder ? (
                      <Folder size={12} className="shrink-0 text-accent" />
                    ) : (
                      <File size={12} className="shrink-0" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </li>
                ))}
                {dialog.entries.length > 50 && (
                  <li className="py-0.5 text-faint">
                    {t('…and {n} more', { n: formatNumber(dialog.entries.length - 50) })}
                  </li>
                )}
              </ul>
            )}
            {folders > 0 && (
              <p className="text-xs text-muted" data-testid="s3-delete-count">
                {count === null
                  ? t('Counting objects…')
                  : count.more
                    ? t('This deletes more than {n} objects.', { n: formatNumber(count.count) })
                    : tn(count.count, 'This deletes {n} object.', 'This deletes {n} objects.')}
              </p>
            )}
            {typeName !== undefined && (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">
                  {t('Type {name} to confirm', { name: typeName })}
                </span>
                <Input
                  autoFocus
                  mono
                  value={value}
                  data-testid="s3-delete-typed"
                  onPaste={(e) => {
                    e.preventDefault()
                  }}
                  onChange={(e) => {
                    setValue(e.target.value)
                  }}
                />
              </label>
            )}
            {versioning === 'Enabled' || versioning === 'Suspended' ? (
              <p className="text-xs text-warning">
                {versioning === 'Enabled'
                  ? t(
                      'Versioning is on for this bucket: the objects get a delete marker, and earlier versions stay in the bucket (and keep using storage) until you remove them. Use “Show versions” to restore them.'
                    )
                  : t(
                      'Versioning is suspended for this bucket: the objects get a delete marker, and earlier versions stay in the bucket (and keep using storage) until you remove them. Use “Show versions” to restore them.'
                    )}
              </p>
            ) : (
              <p className="text-xs text-danger">{t('This cannot be undone.')}</p>
            )}
          </>
        )}
        {dialog.kind === 'link' && bucket !== null && (
          <ShareLink run={run} bucket={bucket} objectKey={dialog.entry.key} />
        )}
        {dialog.kind === 'deleteVersions' && (
          <DeleteVersionsBody versions={dialog.versions} confirm={value} onConfirm={setValue} />
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  )
}

/** Nội dung hộp thoại xoá vĩnh viễn phiên bản: danh sách + ô gõ "delete" khi có dữ liệu thật. */
function DeleteVersionsBody({
  versions,
  confirm,
  onConfirm
}: {
  versions: readonly S3Version[]
  confirm: string
  onConfirm: (value: string) => void
}): React.JSX.Element {
  const data = versions.filter((v) => !v.deleteMarker)
  const markers = versions.length - data.length
  return (
    <>
      <p className="text-[13px]">
        {data.length === 0
          ? tn(
              markers,
              'Remove {n} delete marker? The previous version becomes the current object again.',
              'Remove {n} delete markers? The previous versions become the current objects again.'
            )
          : tn(
              versions.length,
              'Permanently delete {n} version? It cannot be recovered.',
              'Permanently delete {n} versions? They cannot be recovered.'
            )}
      </p>
      <ul className="max-h-40 overflow-auto rounded-md border border-line bg-subtle px-2.5 py-1.5 font-mono text-xs text-muted">
        {versions.slice(0, 50).map((v) => (
          <li key={`${v.key}:${v.versionId}`} className="flex items-center gap-1.5 py-0.5">
            <History size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={v.key}>
              {v.name || v.key}
            </span>
            <span className="shrink-0 text-faint" title={v.versionId}>
              {v.deleteMarker ? t('delete marker') : shortVersionId(v.versionId)}
            </span>
          </li>
        ))}
        {versions.length > 50 && (
          <li className="py-0.5 text-faint">
            {t('…and {n} more', { n: formatNumber(versions.length - 50) })}
          </li>
        )}
      </ul>
      {data.length > 0 && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">
            {t('Type “{word}” to confirm', { word: CONFIRM_WORD })}
          </span>
          <Input
            autoFocus
            mono
            data-testid="s3-confirm-word"
            value={confirm}
            onChange={(e) => {
              onConfirm(e.target.value)
            }}
          />
        </label>
      )}
    </>
  )
}
