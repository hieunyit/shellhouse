import { Field, SectionTitle, Select } from '../../../renderer/src/components/ui'
import { t, updateModuleSettings, useModuleSettings } from '../../registry/renderer-kit'
import { S3Settings as Schema } from '../shared/settings'

/** Settings → Modules → S3 storage. */
export function S3Settings(): React.JSX.Element {
  const settings = useModuleSettings('s3', Schema)
  return (
    <div className="flex flex-col gap-4" data-testid="settings-module-s3">
      <SectionTitle
        description={t(
          'How many requests run at the same time. Higher is faster on fast links and big buckets; lower is gentler on small or self-hosted services (they may answer “SlowDown”). Applies to newly opened tabs.'
        )}
      >
        {t('Performance')}
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Parallel requests')} hint={t('Listing, sizes, copy and delete')}>
          <Select
            data-testid="setting-s3-requests"
            value={String(settings.requests)}
            onChange={(e) => void updateModuleSettings('s3', { requests: Number(e.target.value) })}
          >
            {[4, 8, 16, 32, 64].map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 16 ? ` (${t('default')})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Files at once')} hint={t('Large files also upload in parallel parts')}>
          <Select
            data-testid="setting-s3-transfers"
            value={String(settings.transfers)}
            onChange={(e) => void updateModuleSettings('s3', { transfers: Number(e.target.value) })}
          >
            {[1, 2, 4, 6, 8, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 6 ? ` (${t('default')})` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  )
}
