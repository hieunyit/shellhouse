import { Copy, KeyRound, Pencil, Server, Trash2, UserRound } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import type { AccountSummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { Button, cx } from '../ui'
import { AccountBadges } from './AccountBadges'
import { DetailRow, DetailSection, UsageChips } from './keychain-parts'

/** Chi tiết một tài khoản trong Keychain; sửa thì mở AccountEditor (Enter / double-click / Edit). */
export function AccountDetail({
  account,
  onEdit,
  onDuplicate,
  onDelete,
  onSelectKey
}: {
  account: AccountSummary
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSelectKey: (id: string) => void
}): React.JSX.Element {
  const keys = useHosts((s) => s.tree.keys)
  const hosts = useHosts((s) => s.tree.hosts)
  const key = account.keyId ? keys.find((k) => k.id === account.keyId) : undefined
  const saved = (on: boolean): React.JSX.Element => (
    <span className={cx('text-xs', on ? 'text-fg' : 'text-faint')}>
      {on ? t('Saved in the vault') : t('Not set')}
    </span>
  )

  return (
    <div
      className="flex flex-col gap-5"
      data-testid="account-detail"
      data-account-name={account.name}
    >
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-subtle text-muted">
          <UserRound size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="truncate text-[15px] font-semibold text-fg" title={account.name}>
            {account.name}
          </h3>
          <AccountBadges account={account} keys={keys} />
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="primary"
          icon={<Pencil size={13} />}
          data-testid="account-edit"
          onClick={onEdit}
        >
          {t('Edit')}
        </Button>
        <Button
          size="sm"
          icon={<Copy size={13} />}
          data-testid="account-duplicate"
          onClick={onDuplicate}
        >
          {t('Duplicate')}
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Trash2 size={13} />}
          data-testid="account-delete"
          onClick={onDelete}
        >
          {t('Delete')}
        </Button>
      </div>

      <DetailSection title={t('Sign-in')}>
        <div className="flex flex-col">
          <DetailRow label={t('Username')}>
            {account.username ? (
              <span className="font-mono text-xs">{account.username}</span>
            ) : (
              <span className="text-xs text-faint">{t('(group username)')}</span>
            )}
          </DetailRow>
          {account.domain && (
            <DetailRow label={t('Domain')}>
              <span className="font-mono text-xs">{account.domain}</span>
            </DetailRow>
          )}
          <DetailRow label={t('Password')}>{saved(account.hasPassword)}</DetailRow>
          <DetailRow label={t('SSH key')}>
            {account.keyId ? (
              key ? (
                <button
                  type="button"
                  className="inline-flex max-w-full items-center gap-1 text-xs text-accent hover:underline"
                  data-testid="account-detail-key"
                  onClick={() => {
                    onSelectKey(key.id)
                  }}
                >
                  <KeyRound size={12} className="shrink-0" />
                  <span className="truncate">{key.name}</span>
                  <span className="shrink-0 text-faint">({key.type})</span>
                </button>
              ) : (
                <span className="text-xs text-danger">{t('SSH key (deleted)')}</span>
              )
            ) : (
              <span className="text-xs text-faint">{t('No SSH key')}</span>
            )}
          </DetailRow>
          {key?.encrypted && (
            <DetailRow label={t('Passphrase')}>
              {account.hasPassphrase ? (
                saved(true)
              ) : (
                <span className="text-xs text-faint">{t('Asked when connecting')}</span>
              )}
            </DetailRow>
          )}
        </div>
      </DetailSection>

      {account.notes && (
        <DetailSection title={t('Notes')}>
          <p className="sh-selectable text-xs whitespace-pre-line text-muted">{account.notes}</p>
        </DetailSection>
      )}

      <DetailSection title={t('Used by')} testId="account-usage">
        {account.hostIds.length === 0 ? (
          <p className="text-xs text-faint">{t('Not used by any host')}</p>
        ) : (
          <UsageChips
            label={tn(account.hostIds.length, 'Used by {n} host', 'Used by {n} hosts')}
            testId="account-usage-list"
            items={account.hostIds.map((id) => {
              const host = hosts.find((h) => h.id === id)
              return {
                id,
                label: host?.label ?? '?',
                icon: <Server size={11} />,
                ...(host ? { title: host.hostname } : {})
              }
            })}
          />
        )}
      </DetailSection>
    </div>
  )
}
