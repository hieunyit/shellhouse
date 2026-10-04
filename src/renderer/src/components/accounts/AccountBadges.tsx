import { Globe, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react'
import { t } from '@shared/i18n'
import type { AccountSummary, KeySummary } from '@shared/hosts'
import { accountBadges, type AccountBadgeKind } from './account-logic'

const BADGE_ICON: Record<AccountBadgeKind, typeof KeyRound> = {
  key: KeyRound,
  password: LockKeyhole,
  passphrase: ShieldCheck,
  domain: Globe
}

/** Nhãn nhỏ: SSH key / mật khẩu / passphrase / domain mà tài khoản có. */
export function AccountBadges({
  account,
  keys
}: {
  account: AccountSummary
  keys: readonly KeySummary[]
}): React.JSX.Element {
  const badges = accountBadges(account, keys)
  if (badges.length === 0)
    return <span className="text-xs text-faint">{t('No password or key')}</span>
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {badges.map((b) => {
        const Icon = BADGE_ICON[b.kind]
        return (
          <span
            key={b.kind}
            data-badge={b.kind}
            className="inline-flex max-w-40 items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted"
          >
            <Icon size={11} className="shrink-0" />
            <span className="truncate">{b.label}</span>
          </span>
        )
      })}
    </span>
  )
}
