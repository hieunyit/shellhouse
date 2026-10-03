import { useState } from 'react'
import { Check, Copy, Link } from 'lucide-react'
import type { S3Op } from '../shared/ops'
import { Button, Input, Notice, Segmented, Select } from '../../../renderer/src/components/ui'
import { formatDateTime, formatDuration, t } from '../../registry/renderer-kit'
import { cleanError } from './format'
import { shareLinkSeconds, type LinkUnit } from '../shared/manage'

type Preset = '3600' | '86400' | '604800' | 'custom'

/**
 * Tạo link tải có hạn cho một object (hoặc một phiên bản): chọn thời hạn (1 giờ / 1 ngày / 7 ngày /
 * tự nhập), hiện giờ hết hạn, sao chép. Không cần tài khoản để mở link.
 */
export function ShareLink({
  run,
  bucket,
  objectKey,
  versionId,
  compact = false
}: {
  run: (op: S3Op) => Promise<unknown>
  bucket: string
  objectKey: string
  versionId?: string | undefined
  /** Trong bảng chi tiết: gọn hơn, không có câu giải thích. */
  compact?: boolean
}): React.JSX.Element {
  const [preset, setPreset] = useState<Preset>('3600')
  const [amount, setAmount] = useState('12')
  const [unit, setUnit] = useState<LinkUnit>('hours')
  const [url, setUrl] = useState<{ url: string; expires: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seconds = preset === 'custom' ? shareLinkSeconds(amount, unit) : Number(preset)

  const reset = (): void => {
    setUrl(null)
    setCopied(false)
  }

  const create = async (): Promise<void> => {
    if (seconds === null) return
    setBusy(true)
    setError(null)
    try {
      const link = (await run({
        op: 'presign',
        bucket,
        key: objectKey,
        expiresSeconds: seconds,
        ...(versionId ? { versionId } : {})
      })) as string
      setUrl({ url: link, expires: Date.now() + seconds * 1000 })
      setCopied(false)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="s3-share-link">
      {!compact && (
        <p className="text-[13px]">
          {t(
            'Anyone with the link can download this object until it expires. No account is needed.'
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={preset}
          onChange={(v) => {
            setPreset(v)
            reset()
          }}
          testIdPrefix="s3-link-expiry"
          options={[
            { value: '3600', label: t('1 hour') },
            { value: '86400', label: t('1 day') },
            { value: '604800', label: t('7 days') },
            { value: 'custom', label: t('Custom') }
          ]}
        />
        {preset === 'custom' && (
          <span className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              aria-label={t('Link lifetime')}
              data-testid="s3-link-amount"
              className="w-20"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                reset()
              }}
            />
            <Select
              aria-label={t('Unit')}
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value as LinkUnit)
                reset()
              }}
            >
              <option value="minutes">{t('minutes')}</option>
              <option value="hours">{t('hours')}</option>
              <option value="days">{t('days')}</option>
            </Select>
          </span>
        )}
      </div>
      {seconds === null ? (
        <p className="text-xs text-danger">{t('Choose between 1 minute and 7 days')}</p>
      ) : (
        <p className="text-xs text-faint" data-testid="s3-link-expiry">
          {url
            ? t('Expires {when}', { when: formatDateTime(url.expires) })
            : t('Valid for {time} after you create it', { time: formatDuration(seconds * 1000) })}
          {versionId ? ` · ${t('Links to this version')}` : ''}
        </p>
      )}
      {url ? (
        <div className="flex gap-2">
          <Input
            mono
            readOnly
            value={url.url}
            data-testid="s3-link-url"
            className="min-w-0 flex-1"
            onFocus={(e) => {
              e.target.select()
            }}
          />
          <Button
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            data-testid="s3-link-copy"
            onClick={() => {
              void window.shellhouse.writeClipboard(url.url).then(() => {
                setCopied(true)
              })
            }}
          >
            {copied ? t('Copied') : t('Copy')}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            size={compact ? 'sm' : 'md'}
            variant={compact ? 'secondary' : 'primary'}
            icon={<Link size={13} />}
            disabled={seconds === null || busy}
            data-testid="s3-link-create"
            onClick={() => void create()}
          >
            {busy ? t('Creating…') : t('Create link')}
          </Button>
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  )
}
