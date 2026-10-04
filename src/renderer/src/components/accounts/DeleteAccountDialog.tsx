import { useState } from 'react'
import { t, tn } from '@shared/i18n'
import type { AccountSummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { toast } from '../../stores/toasts'
import { Button, Modal, Notice, Select, cx } from '../ui'

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
