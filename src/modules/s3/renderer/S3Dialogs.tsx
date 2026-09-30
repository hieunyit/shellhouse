import { useState } from 'react'
import { Check, Copy, File, Folder } from 'lucide-react'
import {
  bucketNameProblem,
  objectNameProblem,
  type S3Bucket,
  type S3Entry,
  type S3Op
} from '../shared/ops'
import { Button, Checkbox, Input, Modal, Notice, Select } from '../../../renderer/src/components/ui'
import { cleanError } from './format'

export type S3DialogState =
  | { kind: 'mkdir' }
  | { kind: 'bucket' }
  | { kind: 'delete'; entries: S3Entry[] }
  | { kind: 'link'; entry: S3Entry }
  | { kind: 'rename'; entry: S3Entry }
  | { kind: 'copy'; entries: S3Entry[]; move: boolean }
  | null

/** Hộp thoại của trình quản lý S3 (bucket / thư mục mới, xoá, link, đổi tên, copy/move). */
export function S3Dialog({
  dialog,
  buckets,
  bucket,
  prefix,
  run,
  onClose,
  onDone
}: {
  dialog: NonNullable<S3DialogState>
  buckets: S3Bucket[]
  bucket: string | null
  prefix: string
  run: (op: S3Op) => Promise<unknown>
  onClose: () => void
  onDone: (kind: NonNullable<S3DialogState>['kind']) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState(dialog.kind === 'rename' ? dialog.entry.name : '')
  const [destBucket, setDestBucket] = useState(bucket ?? '')
  const [destPrefix, setDestPrefix] = useState(prefix)
  const [overwrite, setOverwrite] = useState(false)
  const [expires, setExpires] = useState('3600')
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const problem =
    dialog.kind === 'bucket'
      ? value
        ? bucketNameProblem(value)
        : 'Enter a name'
      : dialog.kind === 'mkdir'
        ? !value.trim() || value.includes('/')
          ? 'Enter a folder name (no “/”)'
          : null
        : dialog.kind === 'rename'
          ? objectNameProblem(value)
          : dialog.kind === 'copy'
            ? destBucket
              ? destPrefix.startsWith('/') || destPrefix.includes('//')
                ? 'Use a path like logs/2024/ (no leading “/”)'
                : null
              : 'Choose a bucket'
            : null

  const submit = async (): Promise<void> => {
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      if (dialog.kind === 'bucket') await run({ op: 'createBucket', bucket: value })
      if (dialog.kind === 'mkdir' && bucket !== null)
        await run({ op: 'mkdir', bucket, key: `${prefix}${value.trim()}/` })
      if (dialog.kind === 'delete' && bucket !== null)
        await run({ op: 'delete', bucket, keys: dialog.entries.map((e) => e.key) })
      if (dialog.kind === 'rename' && bucket !== null)
        await run({ op: 'rename', bucket, key: dialog.entry.key, name: value, overwrite: false })
      if (dialog.kind === 'copy' && bucket !== null)
        await run({
          op: 'copy',
          bucket,
          keys: dialog.entries.map((e) => e.key),
          destBucket,
          destPrefix: destPrefix.trim(),
          move: dialog.move,
          overwrite
        })
      if (dialog.kind === 'link' && bucket !== null) {
        setUrl(
          (await run({
            op: 'presign',
            bucket,
            key: dialog.entry.key,
            expiresSeconds: Number(expires)
          })) as string
        )
        setBusy(false)
        return
      }
      await onDone(dialog.kind)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const titles = {
    bucket: 'New bucket',
    mkdir: 'New folder',
    delete: 'Delete',
    link: 'Share link',
    rename: 'Rename',
    copy: dialog.kind === 'copy' && dialog.move ? 'Move to' : 'Copy to'
  } as const
  const submitLabel = {
    bucket: 'Create',
    mkdir: 'Create',
    delete: 'Delete',
    link: 'Create link',
    rename: 'Rename',
    copy: dialog.kind === 'copy' && dialog.move ? 'Move' : 'Copy'
  } as const
  const folders = dialog.kind === 'delete' ? dialog.entries.filter((e) => e.isFolder).length : 0

  return (
    <Modal
      title={titles[dialog.kind]}
      onClose={onClose}
      width="max-w-md"
      testId="s3-dialog"
      footer={
        <>
          <Button onClick={onClose}>{url ? 'Close' : 'Cancel'}</Button>
          {!url && (
            <Button
              variant={dialog.kind === 'delete' ? 'danger' : 'primary'}
              disabled={!!problem || busy}
              data-testid="s3-dialog-submit"
              onClick={() => void submit()}
            >
              {busy && (dialog.kind === 'copy' || dialog.kind === 'rename')
                ? 'Working…'
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
            placeholder={dialog.kind === 'bucket' ? 'my-bucket' : 'folder name'}
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
              {dialog.move ? 'Move' : 'Copy'}{' '}
              {dialog.entries.length === 1 ? (
                <strong>{dialog.entries[0]?.name}</strong>
              ) : (
                `${dialog.entries.length} items`
              )}{' '}
              to:
            </p>
            <Select
              aria-label="Destination bucket"
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
              aria-label="Destination folder"
              placeholder="Folder (empty = bucket root), e.g. backups/2024/"
              data-testid="s3-copy-prefix"
              value={destPrefix}
              onChange={(e) => {
                setDestPrefix(e.target.value)
              }}
            />
            <Checkbox
              label="Replace objects that already exist"
              checked={overwrite}
              onChange={(e) => {
                setOverwrite(e.target.checked)
              }}
            />
            <p className="text-xs text-faint">
              Objects are copied on the server — nothing is downloaded to this computer.
            </p>
          </>
        )}
        {(value || dialog.kind === 'copy') && problem && (
          <p className="text-xs text-danger">{problem}</p>
        )}
        {dialog.kind === 'delete' && (
          <>
            <p className="text-[13px]">
              {dialog.entries.length === 1 ? (
                <>
                  Delete <strong className="break-all">{dialog.entries[0]?.name}</strong>
                  {folders > 0 ? ' and everything inside it' : ''}?
                </>
              ) : (
                <>
                  Delete these {dialog.entries.length} items
                  {folders > 0 ? ', including everything inside the folders' : ''}?
                </>
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
                  <li className="py-0.5 text-faint">…and {dialog.entries.length - 50} more</li>
                )}
              </ul>
            )}
            <p className="text-xs text-danger">This cannot be undone.</p>
          </>
        )}
        {dialog.kind === 'link' && (
          <>
            <p className="text-[13px]">
              Anyone with the link can download <strong>{dialog.entry.name}</strong> until it
              expires. No account is needed.
            </p>
            <Select
              value={expires}
              onChange={(e) => {
                setExpires(e.target.value)
                setUrl(null)
                setCopied(false)
              }}
            >
              <option value="3600">Valid for 1 hour</option>
              <option value="86400">Valid for 1 day</option>
              <option value="604800">Valid for 7 days (maximum)</option>
            </Select>
            {url && (
              <div className="flex gap-2">
                <Input
                  mono
                  readOnly
                  value={url}
                  data-testid="s3-link-url"
                  className="min-w-0 flex-1"
                />
                <Button
                  icon={copied ? <Check size={14} /> : <Copy size={14} />}
                  onClick={() => {
                    void window.shellhouse.writeClipboard(url).then(() => {
                      setCopied(true)
                    })
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  )
}
