import { t } from '@shared/i18n'
import { Keychain } from '../accounts/Keychain'
import type { KeychainFilter } from '../accounts/keychain-logic'

/**
 * Settings → Keychain: tài khoản dùng chung (username, mật khẩu, SSH key, passphrase) và SSH key
 * trong vault — một chỗ, như Keychain của Termius.
 */
export function KeychainSection({
  filter = 'all'
}: {
  filter?: KeychainFilter
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="settings-keychain">
      <header className="px-5 pt-5">
        <h3 className="text-sm font-semibold text-fg">{t('Keychain')}</h3>
        <p className="mt-0.5 text-xs text-muted">
          {t(
            'Accounts and SSH keys for your hosts, in one place. Secrets are stored encrypted in the vault.'
          )}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <Keychain initialFilter={filter} />
      </div>
    </div>
  )
}
