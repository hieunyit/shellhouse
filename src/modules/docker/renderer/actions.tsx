import { MoreHorizontal } from 'lucide-react'
import type { MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { t } from '../../registry/renderer-kit'

/**
 * Thao tác trên một mục (container, image, volume, network): cùng một danh sách cho menu chuột
 * phải, nút "⋯" trên dòng, nút nhanh trên dòng, thanh chi tiết và phím tắt — không lệch nhau.
 */
export interface DetailAction {
  id: string
  label: string
  icon: React.ReactNode
  /** Phím tắt khi mục đang được chọn ("l", "ctrl+d"). */
  key?: string
  danger?: boolean
  /** Chỉ trong menu "…" (Copy name…), không thành nút chính. */
  secondary?: boolean
  disabled?: boolean
  run(): void
}

/** "ctrl+d" → "Ctrl+D", "l" → "L" (macOS: ⌘). */
export function keyLabel(key: string): string {
  const mac = /Mac/i.test(navigator.platform)
  return key
    .split('+')
    .map((k) => (k === 'ctrl' ? (mac ? '⌘' : 'Ctrl') : k.length === 1 ? k.toUpperCase() : k))
    .join(mac ? '' : '+')
}

/** Chú thích khi rê chuột: "Logs (L)". */
export function actionTitle(a: Pick<DetailAction, 'label' | 'key'>): string {
  const label = a.label.replace(/…$/, '')
  return a.key ? `${label} (${keyLabel(a.key)})` : label
}

/** Danh sách thao tác → menu (thao tác nguy hiểm tách riêng cuối menu). */
export function toMenu(actions: readonly DetailAction[]): MenuEntry[] {
  const out: MenuEntry[] = []
  let danger = false
  for (const a of actions) {
    if (a.danger && !danger && out.length) {
      out.push('separator')
      danger = true
    }
    out.push({
      id: a.id,
      label: a.label,
      icon: a.icon,
      ...(a.key ? { hint: keyLabel(a.key) } : {}),
      ...(a.danger ? { danger: true } : {}),
      ...(a.disabled ? { disabled: true } : {}),
      onSelect: () => {
        a.run()
      }
    })
  }
  return out
}

type OpenMenu = (
  event: { clientX: number; clientY: number; preventDefault: () => void },
  entries: MenuEntry[]
) => void

/** Mở menu ngay dưới nút (bấm chuột hoặc Enter / Space trên nút). */
export function openMenuBelow(target: HTMLElement, open: OpenMenu, entries: MenuEntry[]): void {
  const r = target.getBoundingClientRect()
  open({ clientX: r.left, clientY: r.bottom + 2, preventDefault: () => undefined }, entries)
}

/**
 * Nút thao tác trên một dòng: vài nút biểu tượng nhỏ (chú thích + phím tắt khi rê chuột, nhãn cho
 * trình đọc màn hình) và nút "⋯" luôn hiện mở menu đầy đủ có chữ.
 */
export function RowActions({
  name,
  quick,
  all,
  openMenu,
  testIdPrefix
}: {
  /** Tên mục (cho nhãn trợ năng: "Logs — web"). */
  name: string
  quick: readonly (DetailAction & { testId?: string })[]
  all: readonly DetailAction[]
  openMenu: OpenMenu
  testIdPrefix: string
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      onClick={(e) => {
        e.stopPropagation()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
      }}
    >
      {quick.map((a) => (
        <button
          key={a.id}
          type="button"
          title={actionTitle(a)}
          aria-label={t('{action} — {name}', { action: a.label.replace(/…$/, ''), name })}
          data-testid={a.testId ?? `${testIdPrefix}-${a.id}`}
          disabled={a.disabled}
          className="inline-flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30"
          onClick={() => {
            a.run()
          }}
        >
          {a.icon}
        </button>
      ))}
      {all.length > 0 && (
        <button
          type="button"
          title={t('More actions')}
          aria-label={t('More actions for {name}', { name })}
          aria-haspopup="menu"
          data-testid={`${testIdPrefix}-more`}
          className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
          onClick={(e) => {
            openMenuBelow(e.currentTarget, openMenu, toMenu(all))
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </span>
  )
}
