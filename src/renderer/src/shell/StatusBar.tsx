import { memo, useState } from 'react'
import {
  ArrowLeftRight,
  Bell,
  CircleAlert,
  CircleCheck,
  Info,
  Languages,
  LockOpen,
  Moon,
  Sun,
  TriangleAlert
} from 'lucide-react'
import { language, t, tn } from '@shared/i18n'
import { formatPercent, formatRelative } from '@shared/i18n/format'
import { Popover } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { useAppearance } from '../stores/appearance'
import { useSettings } from '../stores/settings'
import { useTabStatus } from '../stores/tab-status'
import {
  clearNotifications,
  markNotificationsRead,
  useToasts,
  type ToastTone
} from '../stores/toasts'
import { transferSummary, useTransfers } from '../stores/transfers'
import { useShell } from './store'

const ITEM =
  'inline-flex h-5.5 min-w-0 items-center gap-1.5 rounded-ds-sm px-1.5 text-ds-fg-2 outline-none hover:bg-ds-hover hover:text-ds-fg focus-visible:shadow-ds-focus'

/**
 * Status bar 26px (nền khung): số phiên đang kết nối · vault · tác vụ nền (truyền file + tiến độ
 * xanh dương) | ngôn ngữ · theme. Không lặp môi trường / ⌘K (đã có trên header / title bar).
 */
export const StatusBar = memo(function StatusBar(): React.JSX.Element {
  const connected = useTabStatus(
    (s) => Object.values(s.byTab).filter((x) => x === 'connected').length
  )
  const failing = useTabStatus(
    (s) => Object.values(s.byTab).filter((x) => x === 'disconnected').length
  )
  const sources = useTransfers((s) => s.sources)
  const transfers = transferSummary(sources)
  const dark = useAppearance((s) => s.dark)
  const update = useSettings((s) => s.update)
  return (
    <footer
      role="contentinfo"
      aria-live="polite"
      className="flex h-(--ds-statusbar-h) shrink-0 items-center gap-1 bg-ds-bg px-2 text-ds-sm text-ds-fg-2"
      data-testid="statusbar"
    >
      <span className={cx(ITEM, 'pointer-events-none')} data-testid="statusbar-sessions">
        <span
          aria-hidden
          className={cx(
            'size-1.5 shrink-0 rounded-full',
            failing > 0
              ? 'bg-ds-danger'
              : connected > 0
                ? 'bg-ds-success'
                : 'border border-ds-status-off'
          )}
        />
        {tn(connected, '{n} session', '{n} sessions')}
        {failing > 0 && (
          <span className="text-ds-danger">
            · {tn(failing, '{n} disconnected', '{n} disconnected')}
          </span>
        )}
      </span>
      <button
        type="button"
        className={ITEM}
        title={t('Lock (sessions keep running)')}
        data-testid="statusbar-vault"
        onClick={() => void window.shellhouse.lockVault()}
      >
        <LockOpen {...ICON_SM} />
        {t('Vault unlocked')}
      </button>
      {(transfers.active > 0 || transfers.failed > 0) && (
        <button
          type="button"
          className={ITEM}
          data-testid="statusbar-transfers"
          onClick={() => {
            useShell.getState().go('transfers')
          }}
        >
          <ArrowLeftRight {...ICON_SM} />
          {transfers.active > 0 &&
            tn(transfers.active, '{n} transfer', '{n} transfers') +
              (transfers.progress !== null ? ` · ${formatPercent(transfers.progress)}` : '')}
          {transfers.active > 0 && transfers.progress !== null && (
            <span
              aria-hidden
              className="relative h-1 w-14 overflow-hidden rounded-full bg-ds-chart-track"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-ds-info"
                style={{ width: `${String(transfers.progress * 100)}%` }}
              />
            </span>
          )}
          {transfers.failed > 0 && (
            <span className="text-ds-danger">
              {tn(transfers.failed, '{n} failed', '{n} failed')}
            </span>
          )}
        </button>
      )}
      <div className="flex-1" />
      <button
        type="button"
        className={ITEM}
        title={t('Language')}
        data-testid="statusbar-language"
        onClick={() => {
          useShell.getState().openSettings('appearance')
        }}
      >
        <Languages {...ICON_SM} />
        {language() === 'vi' ? 'VI' : 'EN'}
      </button>
      <button
        type="button"
        className={ITEM}
        aria-label={dark ? t('Switch to light theme') : t('Switch to dark theme')}
        title={dark ? t('Switch to light theme') : t('Switch to dark theme')}
        data-testid="statusbar-theme"
        onClick={() => void update({ appearance: { theme: dark ? 'light' : 'dark' } })}
      >
        {dark ? <Moon {...ICON_SM} /> : <Sun {...ICON_SM} />}
      </button>
      <NotificationBell />
    </footer>
  )
})

