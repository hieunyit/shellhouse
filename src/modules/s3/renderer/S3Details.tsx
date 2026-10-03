import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Check,
  Copy,
  Download,
  File,
  Globe,
  History,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import type { S3AccountSummary, S3BucketInfo, S3Op } from '../shared/ops'
import {
  MAX_S3_TAGS,
  objectEditProblem,
  objectHttpUrl,
  shortVersionId,
  tagsProblem,
  type S3Feature,
  type S3MetaEntry,
  type S3ObjectDetails,
  type S3Tag,
  type S3Version
} from '../shared/manage'
import { Button, cx, IconButton, Input, Notice } from '../../../renderer/src/components/ui'
import {
  confirmAction,
  formatDateTime,
  formatNumber,
  formatRelative,
  t,
  toast
} from '../../registry/renderer-kit'
import { cleanError, formatSize } from './format'
import { storageClassLabel } from './parts'
import { ShareLink } from './ShareLink'

/** Object (hoặc một phiên bản) đang xem trong bảng chi tiết. */
export interface DetailsTarget {
  key: string
  name: string
  /** Không có = bản hiện tại. */
  versionId?: string | undefined
}

/** Dòng "nhãn: giá trị" của phần Overview. */
function Prop({
  label,
  children,
  mono,
  copy
}: {
  label: string
  children: ReactNode
  mono?: boolean
  copy?: string | null | undefined
}): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <div className="group grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2 py-1 text-xs">
      <dt className="text-faint">{label}</dt>
      <dd
        className={cx('flex min-w-0 items-start gap-1 text-fg', mono && 'font-mono text-[11.5px]')}
      >
        <span className="min-w-0 flex-1 break-all">{children}</span>
        {copy && (
          <button
            type="button"
            aria-label={t('Copy {name}', { name: label })}
            title={t('Copy')}
            className="shrink-0 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
            onClick={() => {
              void window.shellhouse.writeClipboard(copy).then(() => {
                setDone(true)
                setTimeout(() => {
                  setDone(false)
                }, 1200)
              })
            }}
          >
            {done ? <Check size={11} /> : <Copy size={11} />}
          </button>
        )}
      </dd>
    </div>
  )
}

function Section({
  title,
  children,
  aside,
  testId
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <section className="border-t border-line px-3 py-3" data-testid={testId}>
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
        <span className="flex-1">{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  )
}

/** Thông báo cho cấu hình dịch vụ không hỗ trợ / không có quyền / lỗi. */
export function FeatureNotice({
  feature
}: {
  feature: Exclude<S3Feature<unknown>, { state: 'ok' }>
}): React.JSX.Element {
  return (
    <p className="text-xs text-faint" data-testid="s3-feature-unavailable">
      {feature.state === 'unsupported'
        ? t('Not supported by this provider')
        : feature.state === 'denied'
          ? t('This key is not allowed to read it')
          : feature.message}
    </p>
  )
}

/** Danh sách cặp khoá / giá trị sửa được (metadata, tag). */
function PairsEditor({
  pairs,
  onChange,
  max,
  keyPlaceholder,
  addLabel,
  emptyLabel,
  testId,
  readOnly
}: {
  pairs: { key: string; value: string }[]
  onChange: (pairs: { key: string; value: string }[]) => void
  max: number
  keyPlaceholder: string
  addLabel: string
  emptyLabel: string
  testId: string
  readOnly?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {pairs.length === 0 && <p className="text-xs text-faint">{emptyLabel}</p>}
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            mono
            readOnly={readOnly}
            aria-label={t('Key')}
            placeholder={keyPlaceholder}
            className="h-7 min-w-0 flex-1 text-xs"
            value={p.key}
            onChange={(e) => {
              onChange(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
            }}
          />
          <Input
            mono
            readOnly={readOnly}
            aria-label={t('Value')}
            placeholder={t('value')}
            className="h-7 min-w-0 flex-1 text-xs"
            value={p.value}
            onChange={(e) => {
              onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }}
          />
          {!readOnly && (
            <IconButton
              label={t('Remove')}
              size="sm"
              onClick={() => {
                onChange(pairs.filter((_, j) => j !== i))
              }}
            >
              <X size={12} />
            </IconButton>
          )}
        </div>
      ))}
      {!readOnly && pairs.length < max && (
        <button
          type="button"
          className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs text-accent hover:underline"
          onClick={() => {
            onChange([...pairs, { key: '', value: '' }])
          }}
        >
          <Plus size={12} /> {addLabel}
        </button>
      )}
    </div>
  )
}

