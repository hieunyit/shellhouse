import { t } from '@shared/i18n'
import { AccountsManager } from '../accounts/AccountsManager'
import { SectionTitle } from '../ui'

/** Settings → Accounts: tài khoản dùng chung cho host (username, mật khẩu, SSH key, passphrase). */
export function AccountsSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-testid="settings-accounts">
      <SectionTitle
        description={t(
          'Pick an account when you create or edit a host instead of typing the username, password and key again. Secrets are stored encrypted in the vault.'
        )}
      >
        {t('Accounts')}
      </SectionTitle>
      <AccountsManager />
    </div>
  )
}
