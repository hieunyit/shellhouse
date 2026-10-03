import { useCallback, useState, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { t } from '@shared/i18n'
import { cx, IconButton } from './ui'

/**
 * Cột điều hướng thu gọn được thành dải icon — cho module (Docker, Kubernetes, S3…) nhường chỗ
 * ngang cho bảng + panel chi tiết. Lấy qua renderer-kit:
 *
 *   const [collapsed, setCollapsed] = useCollapsedNav('docker')
 *   <CollapsibleNav collapsed={collapsed} width={240}>
 *     <NavCollapseToggle collapsed={collapsed} onToggle={setCollapsed} />
 *     <NavItem icon={<Box size={15} />} label={t('Containers')} count={12} active collapsed={collapsed} />
 *   </CollapsibleNav>
 *
 * Trạng thái nhớ theo máy (localStorage), riêng cho từng `id`.
 */

export const NAV_COLLAPSED_WIDTH = 48

const key = (id: string): string => `shellhouse.nav.collapsed.${id}`

export function useCollapsedNav(
  id: string,
  defaultCollapsed = false
): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key(id))
      return raw === null ? defaultCollapsed : raw === '1'
    } catch {
      return defaultCollapsed
    }
  })
  const set = useCallback(
    (value: boolean) => {
      setState(value)
      try {
        localStorage.setItem(key(id), value ? '1' : '0')
      } catch {
        // Không lưu được → chỉ mất lựa chọn giao diện.
      }
    },
    [id]
  )
  return [collapsed, set]
}

/** Khung cột điều hướng: đổi độ rộng mượt (chỉ ảnh hưởng nội dung module, không có terminal). */
export function CollapsibleNav({
  collapsed,
  width = 240,
  className,
  children,
  'aria-label': ariaLabel,
  ...rest
}: {
  collapsed: boolean
  width?: number
  className?: string
  children: ReactNode
  'aria-label'?: string
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <nav
      aria-label={ariaLabel}
      data-collapsed={collapsed ? 'true' : undefined}
      className={cx(
        'flex shrink-0 flex-col overflow-x-hidden overflow-y-auto transition-[width] duration-150 ease-out motion-reduce:transition-none',
        className
      )}
      style={{ width: collapsed ? NAV_COLLAPSED_WIDTH : width }}
      {...rest}
    >
      {children}
    </nav>
  )
}

export function NavCollapseToggle({
  collapsed,
  onToggle,
  className
}: {
  collapsed: boolean
  onToggle: (collapsed: boolean) => void
  className?: string
}): React.JSX.Element {
  return (
    <IconButton
      label={collapsed ? t('Expand navigation') : t('Collapse navigation')}
      size="sm"
      aria-expanded={!collapsed}
      data-testid="nav-collapse-toggle"
      {...(className ? { className } : {})}
      onClick={() => {
        onToggle(!collapsed)
      }}
    >
      {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
    </IconButton>
  )
}

/** Mục điều hướng: thu gọn thì chỉ còn icon (tên hiện ở tooltip, số đếm thành chấm nhỏ). */
export function NavItem({
  icon,
  label,
  count,
  active,
  collapsed,
  onClick,
  testId
}: {
  icon: ReactNode
  label: string
  count?: number | string | null
  active?: boolean
  collapsed: boolean
  onClick: () => void
  testId?: string
}): React.JSX.Element {
  const hasCount = count !== undefined && count !== null && count !== ''
  return (
    <button
      type="button"
      title={collapsed ? (hasCount ? `${label} (${String(count)})` : label) : undefined}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      data-testid={testId}
      className={cx(
        'relative flex h-8 w-full shrink-0 items-center gap-2 rounded-md text-[13px] transition-colors',
        collapsed ? 'justify-center px-0' : 'px-2',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!collapsed && hasCount && (
        <span className="text-[11px] text-faint tabular-nums">{String(count)}</span>
      )}
    </button>
  )
}
