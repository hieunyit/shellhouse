import type { ComponentType, ReactNode } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { Check } from 'lucide-react'
import { Kbd } from './Kbd'
import { floatingSurface } from './Popover'
import { usePortalContainer } from './provider'
import { cx } from './utils'

/**
 * Menu thả xuống / menu chuột phải, khai báo bằng dữ liệu. Radix lo bàn phím: ↑↓ / Home / End,
 * gõ chữ để nhảy tới mục (typeahead theo nhãn), Enter / Space chọn, Esc đóng và trả focus về nút
 * mở. Quy ước: hành động phá huỷ (danger) đặt cuối, sau một đường kẻ; mục không dùng được thì
 * disabled (kèm lý do trong `hint`), không ẩn.
 */
export type MenuEntry =
  | {
      kind?: 'item'
      id: string
      label: string
      icon?: ReactNode
      shortcut?: string
      /** Chữ phụ mờ bên phải (khi không có phím tắt). */
      hint?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | {
      kind: 'checkbox'
      id: string
      label: string
      checked: boolean
      disabled?: boolean
      onCheckedChange: (checked: boolean) => void
    }
  | { kind: 'label'; id: string; label: string }
  | { kind: 'separator'; id: string }

/** Phần chung của DropdownMenu / ContextMenu (cùng API, khác cách mở). */
interface Primitives {
  Item: ComponentType<DropdownMenuPrimitive.DropdownMenuItemProps>
  CheckboxItem: ComponentType<DropdownMenuPrimitive.DropdownMenuCheckboxItemProps>
  ItemIndicator: ComponentType<DropdownMenuPrimitive.DropdownMenuItemIndicatorProps>
  Label: ComponentType<DropdownMenuPrimitive.DropdownMenuLabelProps>
  Separator: ComponentType<DropdownMenuPrimitive.DropdownMenuSeparatorProps>
}

const DROPDOWN: Primitives = DropdownMenuPrimitive
const CONTEXT: Primitives = ContextMenuPrimitive

const contentClass = cx(floatingSurface, 'min-w-50 max-w-80 p-1')

const itemClass = cx(
  'relative flex h-ds-menu-item w-full cursor-default items-center gap-2 rounded-ds-md px-2 text-left text-ds-base whitespace-nowrap text-ds-fg outline-none select-none',
  'data-[highlighted]:bg-ds-active data-[disabled]:text-ds-fg-disabled',
  '[&_svg]:shrink-0 [&_svg]:text-ds-fg-2 data-[disabled]:[&_svg]:text-ds-fg-disabled'
)

function Entries({ entries, P }: { entries: readonly MenuEntry[]; P: Primitives }): ReactNode {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'separator':
        return <P.Separator key={entry.id} className="-mx-1 my-1 h-px bg-ds-border" />
      case 'label':
        return (
          <P.Label key={entry.id} className="px-2 pt-1.5 pb-1 text-ds-xs font-medium text-ds-fg-3">
            {entry.label}
          </P.Label>
        )
      case 'checkbox':
        return (
          <P.CheckboxItem
            key={entry.id}
            checked={entry.checked}
            disabled={entry.disabled}
            onCheckedChange={entry.onCheckedChange}
            // Không đóng menu: bật / tắt nhiều mục liên tiếp (ví dụ chọn cột).
            onSelect={(e) => {
              e.preventDefault()
            }}
            className={cx(itemClass, 'pl-7')}
          >
            <P.ItemIndicator className="absolute left-2 flex">
              <Check size={14} strokeWidth={1.5} className="text-ds-accent-text!" aria-hidden />
            </P.ItemIndicator>
            {entry.label}
          </P.CheckboxItem>
        )
      default:
        return (
          <P.Item
            key={entry.id}
            disabled={entry.disabled}
            textValue={entry.label}
            onSelect={entry.onSelect}
            className={cx(
              itemClass,
              entry.danger &&
                'text-ds-danger data-[highlighted]:bg-ds-danger-soft [&_svg]:text-ds-danger!'
            )}
          >
            {entry.icon}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.shortcut ? (
              <Kbd keys={entry.shortcut} className="pl-4" />
            ) : entry.hint ? (
              <span className="pl-4 text-ds-sm text-ds-fg-3">{entry.hint}</span>
            ) : null}
          </P.Item>
        )
    }
  })
}

/** Menu thả xuống gắn vào một nút (`trigger` phải nhận ref). */
export function Menu({
  trigger,
  entries,
  label,
  align = 'start',
  side = 'bottom',
  open,
  onOpenChange
}: {
  trigger: React.ReactElement
  entries: readonly MenuEntry[]
  /** Tên menu cho trình đọc màn hình. */
  label?: string
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <DropdownMenuPrimitive.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={container}>
        <DropdownMenuPrimitive.Content
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          // Có label riêng → dùng nó làm tên menu (mặc định Radix lấy chữ của nút mở).
          {...(label ? { 'aria-label': label, 'aria-labelledby': undefined } : {})}
          className={contentClass}
        >
          <Entries entries={entries} P={DROPDOWN} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

/** Menu chuột phải (và Shift+F10 / phím Menu khi vùng đang focus) cho `children`. */
export function ContextMenu({
  children,
  entries,
  label,
  onOpenChange
}: {
  children: React.ReactElement
  entries: readonly MenuEntry[]
  label?: string
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <ContextMenuPrimitive.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <ContextMenuPrimitive.Trigger
        asChild
        onKeyDown={(e) => {
          // Bàn phím: Shift+F10 / phím ContextMenu mở menu tại phần tử đang focus.
          if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            e.currentTarget.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: rect.left + 8,
                clientY: rect.top + rect.height / 2
              })
            )
          }
        }}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal container={container}>
        <ContextMenuPrimitive.Content
          collisionPadding={8}
          aria-label={label}
          className={contentClass}
        >
          <Entries entries={entries} P={CONTEXT} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}
