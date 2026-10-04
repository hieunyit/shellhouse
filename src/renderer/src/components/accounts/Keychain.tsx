import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
  Upload,
  UserRound,
  WandSparkles
} from 'lucide-react'
import { t, tn } from '@shared/i18n'
import type { AccountSummary, KeySummary } from '@shared/hosts'
import { useHosts } from '../../stores/hosts'
import { choose, confirmAction } from '../../stores/confirm'
import { toast } from '../../stores/toasts'
import { useContextMenu } from '../ContextMenu'
import { Button, Input, Kbd, cx } from '../ui'
import { AccountBadges } from './AccountBadges'
import { AccountDetail } from './AccountDetail'
import { AccountEditor } from './AccountEditor'
import { DeleteAccountDialog } from './DeleteAccountDialog'
import { GenerateKeyDialog } from './GenerateKeyDialog'
import { KeyDetail } from './KeyDetail'
import {
  keyInUse,
  keyTypeLabel,
  keyUsage,
  matchKeychain,
  moveSelection,
  publicKeyBits,
  reconcileSelection,
  sameItem,
  shortFingerprint,
  visibleItems,
  type KeychainFilter,
  type KeychainItem,
  type KeychainSelection,
  type KeyUsage
} from './keychain-logic'

/** Dòng public key của từng key (đọc qua IPC — không cần mở khoá private key). */
function usePublicKeys(keys: readonly KeySummary[]): ReadonlyMap<string, string | null> {
  const [lines, setLines] = useState<ReadonlyMap<string, string | null>>(new Map())
  const ids = keys.map((k) => k.id).join(',')
  useEffect(() => {
    let alive = true
    const missing = ids.split(',').filter((id) => id && !lines.has(id))
    if (missing.length === 0) return
    void Promise.all(
      missing.map((id) =>
        window.shellhouse.publicKey(id).then(
          (line) => [id, line] as const,
          () => [id, null] as const
        )
      )
    ).then((loaded) => {
      if (alive) setLines((prev) => new Map([...prev, ...loaded]))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ nạp key mới xuất hiện
  }, [ids])
  return lines
}

const itemKey = (s: KeychainSelection): string => `${s.kind}:${s.id}`

/** "Used by: Prod, Staging · 3 hosts" — tóm tắt nơi dùng key cho dòng trong danh sách. */
function keyUsageLine(usage: KeyUsage): string {
  const parts: string[] = []
  if (usage.accounts.length > 0) {
    const names = usage.accounts.slice(0, 2).map((a) => a.name)
    const more = usage.accounts.length - names.length
    parts.push(
      more > 0 ? t('{names} +{n}', { names: names.join(', '), n: more }) : names.join(', ')
    )
  }
  if (usage.hostIds.length > 0) parts.push(tn(usage.hostIds.length, '{n} host', '{n} hosts'))
  return parts.length > 0
    ? t('Used by: {list}', { list: parts.join(' · ') })
    : t('Not used by any account or host')
}

/**
 * Keychain: tài khoản dùng chung và SSH key trong một danh sách (như Termius) — tìm, lọc theo loại,
 * tạo mới (tài khoản / tạo key / import key), xem chi tiết bên phải. Dùng ở Settings → Keychain và
 * hộp thoại "Manage accounts…" của form host.
 *
 * Phím: ↑/↓ chọn, Enter mở (tài khoản: sửa; key: vào khung chi tiết), Delete xoá, "/" tìm.
 */
export function Keychain({
  initialFilter = 'all'
}: {
  initialFilter?: KeychainFilter
}): React.JSX.Element {
  const { accounts, keys, hosts, groups } = useHosts((s) => s.tree)
  const [filter, setFilter] = useState<KeychainFilter>(initialFilter)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<KeychainSelection | null>(null)
  const [editing, setEditing] = useState<AccountSummary | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AccountSummary | null>(null)
  const [generating, setGenerating] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const newMenu = useContextMenu()
  /** Mục vừa tạo: chờ cây host nạp lại (đừng chọn sang mục khác trong lúc chờ). */
  const pendingRef = useRef<KeychainSelection | null>(null)
  /** Vị trí của mục đang chọn — xoá xong chọn mục kế ở cùng chỗ. */
  const indexRef = useRef(0)

  const publicKeys = usePublicKeys(keys)
  const matched = useMemo(() => matchKeychain(accounts, keys, query), [accounts, keys, query])
  const items = useMemo(() => visibleItems(matched, filter), [matched, filter])
  const usages = useMemo(
    () => new Map(keys.map((k) => [k.id, keyUsage(k, { accounts, hosts, groups })])),
    [keys, accounts, hosts, groups]
  )

  const selectedIndex = items.findIndex((i) => sameItem(i, selected))
  const current = selectedIndex === -1 ? null : (items[selectedIndex] ?? null)

  useEffect(() => {
    if (selectedIndex !== -1) indexRef.current = selectedIndex
    if (pendingRef.current && sameItem(pendingRef.current, selected)) {
      if (selectedIndex === -1) return
      pendingRef.current = null
    }
    const next = reconcileSelection(items, selected, indexRef.current)
    if (next !== selected && !(next && selected && sameItem(next, selected))) setSelected(next)
  }, [items, selected, selectedIndex])

  // Mục đang chọn luôn nằm trong vùng nhìn thấy của danh sách.
  useEffect(() => {
    if (!selected) return
    listRef.current
      ?.querySelector(`[data-item="${CSS.escape(itemKey(selected))}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // "/" ở bất kỳ đâu trong hộp thoại (trừ ô nhập) → vào ô tìm.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const root = rootRef.current
      if (!root) return
      // Chỉ khi focus đang ở cùng hộp thoại với Keychain (không phải hộp thoại khác đè lên).
      const dialog = root.closest('[role="dialog"]')
      const targetDialog = target?.closest('[role="dialog"]') ?? null
      if (targetDialog !== dialog && target !== document.body) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  /** Chọn một mục; mục bị lọc / tìm ẩn đi thì bỏ lọc để thấy nó. */
  const reveal = useCallback(
    (next: KeychainSelection, pending = false): void => {
      if (pending) pendingRef.current = next
      const kindFilter = next.kind === 'account' ? 'accounts' : 'keys'
      const visible = items.some((i) => sameItem(i, next))
      if (!visible) {
        setQuery('')
        if (filter !== 'all' && filter !== kindFilter) setFilter('all')
      }
      setSelected(next)
    },
    [items, filter]
  )

  const duplicateAccount = async (account: AccountSummary): Promise<void> => {
    const result = await window.shellhouse.duplicateAccount(account.id)
    if (result.ok) {
      toast.success(t('Duplicated {name}', { name: account.name }))
      reveal({ kind: 'account', id: result.id }, true)
    } else toast.error(result.message)
  }

  const removeAccount = async (account: AccountSummary): Promise<void> => {
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

  const removeKey = async (key: KeySummary): Promise<void> => {
    const usage = usages.get(key.id)
    if (usage && keyInUse(usage)) {
      // Main cũng chặn (HostsService.deleteKey) — báo trước, kèm nơi đang dùng.
      await choose({
        title: t('“{name}” is still in use', { name: key.name }),
        message: t('{usage}. Choose another key or remove it from them first.', {
          usage: keyUsageLine(usage)
        }),
        choices: [{ value: 'ok', label: t('OK'), variant: 'primary', autoFocus: true }],
        testId: 'key-in-use'
      })
      return
    }
    const ok = await confirmAction({
      title: t('Delete the key “{name}” from the vault?', { name: key.name }),
      message:
        usage && usage.groups.length > 0
          ? tn(
              usage.groups.length,
              'It is the default key of {n} group — hosts there will no longer sign in with it.',
              'It is the default key of {n} groups — hosts there will no longer sign in with it.'
            )
          : t('This cannot be undone. Export it first if you may need it again.'),
      confirmLabel: t('Delete'),
      danger: true,
      testId: 'key-delete-confirm'
    })
    if (!ok) return
    const result = await window.shellhouse.deleteKey(key.id)
    if (result.ok) toast.success(t('Deleted the key {name}', { name: key.name }))
    else toast.error(result.message)
  }

  const remove = (item: KeychainItem): void => {
    if (item.kind === 'account') void removeAccount(item.account)
    else void removeKey(item.key)
  }

  const open = (item: KeychainItem): void => {
    if (item.kind === 'account') setEditing(item.account)
    else detailRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }

  const importKey = async (): Promise<void> => {
    const result = await window.shellhouse.importKeyFromFile()
    if (!result) return
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success(t('Imported the SSH key'))
    reveal({ kind: 'key', id: result.id }, true)
  }

  const openNewMenu = (button: HTMLElement): void => {
    const rect = button.getBoundingClientRect()
    // Menu canh phải theo nút (nút nằm sát mép phải khung) — 13rem = min-w-52 của ContextMenu.
    newMenu.open(
      { clientX: rect.right - 208, clientY: rect.bottom + 4, preventDefault: () => undefined },
      [
        {
          id: 'keychain-new-account',
          label: t('Account'),
          icon: <UserRound size={14} />,
          onSelect: () => {
            setEditing('new')
          }
        },
        'separator',
        {
          id: 'keychain-generate-key',
          label: t('Generate SSH key…'),
          icon: <WandSparkles size={14} />,
          onSelect: () => {
            setGenerating(true)
          }
        },
        {
          id: 'keychain-import-key',
          label: t('Import SSH key…'),
          icon: <Upload size={14} />,
          onSelect: () => void importKey()
        }
      ]
    )
  }

  /** Phím điều hướng dùng chung cho danh sách và ô tìm. */
  const navigate = (event: React.KeyboardEvent, fromSearch: boolean): void => {
    const move =
      event.key === 'ArrowDown'
        ? 'down'
        : event.key === 'ArrowUp'
          ? 'up'
          : !fromSearch && event.key === 'Home'
            ? 'first'
            : !fromSearch && event.key === 'End'
              ? 'last'
              : null
    if (move) {
      event.preventDefault()
      setSelected(moveSelection(items, selected, move))
      return
    }
    if (event.key === 'Enter' && current) {
      event.preventDefault()
      open(current)
      return
    }
    if (!fromSearch && event.key === 'Delete' && current) {
      event.preventDefault()
      remove(current)
    }
  }

  const counts = {
    all: matched.accounts.length + matched.keys.length,
    accounts: matched.accounts.length,
    keys: matched.keys.length
  }
  const empty = accounts.length === 0 && keys.length === 0
  const filters: { value: KeychainFilter; label: string }[] = [
    { value: 'all', label: t('All') },
    { value: 'accounts', label: t('Accounts') },
    { value: 'keys', label: t('SSH keys') }
  ]

  const renderRow = (item: KeychainItem): React.JSX.Element => {
    const active = sameItem(item, selected)
    const id = `keychain-item-${itemKey(item)}`
    const common = {
      id,
      role: 'option' as const,
      'aria-selected': active,
      'data-item': itemKey(item),
      className: cx(
        'flex cursor-default gap-2.5 border-l-2 px-3 py-2.5 select-none',
        active ? 'border-accent bg-hover' : 'border-transparent hover:bg-hover/60'
      ),
      onMouseDown: (e: React.MouseEvent) => {
        // Giữ focus ở danh sách (phím ↑/↓/Delete chạy tiếp) thay vì rơi về body.
        e.preventDefault()
        listRef.current?.focus()
        setSelected({ kind: item.kind, id: item.id })
      },
      onDoubleClick: () => {
        open(item)
      }
    }
    if (item.kind === 'account') {
      const a = item.account
      return (
        <div key={id} {...common} data-testid="account-row" data-account-name={a.name}>
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-subtle text-muted">
            <UserRound size={14} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[13px] font-medium text-fg">{a.name}</span>
              <span className="ml-auto truncate font-mono text-[11px] text-muted">
                {a.username || t('(group username)')}
              </span>
            </div>
            <AccountBadges account={a} keys={keys} />
            <span className="text-[11px] text-faint" data-testid="account-row-usage">
              {a.hostIds.length === 0
                ? t('Not used by any host')
                : tn(a.hostIds.length, 'Used by {n} host', 'Used by {n} hosts')}
            </span>
          </div>
        </div>
      )
    }
    const k = item.key
    const line = publicKeys.get(k.id)
    const usage = usages.get(k.id)
    return (
      <div key={id} {...common} data-testid="key-row" data-key-name={k.name}>
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
          <KeyRound size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[13px] font-medium text-fg">{k.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
            <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 font-mono">
              {keyTypeLabel(k.type, line ? publicKeyBits(line) : null)}
            </span>
            {k.encrypted && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-subtle px-1.5 py-0.5"
                title={t('Protected with a passphrase')}
              >
                <ShieldCheck size={11} />
                passphrase
              </span>
            )}
            <span className="truncate font-mono text-faint" title={k.fingerprint}>
              {shortFingerprint(k.fingerprint)}
            </span>
          </span>
          {usage && (
            <span className="truncate text-[11px] text-faint" data-testid="key-row-usage">
              {keyUsageLine(usage)}
            </span>
          )}
        </div>
      </div>
    )
  }

  const group = (title: string, list: KeychainItem[]): React.JSX.Element | null =>
    list.length === 0 ? null : (
      <div role="group" aria-label={title}>
        {filter === 'all' && (
          <div className="sticky top-0 z-[1] border-b border-line bg-surface/95 px-3 py-1 text-[11px] font-semibold tracking-wide text-faint uppercase backdrop-blur">
            {title}
          </div>
        )}
        {list.map(renderRow)}
      </div>
    )

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" data-testid="keychain">
      <div className="flex items-center gap-2 px-5 pt-4 pb-3">
        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
          />
          <Input
            ref={searchRef}
            className="pr-8 pl-8"
            placeholder={t('Search accounts and keys')}
            aria-label={t('Search accounts and keys')}
            aria-controls="keychain-list"
            data-testid="keychain-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
            onKeyDown={(e) => {
              navigate(e, true)
            }}
          />
          {!query && (
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
              <Kbd>/</Kbd>
            </span>
          )}
        </div>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          aria-haspopup="menu"
          data-testid="keychain-new"
          onClick={(e) => {
            openNewMenu(e.currentTarget)
          }}
        >
          {t('New')}
          <ChevronDown size={13} className="-mr-1 opacity-80" />
        </Button>
      </div>
      <div role="radiogroup" aria-label={t('Show')} className="flex items-center gap-1.5 px-5 pb-3">
        {filters.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={filter === f.value}
            data-testid={`keychain-filter-${f.value}`}
            className={cx(
              'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
              filter === f.value
                ? 'border-accent/40 bg-accent/10 font-medium text-fg'
                : 'border-line text-muted hover:bg-hover hover:text-fg'
            )}
            onClick={() => {
              setFilter(f.value)
            }}
          >
            {f.label}
            <span
              className={cx(
                'font-mono text-[10px] tabular-nums',
                filter === f.value ? 'text-accent' : 'text-faint'
              )}
            >
              {counts[f.value]}
            </span>
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 border-t border-line">
        <div
          ref={listRef}
          id="keychain-list"
          role="listbox"
          tabIndex={0}
          aria-label={t('Keychain')}
          aria-activedescendant={selected ? `keychain-item-${itemKey(selected)}` : undefined}
          data-testid="keychain-list"
          className="w-[19rem] shrink-0 overflow-y-auto border-r border-line outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-inset"
          onKeyDown={(e) => {
            navigate(e, false)
          }}
        >
          {empty ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <ShieldCheck size={22} className="text-faint" />
              <p className="text-[13px] font-medium text-fg">{t('Your keychain is empty')}</p>
              <p className="text-xs text-muted">
                {t(
                  'Save a username with its password, SSH key and passphrase once, then pick it for any host. Change it here and every host that uses it follows.'
                )}
              </p>
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-faint" data-testid="keychain-no-match">
              {query.trim()
                ? t('Nothing matches “{query}”', { query: query.trim() })
                : filter === 'accounts'
                  ? t('No accounts yet')
                  : t('No keys in the vault yet')}
            </p>
          ) : (
            <>
              {filter !== 'keys' && group(t('Accounts'), matched.accounts)}
              {filter !== 'accounts' && group(t('SSH keys'), matched.keys)}
            </>
          )}
        </div>

        <div
          ref={detailRef}
          className="min-w-0 flex-1 overflow-y-auto px-5 py-4"
          data-testid="keychain-detail"
        >
          {current?.kind === 'account' ? (
            <AccountDetail
              account={current.account}
              onEdit={() => {
                setEditing(current.account)
              }}
              onDuplicate={() => void duplicateAccount(current.account)}
              onDelete={() => void removeAccount(current.account)}
              onSelectKey={(id) => {
                reveal({ kind: 'key', id })
              }}
            />
          ) : current?.kind === 'key' ? (
            <KeyDetail
              sshKey={current.key}
              usage={usages.get(current.key.id) ?? keyUsage(current.key, { accounts, hosts })}
              publicKey={publicKeys.get(current.key.id)}
              onSelectAccount={(id) => {
                reveal({ kind: 'account', id })
              }}
              onDelete={() => void removeKey(current.key)}
            />
          ) : (
            <EmptyDetail
              empty={empty}
              onNewAccount={() => {
                setEditing('new')
              }}
              onGenerate={() => {
                setGenerating(true)
              }}
              onImport={() => void importKey()}
            />
          )}
        </div>
      </div>

      {newMenu.menu}
      {editing && (
        <AccountEditor
          account={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
            // Trả focus về danh sách để tiếp tục bằng bàn phím.
            requestAnimationFrame(() => listRef.current?.focus())
          }}
          onSaved={(id) => {
            reveal({ kind: 'account', id }, true)
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
      {generating && (
        <GenerateKeyDialog
          onClose={() => {
            setGenerating(false)
          }}
          onCreated={(id) => {
            toast.success(
              t('Key created. Use “Copy public key” or “Deploy key” to add it to a server.')
            )
            reveal({ kind: 'key', id }, true)
          }}
        />
      )}
    </div>
  )
}

/** Khung bên phải khi chưa chọn gì: gợi ý tạo mục đầu tiên. */
function EmptyDetail({
  empty,
  onNewAccount,
  onGenerate,
  onImport
}: {
  empty: boolean
  onNewAccount: () => void
  onGenerate: () => void
  onImport: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="max-w-xs text-xs text-muted">
        {empty
          ? t('Add an account or an SSH key to get started.')
          : t('Select an account or a key to see its details.')}
      </p>
      {empty && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" icon={<UserRound size={13} />} onClick={onNewAccount}>
            {t('New account')}
          </Button>
          <Button size="sm" icon={<WandSparkles size={13} />} onClick={onGenerate}>
            {t('Generate SSH key…')}
          </Button>
          <Button size="sm" icon={<Upload size={13} />} onClick={onImport}>
            {t('Import SSH key…')}
          </Button>
        </div>
      )}
    </div>
  )
}