const TONE_ICON: Record<Exclude<ToastTone, 'loading'>, React.ReactNode> = {
  success: <CircleCheck {...ICON_SM} className="text-ds-success" />,
  error: <CircleAlert {...ICON_SM} className="text-ds-danger" />,
  warning: <TriangleAlert {...ICON_SM} className="text-ds-warning" />,
  info: <Info {...ICON_SM} className="text-ds-info" />
}

/** Chuông thông báo (thiết kế v0.5): số chưa xem; mở → các thông báo gần đây, mới nhất trước. */
function NotificationBell(): React.JSX.Element {
  const history = useToasts((s) => s.history)
  const unread = useToasts((s) => s.unread)
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) markNotificationsRead()
      }}
      side="top"
      align="end"
      label={t('Notifications')}
      className="w-80 p-0"
      trigger={
        <button
          type="button"
          className={ITEM}
          aria-label={
            unread > 0 ? t('Notifications ({n} new)', { n: String(unread) }) : t('Notifications')
          }
          title={t('Notifications')}
          data-testid="statusbar-notifications"
        >
          <Bell {...ICON_SM} />
          {unread > 0 && (
            <span className="tabular-nums" data-testid="statusbar-notifications-count">
              {unread}
            </span>
          )}
        </button>
      }
    >
      <div data-testid="notifications-panel">
        <div className="flex h-9 items-center gap-2 border-b border-ds-border-subtle px-3">
          <span className="flex-1 text-ds-sm font-medium text-ds-fg">{t('Notifications')}</span>
          {history.length > 0 && (
            <button
              type="button"
              className="rounded-ds-sm px-1.5 py-0.5 text-ds-sm text-ds-fg-3 hover:bg-ds-hover hover:text-ds-fg"
              data-testid="notifications-clear"
              onClick={() => {
                clearNotifications()
              }}
            >
              {t('Clear all')}
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="px-3 py-6 text-center text-ds-sm text-ds-fg-3">
            {t('No notifications yet.')}
          </p>
        ) : (
          <ul className="max-h-96 overflow-auto py-1">
            {history.map((n) => (
              <li
                key={n.id}
                className="flex gap-2.5 px-3 py-2 hover:bg-ds-hover"
                data-testid="notification-item"
                data-tone={n.tone}
              >
                <span className="mt-0.5 shrink-0">
                  {n.tone === 'loading' ? null : TONE_ICON[n.tone]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-ds-sm font-medium text-ds-fg">{n.title}</div>
                  {n.description && (
                    <div className="mt-0.5 text-ds-sm text-ds-fg-3">{n.description}</div>
                  )}
                  <div className="mt-0.5 flex items-center gap-2 text-ds-xs text-ds-fg-4">
                    {formatRelative(n.createdAt)}
                    {n.action && (
                      <button
                        type="button"
                        className="text-ds-accent-text hover:underline"
                        onClick={() => {
                          n.action?.run()
                          setOpen(false)
                        }}
                      >
                        {n.action.label}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  )
}
