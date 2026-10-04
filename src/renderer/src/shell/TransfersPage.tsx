import { ArrowLeftRight, ExternalLink } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button, EmptyState } from '../ds'
import { ICON, ICON_SM } from '../ds/utils'
import { TransferList } from '../components/files/TransferList'
import { useTransfers } from '../stores/transfers'
import { TRANSFER_FILTERS, matchesFilter, useTransfersFilter } from './transfers-filter'

/**
 * Trung tâm truyền file: mọi lượt SFTP / S3 đang có, nhóm theo nguồn, lọc theo trạng thái (Explorer).
 * Thao tác (huỷ, thử lại, bỏ, dọn) giống danh sách trong panel của từng nguồn.
 */
export function TransfersPage(): React.JSX.Element {
  const sources = Object.values(useTransfers((s) => s.sources))
  const filter = useTransfersFilter((s) => s.filter)
  const visible = sources
    .map((src) => ({ src, list: src.transfers.filter((x) => matchesFilter(x, filter)) }))
    .filter((x) => x.list.length > 0)
  const filterTitle = TRANSFER_FILTERS.find((f) => f.id === filter)?.title() ?? ''
  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-surface-0" data-testid="transfers-page">
      <div className="flex h-ds-header shrink-0 items-center gap-2 border-b border-ds-border-subtle px-4">
        <h1 className="text-ds-base font-semibold text-ds-fg">{t('Transfers')}</h1>
        {filter !== 'all' && <span className="text-ds-base text-ds-fg-3">· {filterTitle}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <EmptyState
            className="mt-16"
            icon={<ArrowLeftRight {...ICON} />}
            title={filter === 'all' ? t('No transfers') : t('Nothing here')}
            description={t(
              'Uploads and downloads from SFTP and S3 show up here while their tab is open.'
            )}
          />
        ) : (
          visible.map(({ src, list }) => (
            <section key={src.id} className="border-b border-ds-border-subtle">
              <div className="flex h-9 items-center gap-2 px-4">
                <span className="min-w-0 flex-1 truncate text-ds-base font-medium text-ds-fg">
                  {src.label}
                </span>
                <span className="text-ds-sm text-ds-fg-3 uppercase">{src.kind}</span>
                {src.reveal && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ExternalLink {...ICON_SM} />}
                    onClick={() => src.reveal?.()}
                  >
                    {t('Open')}
                  </Button>
                )}
              </div>
              <TransferList
                transfers={list}
                testId="transfers-center-list"
                rowTestId="transfers-center-row"
                onCancel={src.cancel}
                onClear={src.clear}
                {...(src.retry ? { onRetry: src.retry } : {})}
                {...(src.discard ? { onDiscard: src.discard } : {})}
              />
            </section>
          ))
        )}
      </div>
    </div>
  )
}