const samePairs = (a: readonly S3Tag[], b: readonly S3Tag[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]
    return y !== undefined && x.key === y.key && x.value === y.value
  })

/** Bảng chi tiết bên phải danh sách: thông tin, metadata, tag, phiên bản, link chia sẻ. */
export function S3DetailsPanel({
  run,
  account,
  bucket,
  bucketRegion,
  target,
  reloadKey,
  onClose,
  onChanged,
  onSelectVersion,
  onDeleteVersions,
  onOpenSettings
}: {
  run: (op: S3Op) => Promise<unknown>
  account: S3AccountSummary | undefined
  bucket: string
  bucketRegion: string | null
  target: DetailsTarget | null
  reloadKey: number
  onClose: () => void
  /** Object đã đổi (metadata / khôi phục phiên bản) — làm mới danh sách. */
  onChanged: () => void
  onSelectVersion: (target: DetailsTarget) => void
  onDeleteVersions: (versions: S3Version[]) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const [details, setDetails] = useState<S3ObjectDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Lần tải xong gần nhất (khoá = object + phiên bản + lượt làm mới) — khác hiện tại = đang tải. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<{
    for: string
    versioning: S3BucketInfo['versioning']
    versions: S3Feature<S3Version[]> | null
  } | null>(null)
  /** Bấm Refresh / vừa lưu → tải lại. */
  const [refresh, setRefresh] = useState(0)
  // Phần đang sửa.
  const [contentType, setContentType] = useState('')
  const [cacheControl, setCacheControl] = useState('')
  const [disposition, setDisposition] = useState('')
  const [meta, setMeta] = useState<S3MetaEntry[]>([])
  const [tags, setTags] = useState<S3Tag[]>([])
  const [saving, setSaving] = useState<'props' | 'tags' | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const key = target?.key ?? null
  const versionId = target?.versionId
  const loadId = `${key ?? ''}\u0000${versionId ?? ''}\u0000${String(reloadKey)}:${String(refresh)}`
  const versionsId = `${key ?? ''}\u0000${String(reloadKey)}:${String(refresh)}`
  const loading = key !== null && loadedFor !== loadId
  const versioning = versionInfo?.for === versionsId ? versionInfo.versioning : undefined
  const versions = versionInfo?.for === versionsId ? versionInfo.versions : null

  const fill = useCallback((d: S3ObjectDetails): void => {
    setDetails(d)
    setContentType(d.contentType ?? '')
    setCacheControl(d.cacheControl ?? '')
    setDisposition(d.contentDisposition ?? '')
    setMeta(Object.entries(d.metadata).map(([k, value]) => ({ key: k, value })))
    setTags(d.tags.state === 'ok' ? d.tags.value : [])
  }, [])

  // Thông tin object (HeadObject + tag).
  useEffect(() => {
    if (key === null) return
    let alive = true
    run({ op: 'objectDetails', bucket, key, ...(versionId ? { versionId } : {}) }).then(
      (d) => {
        if (!alive) return
        fill(d as S3ObjectDetails)
        setError(null)
        setLoadedFor(loadId)
      },
      (e: unknown) => {
        if (!alive) return
        setDetails(null)
        setError(cleanError(e))
        setLoadedFor(loadId)
      }
    )
    return () => {
      alive = false
    }
  }, [run, bucket, key, versionId, loadId, fill])

  // Versioning của bucket (nhớ trong phiên) rồi danh sách phiên bản của object.
  useEffect(() => {
    if (key === null) return
    const life = { alive: true }
    void (async () => {
      const status = (await run({ op: 'versioning', bucket }).catch(() => null)) as
        S3BucketInfo['versioning'] | null
      const list =
        status === 'Enabled' || status === 'Suspended'
          ? ((await run({ op: 'objectVersions', bucket, key }).catch((e: unknown) => ({
              state: 'error',
              message: cleanError(e)
            }))) as S3Feature<S3Version[]>)
          : null
      if (life.alive) setVersionInfo({ for: versionsId, versioning: status, versions: list })
    })()
    return () => {
      life.alive = false
    }
  }, [run, bucket, key, versionsId])

  const reloadAll = (): void => {
    setRefresh((n) => n + 1)
  }

  if (!target)
    return (
      <aside
        className="flex w-80 shrink-0 flex-col items-center justify-center gap-2 border-l border-line px-6 text-center text-xs text-faint"
        data-testid="s3-details"
      >
        <File size={20} />
        {t('Select a file to see its details.')}
      </aside>
    )

  // Đang xem một phiên bản cụ thể: chỉ sửa được khi đó là bản mới nhất.
  const current =
    !versionId ||
    (versions?.state === 'ok' &&
      versions.value.find((v) => v.versionId === versionId)?.isLatest === true)
  const editable = details !== null && current
  const edit = { contentType, cacheControl, contentDisposition: disposition, metadata: meta }
  const propsDirty =
    details !== null &&
    (contentType !== (details.contentType ?? '') ||
      cacheControl !== (details.cacheControl ?? '') ||
      disposition !== (details.contentDisposition ?? '') ||
      !samePairs(
        meta,
        Object.entries(details.metadata).map(([k, value]) => ({ key: k, value }))
      ))
  const propsProblem = propsDirty ? objectEditProblem(edit) : null
  const savedTags = details?.tags.state === 'ok' ? details.tags.value : []
  const tagsDirty = details !== null && !samePairs(tags, savedTags)
  const tagProblem = tagsDirty ? tagsProblem(tags) : null
  const s3Uri = `s3://${bucket}/${target.key}`
  const httpUrl = account ? objectHttpUrl(account, bucket, target.key, bucketRegion) : null

  const copyText = (what: string, text: string): void => {
    void window.shellhouse.writeClipboard(text).then(() => {
      setCopied(what)
      setTimeout(() => {
        setCopied((c) => (c === what ? null : c))
      }, 1200)
    })
  }

  const saveProps = async (): Promise<void> => {
    if (!details || propsProblem) return
    setSaving('props')
    try {
      const d = (await run({
        op: 'updateObject',
        bucket,
        key: target.key,
        edit,
        ...(details.etag ? { expectEtag: details.etag } : {})
      })) as S3ObjectDetails
      fill(d)
      toast.success(t('Saved the properties of “{name}”', { name: target.name }))
      onChanged()
    } catch (e) {
      toast.error(t('Could not save the properties'), { description: cleanError(e) })
    } finally {
      setSaving(null)
    }
  }

  const saveTags = async (): Promise<void> => {
    if (!details || tagProblem) return
    setSaving('tags')
    try {
      const clean = tags.map((x) => ({ key: x.key.trim(), value: x.value }))
      await run({
        op: 'putTags',
        bucket,
        key: target.key,
        tags: clean,
        ...(versionId ? { versionId } : {})
      })
      setDetails({ ...details, tags: { state: 'ok', value: clean } })
      setTags(clean)
      toast.success(t('Saved the tags of “{name}”', { name: target.name }))
    } catch (e) {
      toast.error(t('Could not save the tags'), { description: cleanError(e) })
    } finally {
      setSaving(null)
    }
  }

  const download = async (): Promise<void> => {
    const path = await window.shellhouse.pickSaveLocation(target.name)
    if (!path) return
    try {
      await run({
        op: 'download',
        bucket,
        key: target.key,
        localPath: path,
        overwrite: true,
        ...(versionId ? { versionId } : {})
      })
    } catch (e) {
      toast.error(t('Could not download “{name}”', { name: target.name }), {
        description: cleanError(e)
      })
    }
  }

  const restore = async (v: S3Version): Promise<void> => {
    const ok = await confirmAction({
      title: t('Restore this version?'),
      message: t(
        'A copy of the version from {date} becomes the current “{name}”. Newer versions stay in the history.',
        { date: v.modified ? formatDateTime(v.modified) : '—', name: target.name }
      ),
      confirmLabel: t('Restore'),
      testId: 's3-restore-confirm'
    })
    if (!ok) return
    try {
      await run({ op: 'restoreVersion', bucket, key: v.key, versionId: v.versionId })
      toast.success(t('Restored “{name}”', { name: target.name }))
      onChanged()
      onSelectVersion({ key: target.key, name: target.name })
      reloadAll()
    } catch (e) {
      toast.error(t('Could not restore the version'), { description: cleanError(e) })
    }
  }

  return (
    <aside
      className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-line bg-surface"
      data-testid="s3-details"
      aria-label={t('Details')}
    >
      <header className="flex items-start gap-2 px-3 pt-3 pb-2">
        <File size={16} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold break-all text-fg" data-testid="s3-details-name">
            {target.name}
          </h2>
          {versionId && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-faint">
              <History size={11} />
              {current ? t('Current version') : t('Older version')} ·{' '}
              <span className="font-mono" title={versionId}>
                {shortVersionId(versionId)}
              </span>
            </p>
          )}
        </div>
        <IconButton label={t('Refresh')} size="sm" onClick={reloadAll}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </IconButton>
        <IconButton label={t('Close details')} size="sm" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </header>
      <div className="flex flex-wrap gap-1 px-3 pb-3">
        <Button
          size="sm"
          icon={copied === 'uri' ? <Check size={12} /> : <Copy size={12} />}
          data-testid="s3-details-copy-uri"
          title={s3Uri}
          onClick={() => {
            copyText('uri', s3Uri)
          }}
        >
          {t('S3 URI')}
        </Button>
        {httpUrl && (
          <Button
            size="sm"
            icon={copied === 'url' ? <Check size={12} /> : <Globe size={12} />}
            data-testid="s3-details-copy-url"
            title={t('{url} — opens only if the object is public; use a share link otherwise', {
              url: httpUrl
            })}
            onClick={() => {
              copyText('url', httpUrl)
            }}
          >
            {t('URL')}
          </Button>
        )}
        <Button
          size="sm"
          icon={<Download size={12} />}
          data-testid="s3-details-download"
          onClick={() => void download()}
        >
          {t('Download')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="px-3 pb-3">
            <Notice tone="danger" testId="s3-details-error">
              {error}
            </Notice>
          </div>
        )}
        {!details && loading && (
          <p className="flex items-center gap-2 px-3 pb-3 text-xs text-faint">
            <RefreshCw size={12} className="animate-spin" /> {t('Loading…')}
          </p>
        )}
        {details && (
          <>
            <Section title={t('Overview')} testId="s3-details-overview">
              <dl>
                <Prop label={t('Key')} mono copy={details.key}>
                  {details.key}
                </Prop>
                <Prop label={t('Size')}>
                  {formatSize(details.size)}
                  {details.size >= 1000 && (
                    <span className="text-faint">
                      {' '}
                      ({t('{n} bytes', { n: formatNumber(details.size) })})
                    </span>
                  )}
                </Prop>
                <Prop label={t('Last modified')}>
                  {details.lastModified ? (
                    <>
                      {formatDateTime(details.lastModified)}
                      <span className="text-faint"> · {formatRelative(details.lastModified)}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </Prop>
                <Prop label={t('Storage class')}>{storageClassLabel(details.storageClass)}</Prop>
                <Prop label={t('Content type')} mono>
                  {details.contentType ?? '—'}
                </Prop>
                <Prop label="ETag" mono copy={details.etag?.replace(/"/g, '')}>
                  {details.etag?.replace(/"/g, '') ?? '—'}
                </Prop>
                {details.versionId && details.versionId !== 'null' && (
                  <Prop label={t('Version ID')} mono copy={details.versionId}>
                    {details.versionId}
                  </Prop>
                )}
                <Prop label={t('Encryption')}>{details.encryption ?? t('None reported')}</Prop>
                {details.restore && <Prop label={t('Archive restore')}>{details.restore}</Prop>}
              </dl>
            </Section>

            <Section title={t('Properties & metadata')} testId="s3-details-props">
              {!editable && (
                <p className="mb-2 text-xs text-faint">
                  {t('Older versions are read-only. Restore the version to change it.')}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {(
                  [
                    ['Content-Type', contentType, setContentType, 'application/octet-stream', 'ct'],
                    ['Cache-Control', cacheControl, setCacheControl, 'max-age=3600', 'cc'],
                    [
                      'Content-Disposition',
                      disposition,
                      setDisposition,
                      'attachment; filename="report.pdf"',
                      'cd'
                    ]
                  ] as const
                ).map(([label, value, set, placeholder, id]) => (
                  <label key={id} className="flex flex-col gap-1">
                    <span className="text-[11px] text-faint">{label}</span>
                    <Input
                      mono
                      readOnly={!editable}
                      className="h-7 text-xs"
                      placeholder={placeholder}
                      data-testid={`s3-details-${id}`}
                      value={value}
                      onChange={(e) => {
                        set(e.target.value)
                      }}
                    />
                  </label>
                ))}
                <span className="mt-1 text-[11px] text-faint">
                  {t('User metadata (x-amz-meta-*)')}
                </span>
                <PairsEditor
                  pairs={meta}
                  onChange={setMeta}
                  max={100}
                  keyPlaceholder="author"
                  addLabel={t('Add metadata')}
                  emptyLabel={t('No metadata')}
                  testId="s3-details-meta"
                  readOnly={!editable}
                />
              </div>
              {propsProblem && <p className="mt-2 text-xs text-danger">{propsProblem}</p>}
              {editable && propsDirty && (
                <div className="mt-2.5 flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!!propsProblem || saving !== null}
                    data-testid="s3-details-save-props"
                    onClick={() => void saveProps()}
                  >
                    {saving === 'props' ? t('Saving…') : t('Save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      fill(details)
                    }}
                  >
                    {t('Reset')}
                  </Button>
                  <span className="min-w-0 flex-1 text-[11px] leading-tight text-faint">
                    {t('Copies the object onto itself; storage class and tags are kept.')}
                  </span>
                </div>
              )}
            </Section>

            <Section
              title={t('Tags')}
              testId="s3-details-tags"
              aside={
                details.tags.state === 'ok' ? (
                  <span className="font-normal tracking-normal normal-case">
                    {tags.length}/{MAX_S3_TAGS}
                  </span>
                ) : undefined
              }
            >
              {details.tags.state === 'ok' ? (
                <>
                  <PairsEditor
                    pairs={tags}
                    onChange={setTags}
                    max={MAX_S3_TAGS}
                    keyPlaceholder="project"
                    addLabel={t('Add tag')}
                    emptyLabel={t('No tags')}
                    testId="s3-details-tag-list"
                  />
                  {tagProblem && <p className="mt-2 text-xs text-danger">{tagProblem}</p>}
                  {tagsDirty && (
                    <div className="mt-2.5 flex gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!!tagProblem || saving !== null}
                        data-testid="s3-details-save-tags"
                        onClick={() => void saveTags()}
                      >
                        {saving === 'tags' ? t('Saving…') : t('Save tags')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setTags(savedTags)
                        }}
                      >
                        {t('Reset')}
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <FeatureNotice feature={details.tags} />
              )}
            </Section>
          </>
        )}

        <Section title={t('Versions')} testId="s3-details-versions">
          {versioning === undefined ? (
            <p className="text-xs text-faint">{t('Loading…')}</p>
          ) : versioning === null || versioning === 'Off' ? (
            <div className="flex flex-col items-start gap-1.5">
              <p className="text-xs text-faint">
                {versioning === null
                  ? t('Versioning is not available for this bucket.')
                  : t('Versioning is off for this bucket — only the current version is kept.')}
              </p>
              {versioning === 'Off' && (
                <Button size="sm" icon={<Settings2 size={12} />} onClick={onOpenSettings}>
                  {t('Bucket settings…')}
                </Button>
              )}
            </div>
          ) : versions === null ? (
            <p className="text-xs text-faint">{t('Loading…')}</p>
          ) : versions.state !== 'ok' ? (
            <FeatureNotice feature={versions} />
          ) : (
            <ul className="-mx-1 flex flex-col">
              {versions.value.map((v) => {
                const viewing = versionId ? v.versionId === versionId : v.isLatest
                return (
                  <li
                    key={v.versionId}
                    data-testid="s3-details-version"
                    data-latest={v.isLatest}
                    className={cx(
                      'group flex items-center gap-2 rounded-md px-1 py-1 text-xs',
                      viewing ? 'bg-accent-soft' : 'hover:bg-hover'
                    )}
                  >
                    <button
                      type="button"
                      disabled={v.deleteMarker}
                      className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
                      onClick={() => {
                        onSelectVersion(
                          v.isLatest
                            ? { key: target.key, name: target.name }
                            : { key: target.key, name: target.name, versionId: v.versionId }
                        )
                      }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="text-fg tabular-nums">
                          {v.modified ? formatDateTime(v.modified) : '—'}
                        </span>
                        {v.isLatest && (
                          <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">
                            {v.deleteMarker ? t('Deleted') : t('Current')}
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-faint">
                        {v.deleteMarker ? t('Delete marker') : formatSize(v.size)} ·{' '}
                        <span className="font-mono" title={v.versionId}>
                          {shortVersionId(v.versionId)}
                        </span>
                      </span>
                    </button>
                    {!v.deleteMarker && !v.isLatest && (
                      <IconButton
                        label={t('Restore this version')}
                        size="sm"
                        data-testid="s3-details-restore"
                        onClick={() => void restore(v)}
                      >
                        <RotateCcw size={12} />
                      </IconButton>
                    )}
                    <IconButton
                      label={v.deleteMarker ? t('Remove delete marker…') : t('Delete permanently…')}
                      size="sm"
                      data-testid="s3-details-delete-version"
                      onClick={() => {
                        onDeleteVersions([v])
                      }}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section title={t('Share link')} testId="s3-details-share">
          <ShareLink
            run={run}
            bucket={bucket}
            objectKey={target.key}
            versionId={versionId}
            compact
          />
        </Section>
      </div>
    </aside>
  )
}
