import { memo } from 'react'
import { ArrowLeftRight, Languages, LockOpen, Moon, Sun } from 'lucide-react'
import { language, t, tn } from '@shared/i18n'
import { formatPercent } from '@shared/i18n/format'
import { cx, ICON_SM } from '../ds/utils'
import { useAppearance } from '../stores/appearance'
import { useSettings } from '../stores/settings'
import { useTabStatus } from '../stores/tab-status'
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
    </footer>
  )
})
