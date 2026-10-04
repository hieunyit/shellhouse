import { memo } from 'react'
import { ArrowLeft, ArrowRight, LayoutGrid, Search, Zap } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button, IconButton, Kbd } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { useSettings } from '../stores/settings'
import { kbdKeys } from './keys'
import { useShell } from './store'

/**
 * Thanh tiêu đề tự vẽ (cửa sổ frameless — window-chrome.ts), cao 38px, nền khung: logo, ← / →
 * (lịch sử khu vực), command center ở giữa (mở bảng lệnh), Quick connect và Workspaces bên phải.
 * Cả thanh là vùng kéo cửa sổ (.sh-titlebar); macOS chừa chỗ cho đèn giao thông bên trái,
 * Windows / Linux chừa chỗ cho nút cửa sổ bên phải (.sh-titlebar-trail).
 */
export const TitleBar = memo(function TitleBar({
  onPalette,
  onQuickConnect,
  onWorkspaces
}: {
  onPalette: () => void
  onQuickConnect: () => void
  onWorkspaces: () => void
}): React.JSX.Element {
  const canBack = useShell((s) => s.historyAt > 0)
  const canForward = useShell((s) => s.historyAt < s.history.length - 1)
  const overrides = useSettings((s) => s.settings.keybindings)
  const paletteKeys = kbdKeys('palette.open', overrides)
  return (
    <header
      className="sh-titlebar sh-titlebar-lead sh-titlebar-trail relative grid h-(--ds-titlebar-h) shrink-0 grid-cols-[1fr_minmax(0,560px)_1fr] items-center gap-3 bg-ds-bg pr-2 pl-3 text-ds-sm text-ds-fg-2"
      data-testid="titlebar"
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="sh-titlebar-logo mr-2 flex items-center gap-2" aria-hidden>
          <span className="flex size-5.5 items-center justify-center rounded-ds-sm bg-ds-accent font-mono text-[11px] leading-none font-bold text-ds-accent-contrast">
            {'>_'}
          </span>
          <span className="text-ds-sm font-semibold text-ds-fg">Shellhouse</span>
        </span>
        <IconButton
          label={t('Back')}
          size="sm"
          disabled={!canBack}
          data-testid="nav-back"
          tooltipSide="bottom"
          onClick={() => {
            useShell.getState().back()
          }}
        >
          <ArrowLeft {...ICON_SM} />
        </IconButton>
        <IconButton
          label={t('Forward')}
          size="sm"
          disabled={!canForward}
          data-testid="nav-forward"
          tooltipSide="bottom"
          onClick={() => {
            useShell.getState().forward()
          }}
        >
          <ArrowRight {...ICON_SM} />
        </IconButton>
      </div>
      <button
        type="button"
        data-testid="command-center"
        className={cx(
          'flex h-6.5 min-w-0 items-center gap-2 rounded-ds-md border border-ds-border bg-ds-surface-1 px-2.5 text-ds-sm text-ds-fg-3',
          'outline-none hover:border-ds-border-strong hover:text-ds-fg-2 focus-visible:shadow-ds-focus'
        )}
        onClick={onPalette}
      >
        <Search {...ICON_SM} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {t('Search hosts, resources, commands…')}
        </span>
        {paletteKeys && <Kbd keys={paletteKeys} />}
      </button>
      <div className="flex min-w-0 items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          icon={<Zap {...ICON_SM} />}
          data-testid="titlebar-connect"
          onClick={onQuickConnect}
        >
          {t('Connect')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<LayoutGrid {...ICON_SM} />}
          data-testid="open-workspaces"
          onClick={onWorkspaces}
        >
          {t('Workspaces')}
        </Button>
      </div>
    </header>
  )
})
