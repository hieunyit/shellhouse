import { useMemo, useState } from 'react'
import {
  Copy,
  Globe,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserRound
} from 'lucide-react'
import { t, tn } from '@shared/i18n'
import type { AccountSummary, KeySummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { confirmAction } from '../../stores/confirm'
import { toast } from '../../stores/toasts'
import { Button, Input, Modal, Notice, Select, cx } from '../ui'
import { AccountEditor } from './AccountEditor'
import { accountBadges, filterAccounts, type AccountBadgeKind } from './account-logic'

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

/**
 * Danh sách tài khoản dùng chung: tìm, tạo, sửa, nhân bản, xoá (hỏi cách xử lý host đang dùng).
 * Dùng ở Settings → Accounts và hộp thoại "Manage accounts" mở từ form host.
 */
export function AccountsManager(): React.JSX.Element {
  const { accounts, keys, hosts } = useHosts((s) => s.tree)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<AccountSummary | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AccountSummary | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const shown = useMemo(() => filterAccounts(accounts, query), [accounts, query])
  const hostLabel = (id: string): string => hosts.find((h) => h.id === id)?.label ?? '?'

  const duplicate = async (account: AccountSummary): Promise<void> => {
    const result = await window.shellhouse.duplicateAccount(account.id)
    if (result.ok) toast.success(t('Duplicated {name}', { name: account.name }))
    else toast.error(result.message)
  }

  const remove = async (account: AccountSummary): Promise<void> => {
    if (account.hostIds.length > 0) {
      setDeleting(account)
      return
    }
    const ok = await confirmAction({
      title: t('Delete the account “{name}”?', { name: account.name }),
      message: t('Its password and passphrase are removed from the vault. SSH keys are kept.'),
      confirmLabel: t('Delete'),
      danger: true,
      testId: 'account-delete-confirm'
    })
    if (!ok) return
    const result = await window.shellhouse.deleteAccount(account.id, null)
    if (!result.ok) toast.error(result.message)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="accounts-manager">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
          />
          <Input
            className="pl-8"
            placeholder={t('Search accounts')}
            aria-label={t('Search accounts')}
            data-testid="accounts-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          data-testid="account-new"
          onClick={() => {
            setEditing('new')
          }}
        >
          {t('New account')}
        </Button>
      </div>

      {accounts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-8 text-center">
          <UserRound size={22} className="text-faint" />
          <p className="text-[13px] font-medium text-fg">{t('No accounts yet')}</p>
          <p className="max-w-sm text-xs text-muted">
            {t(
              'Save a username with its password, SSH key and passphrase once, then pick it for any host. Change it here and every host that uses it follows.'
            )}
          </p>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-xs text-faint">{t('No matching accounts')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-line p-3"
              data-testid="account-row"
              data-account-name={a.name}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-subtle text-muted">
                  <UserRound size={14} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{a.name}</span>
                    <span className="truncate font-mono text-xs text-muted">
                      {a.username || t('(group username)')}
                    </span>
                  </div>
                  <AccountBadges account={a} keys={keys} />
                  {a.notes && <p className="text-xs whitespace-pre-line text-faint">{a.notes}</p>}
                  <button
                    type="button"
                    className={cx(
                      'self-start text-xs',
                      a.hostIds.length > 0 ? 'text-accent hover:underline' : 'text-faint'
                    )}
                    disabled={a.hostIds.length === 0}
                    aria-expanded={expanded === a.id}
                    data-testid="account-usage"
                    onClick={() => {
                      setExpanded(expanded === a.id ? null : a.id)
                    }}
                  >
                    {a.hostIds.length === 0
                      ? t('Not used by any host')
                      : tn(a.hostIds.length, 'Used by {n} host', 'Used by {n} hosts')}
                  </button>
                  {expanded === a.id && (
                    <ul className="flex flex-wrap gap-1" data-testid="account-usage-list">
                      {a.hostIds.map((id) => (
                        <li
                          key={id}
                          className="rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] text-muted"
                        >
                          {hostLabel(id)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil size={13} />}
                    data-testid="account-edit"
                    onClick={() => {
                      setEditing(a)
                    }}
                  >
                    {t('Edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={13} />}
                    aria-label={t('Duplicate {name}', { name: a.name })}
                    title={t('Duplicate')}
                    data-testid="account-duplicate"
                    onClick={() => void duplicate(a)}
                  />
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    icon={<Trash2 size={13} />}
                    aria-label={t('Delete {name}', { name: a.name })}
                    title={t('Delete')}
                    data-testid="account-delete"
                    onClick={() => void remove(a)}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <AccountEditor
          account={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {deleting && (
        <DeleteAccountDialog
          account={deleting}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Xoá tài khoản đang có host dùng: chép thông tin vào từng host (host vẫn kết nối như cũ) hoặc
 * chuyển các host sang tài khoản khác.
 */
export function DeleteAccountDialog({
  account,
  onClose
}: {
  account: AccountSummary
  onClose: () => void
}): React.JSX.Element {
  const { accounts, hosts } = useHosts((s) => s.tree)
  const others = accounts.filter((a) => a.id !== account.id)
  const [mode, setMode] = useState<'convert' | 'reassign'>('convert')
  const [target, setTarget] = useState(others[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const users = hosts.filter((h) => account.hostIds.includes(h.id))

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.shellhouse.deleteAccount(
        account.id,
        mode === 'reassign' ? { mode, accountId: target } : { mode }
      )
      if (!result.ok) {
        setError(result.message)
        return
      }
      toast.success(t('Deleted the account {name}', { name: account.name }))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const option = (value: 'convert' | 'reassign', label: string, description: string) => (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-[13px]',
        mode === value ? 'border-accent bg-subtle' : 'border-line'
      )}
    >
      <input
        type="radio"
        name="account-delete-mode"
        className="mt-0.5 accent-[var(--sh-accent)]"
        data-testid={`account-delete-${value}`}
        checked={mode === value}
        disabled={value === 'reassign' && others.length === 0}
        onChange={() => {
          setMode(value)
        }}
      />
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
      </span>
    </label>
  )

  return (
    <Modal
      title={t('Delete the account “{name}”?', { name: account.name })}
      description={tn(
        users.length,
        '{n} host uses this account. Choose what happens to it.',
        '{n} hosts use this account. Choose what happens to them.'
      )}
      onClose={onClose}
      testId="account-delete-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="danger"
            disabled={busy || (mode === 'reassign' && !target)}
            data-testid="account-delete-submit"
            onClick={() => void submit()}
          >
            {t('Delete account')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-1">
          {users.map((h) => (
            <li
              key={h.id}
              className="rounded-full border border-line bg-subtle px-2 py-0.5 text-[11px] text-muted"
            >
              {h.label}
            </li>
          ))}
        </ul>
        {option(
          'convert',
          t('Keep the credentials on each host'),
          t(
            'Each host gets its own copy of the username, password and key, and keeps connecting as before.'
          )
        )}
        {option(
          'reassign',
          t('Move the hosts to another account'),
          others.length === 0
            ? t('There is no other account yet.')
            : t('The hosts sign in with the account you pick instead.')
        )}
        {mode === 'reassign' && others.length > 0 && (
          <Select
            aria-label={t('Account')}
            data-testid="account-delete-target"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value)
            }}
          >
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.username ? ` (${a.username})` : ''}
              </option>
            ))}
          </Select>
        )}
        {error && (
          <Notice tone="danger" testId="account-delete-error">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}

/** Hộp thoại quản lý tài khoản (mở từ form host — "Manage…"). */
export function AccountsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal
      title={t('Accounts')}
      description={t('Shared sign-in details for your hosts.')}
      onClose={onClose}
      width="max-w-2xl"
      testId="accounts-dialog"
    >
      <AccountsManager />
    </Modal>
  )
}
