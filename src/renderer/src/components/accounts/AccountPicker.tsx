import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronsUpDown,
  Plus,
  Search,
  Settings2,
  UserRound,
  UserRoundPen
} from 'lucide-react'
import { t } from '@shared/i18n'
import type { AccountSummary, HostProtocol, KeySummary } from '@shared/hosts'
import { cx } from '../ui'
import { AccountBadges } from './AccountsManager'
import { accountProblem, filterAccounts } from './account-logic'

/**
 * Chọn tài khoản cho host: "Custom (this host only)" + danh sách tài khoản (tìm được, hiện username
 * và nhãn key / mật khẩu / passphrase). Bàn phím: ↑/↓ chọn, Enter xác nhận, Esc đóng.
 */
export function AccountPicker({
  value,
  accounts,
  keys,
  protocol,
  onChange,
  onCreate,
  onManage
}: {
  value: string | null
  accounts: readonly AccountSummary[]
  keys: readonly KeySummary[]
  protocol: HostProtocol
  onChange: (accountId: string | null) => void
  onCreate: () => void
  onManage: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selected = accounts.find((a) => a.id === value) ?? null
  const shown = useMemo(() => filterAccounts(accounts, query), [accounts, query])
  /** Mục trong danh sách: null = Custom (chỉ hiện khi không tìm). */
  const items: (AccountSummary | null)[] = query.trim() ? shown : [null, ...shown]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    // Form host cuộn được: kéo menu vào tầm nhìn nếu nó tràn xuống dưới.
    menuRef.current?.scrollIntoView({ block: 'nearest' })
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    setQuery('')
    triggerRef.current?.focus()
  }
  const pick = (account: AccountSummary | null): void => {
    if (account && accountProblem(account, protocol)) return
    onChange(account?.id ?? null)
    close()
  }

  return (
    <div ref={rootRef} className="relative" data-capture-keys={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="host-account"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-[13px] shadow-xs transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        onClick={() => {
          setOpen(!open)
          setActive(
            Math.max(
              0,
              items.findIndex((i) => (i?.id ?? null) === value)
            )
          )
        }}
      >
        {selected ? (
          <UserRound size={14} className="shrink-0 text-accent" />
        ) : (
          <UserRoundPen size={14} className="shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              <span className="font-medium text-fg">{selected.name}</span>
              {selected.username && (
                <span className="ml-2 font-mono text-xs text-muted">{selected.username}</span>
              )}
            </>
          ) : value ? (
            <span className="text-danger">{t('(deleted account)')}</span>
          ) : (
            <span className="text-fg">{t('Custom (this host only)')}</span>
          )}
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-faint" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="shadow-elevated animate-fade-in absolute inset-x-0 top-full z-20 mt-1 flex max-h-80 flex-col overflow-hidden rounded-lg border border-line bg-elevated"
          data-testid="host-account-menu"
        >
          <div className="relative border-b border-line p-1.5">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint"
            />
            <input
              autoFocus
              className="h-7 w-full rounded bg-transparent pr-2 pl-7 text-[13px] text-fg outline-none placeholder:text-faint"
              placeholder={t('Search accounts')}
              aria-label={t('Search accounts')}
              aria-controls={listId}
              data-testid="host-account-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : -1
                  setActive((i) =>
                    items.length === 0 ? 0 : (i + step + items.length) % items.length
                  )
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const item = items[active]
                  if (item !== undefined) pick(item)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  close()
                }
              }}
            />
          </div>
          <ul id={listId} role="listbox" aria-label={t('Account')} className="overflow-auto p-1">
            {items.length === 0 && (
              <li className="px-2.5 py-3 text-center text-xs text-faint">
                {t('No matching accounts')}
              </li>
            )}
            {items.map((a, i) => {
              const problem = a ? accountProblem(a, protocol) : null
              const isSelected = (a?.id ?? null) === value
              return (
                <li
                  key={a?.id ?? 'custom'}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={problem !== null || undefined}
                  data-testid="host-account-option"
                  data-account-name={a?.name ?? ''}
                  title={problem ?? undefined}
                  className={cx(
                    'flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-1.5',
                    i === active && 'bg-hover',
                    problem && 'cursor-not-allowed opacity-50'
                  )}
                  onMouseEnter={() => {
                    setActive(i)
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                  }}
                  onClick={() => {
                    pick(a)
                  }}
                >
                  <Check
                    size={13}
                    className={cx('mt-0.5 shrink-0', isSelected ? 'text-accent' : 'invisible')}
                  />
                  {a ? (
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-[13px] text-fg">{a.name}</span>
                        <span className="truncate font-mono text-xs text-muted">
                          {a.username || t('(group username)')}
                        </span>
                      </span>
                      {problem ? (
                        <span className="text-[11px] text-danger">{problem}</span>
                      ) : (
                        <AccountBadges account={a} keys={keys} />
                      )}
                    </span>
                  ) : (
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] text-fg">{t('Custom (this host only)')}</span>
                      <span className="text-[11px] text-faint">
                        {t('Enter the username and password or key for this host')}
                      </span>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="flex border-t border-line p-1">
            <button
              type="button"
              data-testid="host-account-create"
              className="flex flex-1 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setOpen(false)
                onCreate()
              }}
            >
              <Plus size={13} />
              {t('New account…')}
            </button>
            <button
              type="button"
              data-testid="host-account-manage"
              className="flex flex-1 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setOpen(false)
                onManage()
              }}
            >
              <Settings2 size={13} />
              {t('Manage accounts…')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
