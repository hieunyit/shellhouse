import { useRef } from 'react'
import { Folder, Laptop } from 'lucide-react'
import { t } from '@shared/i18n'
import { Breadcrumb } from '../ds'
import { ICON_SM } from '../ds/utils'
import { LocalPanel } from '../terminal/LocalPanel'
import type { SftpActions } from '../terminal/SftpPanel'

const NO_TRANSFERS: never[] = []
const ignore = (): void => undefined

/**
 * Files › This computer: duyệt file trên máy này (mở, đổi tên, xoá, kéo thả…). Chọn một host ở
 * Explorer để mở trình quản lý file hai khung Local ⇄ Remote.
 */
export function LocalFilesPage(): React.JSX.Element {
  const actions = useRef<SftpActions | null>(null)
  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-surface-0" data-testid="local-files">
      <div className="flex h-ds-header shrink-0 items-center gap-2 border-b border-ds-border-subtle pr-2 pl-3">
        <Breadcrumb
          items={[
            { id: 'files', label: t('Files'), icon: <Folder {...ICON_SM} /> },
            { id: 'local', label: t('This computer'), icon: <Laptop {...ICON_SM} /> }
          ]}
          className="min-w-0 flex-1"
        />
        <span className="text-ds-sm text-ds-fg-3">
          {t('Pick a host in the sidebar to copy files to or from it.')}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <LocalPanel transfers={NO_TRANSFERS} actionsRef={actions} onTargetChange={ignore} />
      </div>
    </div>
  )
}
