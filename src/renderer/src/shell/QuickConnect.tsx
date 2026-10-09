import { useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { CornerDownLeft, Zap } from 'lucide-react'
import { t } from '@shared/i18n'
import { bestScore } from '@shared/fuzzy'
import type { HostSummary } from '@shared/hosts'
import { parseQuickConnect } from '@shared/quick-connect'
import { Kbd } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { HostAvatar } from '../components/HostAvatar'
import { connect } from '../components/sidebar/actions'
import { hostAddress, useHosts } from '../stores/hosts'
import { sshAlias } from '@shared/ssh-alias'
import { useTabs } from '../stores/tabs'
import { openSidebarDialog } from '../stores/ui-requests'

type Item =
  | { kind: 'host'; host: HostSummary; address: string; path: string }
  | {
      kind: 'address'
      text: string
      target: NonNullable<ReturnType<typeof parseQuickConnect>>
      /** `-J …` đã tìm thấy trong host đã lưu. */
      jumpHost?: HostSummary
    }

/**
 * `-J <jump>` → host đã lưu: theo tên, bí danh (tên viết thường không dấu cách), hostname, hoặc
 * `user@host[:port]`. Jump host phải là host đã lưu (main dùng thông tin đăng nhập của nó).
 */
function findJumpHost(
  jump: string,
  hosts: readonly HostSummary[],
  effective: ReturnType<typeof useHosts.getState>['effective']
): HostSummary | undefined {
  const j = jump.toLowerCase()
  const parsed = /^(?:([^@]+)@)?([^:@]+)(?::(\d+))?$/.exec(jump)
  return (
    hosts.find((h) => h.label.toLowerCase() === j) ??
    hosts.find((h) => sshAlias(h.label) === j) ??
    hosts.find((h) => {
      if (h.protocol !== 'ssh' || !parsed) return false
      const [, user, host, port] = parsed
      const eff = effective.get(h.id)
      return (
        h.hostname.toLowerCase() === (host ?? '').toLowerCase() &&
        (!user || (eff?.username ?? h.username) === user) &&
        (!port || (eff?.port ?? h.port ?? 22) === Number(port))
      )
    })
  )
}

const MAX = 8

/**
 * Quick connect (nút Connect trên title bar): gõ tên host đã lưu (fuzzy) hoặc `user@host:port` /
 * nguyên lệnh `ssh -p 2222 user@host`. Enter = tab mới · Alt+Enter = mở cạnh tab đang chọn.
 */
export function QuickConnectDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [invalid, setInvalid] = useState(false)
  const hosts = useHosts((s) => s.tree.hosts)
  const effective = useHosts((s) => s.effective)
  const tree = useHosts((s) => s.groupTree)
  const items = useMemo((): Item[] => {
    const address = parseQuickConnect(query)
    const list: Item[] = []
    if (address) {
      const jumpHost = address.jump ? findJumpHost(address.jump, hosts, effective) : undefined
      list.push({
        kind: 'address',
        text: query.trim(),
        target: address,
        ...(jumpHost ? { jumpHost } : {})
      })
    }
    const q = query.trim()
    const ranked = q
      ? hosts
          .map((h) => ({ h, s: bestScore(q, [h.label, h.hostname, ...h.tags]) }))
          .filter((r): r is { h: HostSummary; s: number } => r.s !== null)
          .sort((a, b) => b.s - a.s)
          .map((r) => r.h)
      : [...hosts]
          .filter((h) => h.lastUsedAt !== null)
          .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    for (const h of ranked.slice(0, MAX))
      list.push({
        kind: 'host',
        host: h,
        address: hostAddress(h, effective.get(h.id)),
        path: h.groupId ? tree.path(h.groupId).join(' › ') : ''
      })
    return list
  }, [query, hosts, effective, tree])
  const at = Math.min(cursor, Math.max(0, items.length - 1))

  /** Ctrl+Enter: lưu địa chỉ vừa gõ thành host (form host điền sẵn). */
  const save = (): void => {
    const target = parseQuickConnect(query)
    if (!target) {
      setInvalid(query.trim().length > 0)
      return
    }
    const jumpHost = target.jump ? findJumpHost(target.jump, hosts, effective) : undefined
    if (target.jump && !jumpHost) {
      setInvalid(true)
      return
    }
    onClose()
    void openSidebarDialog('new-host', undefined, {
      hostname: target.host,
      port: target.port,
      username: target.username,
      ...(jumpHost ? { jumpHostIds: [jumpHost.id] } : {})
    })
  }

  const run = (item: Item | undefined, split: boolean): void => {
    if (!item) {
      setInvalid(query.trim().length > 0)
      return
    }
    if (item.kind === 'address' && item.target.jump && !item.jumpHost) {
      setInvalid(true)
      return
    }
    onClose()
    if (item.kind === 'host') {
      connect(item.host, split ? { split: 'right' } : undefined)
      return
    }
    useTabs.getState().addSsh({
      host: item.target.host,
      port: item.target.port,
      username: item.target.username,
      ...(item.jumpHost ? { jumpHostId: item.jumpHost.id } : {})
    })
  }

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--ds-z-overlay) animate-ds-fade bg-ds-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="quick-connect-dialog"
          className="fixed top-[12vh] left-1/2 z-(--ds-z-palette) flex w-[min(600px,calc(100vw-48px))] -translate-x-1/2 animate-ds-dialog flex-col overflow-hidden rounded-ds-xl bg-ds-popover text-ds-base text-ds-fg shadow-ds-dialog outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{t('Quick connect')}</DialogPrimitive.Title>
          <div
            className={cx(
              'flex h-12 items-center gap-2 border-b px-4',
              invalid ? 'border-ds-danger' : 'border-ds-border-subtle'
            )}
          >
            <Zap {...ICON_SM} className="shrink-0 text-ds-fg-3" />
            <input
              autoFocus
              type="text"
              spellCheck={false}
              autoComplete="off"
              aria-label={t('Quick connect')}
              aria-invalid={invalid}
              data-testid="quick-connect"
              placeholder={t('Host name, user@host:port or an ssh command')}
              className="min-w-0 flex-1 bg-transparent font-mono text-ds-base text-ds-fg outline-none placeholder:font-sans placeholder:text-ds-fg-3"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
                setInvalid(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCursor(Math.min(at + 1, items.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCursor(Math.max(at - 1, 0))
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  save()
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  run(items[at], e.altKey)
                }
              }}
            />
          </div>
          <div role="listbox" aria-label={t('Hosts')} className="max-h-80 overflow-auto p-1.5">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-ds-sm text-ds-fg-3">
                {invalid
                  ? t('Type user@host, user@host:port or a saved host name.')
                  : t('Type a host name or user@host:port.')}
              </p>
            ) : (
              items.map((item, i) => (
                <button
                  key={item.kind === 'host' ? item.host.id : 'address'}
                  type="button"
                  role="option"
                  aria-selected={i === at}
                  data-testid={
                    item.kind === 'host' ? 'quick-connect-host' : 'quick-connect-address'
                  }
                  className={cx(
                    'flex h-10 w-full items-center gap-2.5 rounded-ds-md px-2.5 text-left',
                    i === at ? 'bg-ds-active' : 'hover:bg-ds-hover'
                  )}
                  onMouseMove={() => {
                    if (i !== at) setCursor(i)
                  }}
                  onClick={(e) => {
                    run(item, e.altKey)
                  }}
                >
                  {item.kind === 'host' ? (
                    <HostAvatar host={item.host} size={18} className="rounded-ds-xs" />
                  ) : (
                    <Zap {...ICON_SM} className="text-ds-fg-3" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ds-base text-ds-fg">
                      {item.kind === 'host'
                        ? item.host.label
                        : t('Connect to {target}', {
                            target: `${item.target.username}@${item.target.host}${item.target.port === 22 ? '' : `:${String(item.target.port)}`}`
                          })}
                    </span>
                    {item.kind === 'host' && (
                      <span className="truncate text-ds-sm text-ds-fg-3">
                        {[item.address, item.path].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    {item.kind === 'address' && item.target.jump && (
                      <span
                        className={cx(
                          'truncate text-ds-sm',
                          item.jumpHost ? 'text-ds-fg-3' : 'text-ds-danger'
                        )}
                        data-testid="quick-connect-jump"
                      >
                        {item.jumpHost
                          ? t('via {name}', { name: item.jumpHost.label })
                          : t('Jump host “{name}” is not a saved host — add it first', {
                              name: item.target.jump
                            })}
                      </span>
                    )}
                  </span>
                  {i === at && <CornerDownLeft {...ICON_SM} className="shrink-0 text-ds-fg-3" />}
                </button>
              ))
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-ds-border-subtle px-4 py-2 text-ds-sm text-ds-fg-3">
            <span className="flex items-center gap-1.5">
              <Kbd keys="Enter" /> {t('new tab')}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys="Alt Enter" /> {t('split')}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys="Ctrl Enter" /> {t('save as host')}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys="Esc" /> {t('close')}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
