import { t } from '@shared/i18n'
import { Modal } from '../ui'
import { Keychain } from './Keychain'

export { AccountBadges } from './AccountBadges'

/**
 * Keychain trong hộp thoại — mở từ form host ("Manage accounts…") để không rời form đang sửa. Mặc
 * định lọc sẵn Accounts; đổi sang SSH key ngay trong hộp thoại.
 */
export function AccountsDialog({
  onClose,
  filter = 'accounts'
}: {
  onClose: () => void
  filter?: 'all' | 'accounts' | 'keys'
}): React.JSX.Element {
  return (
    <Modal
      title={t('Keychain')}
      description={t('Accounts and SSH keys shared by your hosts.')}
      onClose={onClose}
      width="max-w-4xl"
      testId="accounts-dialog"
      bodyClassName="px-0 pb-0"
    >
      <div className="h-[32rem] border-t border-line">
        <Keychain initialFilter={filter} />
      </div>
    </Modal>
  )
}
