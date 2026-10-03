import { useEffect, useMemo, useState } from 'react'
import { Download, FileQuestion, Loader2 } from 'lucide-react'
import { formatSize, cleanError } from '../../lib/format'
import { t } from '@shared/i18n'
import { Button, Modal, Notice } from '../ui'

export interface PreviewData {
  size: number
  /** base64 của phần đầu file. */
  data: string
  truncated: boolean
}

const IMAGE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/** Giới hạn đọc: văn bản 256 KB đầu, ảnh tới 8 MB. */
export const PREVIEW_TEXT_BYTES = 256 * 1024
export const PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024

export function previewBytes(name: string): number {
  return IMAGE[extension(name)] ? PREVIEW_IMAGE_BYTES : PREVIEW_TEXT_BYTES
}

const extension = (name: string): string => name.split('.').at(-1)?.toLowerCase() ?? ''

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Nhị phân: có byte NUL hoặc quá nhiều ký tự điều khiển trong phần đầu. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000)
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i] ?? 0
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) control++
  }
  return n > 0 && control / n > 0.1
}

/**
 * Xem nhanh file (SFTP / S3): ảnh hiện trực tiếp, văn bản có số dòng (phần đầu nếu file lớn),
 * file nhị phân → báo không xem được, gợi ý tải về.
 */
export function FilePreview({
  name,
  load,
  onClose,
  onDownload
}: {
  name: string
  load: () => Promise<PreviewData>
  onClose: () => void
  onDownload?: () => void
}): React.JSX.Element {
  const [data, setData] = useState<PreviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    load().then(
      (d) => {
        if (!cancelled) setData(d)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [load])

  const mime = IMAGE[extension(name)]
  const view = useMemo(() => {
    if (!data) return null
    if (mime) {
      if (data.truncated) return { kind: 'too-big' as const }
      return { kind: 'image' as const, src: `data:${mime};base64,${data.data}` }
    }
    const bytes = decode(data.data)
    if (looksBinary(bytes)) return { kind: 'binary' as const }
    const text = new TextDecoder('utf-8').decode(bytes)
    return { kind: 'text' as const, lines: text.split(/\r?\n/) }
  }, [data, mime])

  return (
    <Modal
      title={name}
      description={data ? formatSize(data.size) : undefined}
      onClose={onClose}
      width="max-w-4xl"
      testId="file-preview"
      footer={
        <>
          {onDownload && (
            <Button
              variant="ghost"
              icon={<Download size={14} />}
              onClick={() => {
                onDownload()
                onClose()
              }}
            >
              {t('Download')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && !error && (
        <div className="flex h-40 items-center justify-center gap-2 text-xs text-faint">
          <Loader2 size={14} className="animate-spin" /> {t('Loading preview…')}
        </div>
      )}
      {view?.kind === 'image' && (
        <div className="flex max-h-[65vh] items-center justify-center overflow-auto rounded-md bg-[repeating-conic-gradient(var(--sh-subtle)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-2">
          <img
            src={view.src}
            alt={name}
            className="max-h-[62vh] max-w-full object-contain"
            data-testid="file-preview-image"
          />
        </div>
      )}
      {view?.kind === 'text' && (
        <>
          {data?.truncated && (
            <p className="mb-2 text-xs text-faint">
              {t('Showing the first {shown} of {size}.', {
                shown: formatSize(PREVIEW_TEXT_BYTES),
                size: formatSize(data.size)
              })}
            </p>
          )}
          <pre
            className="max-h-[62vh] overflow-auto rounded-md border border-line bg-subtle py-2 font-mono text-[11.5px] leading-relaxed text-fg select-text"
            data-testid="file-preview-text"
          >
            {view.lines.map((line, i) => (
              <div key={i} className="flex">
                <span className="w-12 shrink-0 pr-3 text-right text-faint select-none">
                  {i + 1}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-all">{line}</span>
              </div>
            ))}
          </pre>
        </>
      )}
      {(view?.kind === 'binary' || view?.kind === 'too-big') && (
        <div
          className="flex h-40 flex-col items-center justify-center gap-2 text-center text-xs text-muted"
          data-testid="file-preview-none"
        >
          <FileQuestion size={28} className="text-faint" />
          {view.kind === 'binary'
            ? t('This file is not text or an image — download it to open it.')
            : t('This image is larger than {size} — download it to view it.', {
                size: formatSize(PREVIEW_IMAGE_BYTES)
              })}
        </div>
      )}
    </Modal>
  )
}
