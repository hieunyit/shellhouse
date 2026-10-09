import { memo, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowLeftRight,
  Folder,
  House,
  Lock,
  LockOpen,
  Puzzle,
  Server,
  Settings
} from 'lucide-react'
import { t } from '@shared/i18n'
import { Tooltip } from '../ds'
import { cx, ICON_SM } from '../ds/utils'
import { moduleIcon, useEnabledModules } from '../../../modules/registry/renderer-kit'
import { browseModules } from '../stores/module-ui'
import { useTransfers } from '../stores/transfers'
import { initials } from './initials'
import { useShell, type Area } from './store'

const ICON = { size: 18, strokeWidth: 1.5 } as const

/** Thứ tự module trên activity bar theo thiết kế: Kubernetes → Docker → S3; module khác xếp sau. */
const MODULE_ORDER = ['k8s', 'docker', 's3', 'runbook']
const moduleRank = (id: string): number => {
  const i = MODULE_ORDER.indexOf(id)
  return i === -1 ? MODULE_ORDER.length : i
}

function Item({
  area,
  label,
  icon,
  shortcut,
  badge,
  alert,
  testId,
  onClick
}: {
  area?: Area
  label: string
  icon: ReactNode
  shortcut?: string
  badge?: number
  alert?: boolean
  testId: string
  onClick?: () => void
}): React.JSX.Element {
  const current = useShell((s) => area !== undefined && s.area === area)
  return (
    <Tooltip content={label} side="right" {...(shortcut ? { shortcut } : {})}>
      <button
        type="button"
        aria-label={label}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
        data-area={area}
        className={cx(
          'relative flex size-8 items-center justify-center rounded-ds-md outline-none',
          'transition-colors duration-(--ds-dur-fast) focus-visible:shadow-ds-focus',
          current
            ? 'bg-ds-active text-ds-fg before:absolute before:top-1.5 before:bottom-1.5 before:-left-2 before:w-0.5 before:rounded-full before:bg-ds-accent'
            : 'text-ds-fg-3 hover:bg-ds-hover hover:text-ds-fg-2'
        )}
        onClick={
          onClick ??
          (() => {
            if (!area) return
            const shell = useShell.getState()
            // Bấm lại khu vực đang chọn: ẩn / hiện Explorer (như VS Code).
            if (shell.area === area) shell.toggleExplorer()
            else {
              shell.go(area)
              shell.toggleExplorer(false)
            }
          })
        }
      >
        {icon}
        {alert && (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-1.5 rounded-full bg-ds-danger ring-2 ring-ds-bg"
          />
        )}
        {badge !== undefined && badge > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ds-surface-3 px-1 text-ds-xs leading-none font-medium text-ds-fg-2 tabular-nums ring-2 ring-ds-bg"
          >
            {badge}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/**
 * Activity bar 48px: Home · Hosts · Files · module (Kubernetes, Docker, S3…) · Transfers; đáy:
 * Settings, khoá vault. Mục đang chọn: nền active + vạch teal 2px bên trái.
 */
export const ActivityBar = memo(function ActivityBar(): React.JSX.Element {
  const modules = useEnabledModules()
    .filter((m) => m.SidebarSection)
    .sort((a, b) => moduleRank(a.manifest.id) - moduleRank(b.manifest.id))
  const active = useTransfers((s) => s.activeCount())
  return (
    <nav
      aria-label={t('Activity bar')}
      className="flex w-(--ds-activitybar-w) shrink-0 flex-col items-center gap-1 bg-ds-bg pt-1 pb-2"
      data-testid="activity-bar"
    >
      <Item area="home" label={t('Home')} icon={<House {...ICON} />} testId="open-home" />
      <div role="separator" className="my-1 h-px w-5 bg-ds-border" />
      <Item area="hosts" label={t('Hosts')} icon={<Server {...ICON} />} testId="activity-hosts" />
      <Item area="files" label={t('Files')} icon={<Folder {...ICON} />} testId="activity-files" />
      {modules.map((m) => {
        const Icon = moduleIcon(m.manifest.icon)
        return (
          <Item
            key={m.manifest.id}
            area={`m:${m.manifest.id}`}
            label={m.manifest.name}
            icon={<Icon {...ICON} />}
            testId={`activity-${m.manifest.id}`}
          />
        )
      })}
      <Item
        area="transfers"
        label={t('Transfers')}
        icon={<ArrowLeftRight {...ICON} />}
        badge={active}
        testId="activity-transfers"
      />
      <Item
        label={t('Add module…')}
        icon={<Puzzle {...ICON} />}
        testId="activity-add-module"
        onClick={browseModules}
      />
      <div className="flex-1" />
      <Item
        area="settings"
        label={t('Settings')}
        icon={<Settings {...ICON} />}
        testId="open-settings"
        onClick={() => {
          const shell = useShell.getState()
          if (shell.area === 'settings') shell.toggleExplorer()
          else shell.openSettings()
        }}
      />
      <AccountAvatar />
    </nav>
  )
})

/**
 * Avatar ở đáy activity bar (thiết kế v0.5): chữ viết tắt của người dùng trên máy + khoá mở nhỏ;
 * bấm = khoá vault (phiên vẫn chạy).
 */
function AccountAvatar(): React.JSX.Element {
  const [name, setName] = useState('')
  useEffect(() => {
    void window.shellhouse.getInfo().then((info) => {
      setName(info.userName)
    })
  }, [])
  const label = t('Lock (sessions keep running)')
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        aria-label={label}
        data-testid="lock-vault"
        className="relative flex size-8 items-center justify-center rounded-ds-md outline-none hover:bg-ds-hover focus-visible:shadow-ds-focus"
        onClick={() => void window.shellhouse.lockVault()}
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-ds-surface-3 text-[10px] font-semibold text-ds-fg-2">
          {initials(name) || <Lock {...ICON_SM} />}
        </span>
        <span
          aria-hidden
          className="absolute right-0.5 bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-ds-bg text-ds-success"
        >
          <LockOpen size={9} strokeWidth={2} />
        </span>
      </button>
    </Tooltip>
  )
}
