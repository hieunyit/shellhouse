import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Check, ChevronDown } from 'lucide-react'
import { t } from '@shared/i18n'
import { bestScore } from '@shared/fuzzy'
import { floatingSurface } from './Popover'
import { usePortalContainer } from './provider'
import { cx, focusRing, ICON_SM, transition } from './utils'

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Chữ phụ bên phải (mờ). */
  hint?: string
  icon?: ReactNode
  disabled?: boolean
}

const trigger = cx(
  'inline-flex h-ds-ctl min-w-30 items-center justify-between gap-2 rounded-ds-md border border-ds-border bg-ds-surface-1 pr-2 pl-2.5 text-ds-base text-ds-fg',
  'hover:border-ds-border-strong data-[placeholder]:text-ds-fg-3 disabled:text-ds-fg-disabled',
  focusRing,
  transition
)

const itemClass = cx(
  'relative flex h-ds-menu-item cursor-default items-center gap-2 rounded-ds-md pr-2 pl-7 text-ds-base text-ds-fg outline-none select-none',
  'data-[highlighted]:bg-ds-active data-[disabled]:text-ds-fg-disabled [&_svg]:text-ds-fg-2'
)

/**
 * Chọn một giá trị trong danh sách ngắn (dạng nút). Bàn phím: Space / Enter / ↓ mở, ↑↓ chọn, gõ chữ
 * để nhảy tới mục (typeahead), Esc đóng (Radix). Danh sách dài / cần tìm → Combobox.
 */
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  label,
  disabled,
  className,
  'data-testid': testId
}: {
  value: T | undefined
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  placeholder?: string
  /** Tên cho trình đọc màn hình khi không có <label> bên ngoài. */
  label?: string
  disabled?: boolean
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <SelectPrimitive.Root
      {...(value !== undefined ? { value } : {})}
      onValueChange={(v) => {
        const option = options.find((o) => o.value === v)
        if (option) onValueChange(option.value)
      }}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        data-testid={testId}
        className={cx(trigger, className)}
      >
        <SelectPrimitive.Value placeholder={placeholder ?? t('Select…')} />
        <SelectPrimitive.Icon className="text-ds-fg-3">
          <ChevronDown {...ICON_SM} aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cx(
            floatingSurface,
            'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden'
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={itemClass}
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 flex text-ds-accent-text">
                  <Check {...ICON_SM} aria-hidden />
                </SelectPrimitive.ItemIndicator>
                {o.icon}
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint && <span className="ml-auto pl-4 text-ds-sm text-ds-fg-3">{o.hint}</span>}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/**
 * Combobox: ô nhập + danh sách lọc (role=combobox / listbox, aria-activedescendant — focus luôn ở ô
 * nhập). ↑↓ chọn, Enter nhận, Esc đóng danh sách (lần nữa thì để Esc lan ra ngoài).
 */
export function Combobox<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  label,
  emptyText,
  className,
  'data-testid': testId
}: {
  value: T | undefined
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  placeholder?: string
  label: string
  emptyText?: string
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const container = usePortalContainer()
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const selected = options.find((o) => o.value === value)
  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) return options
    return options
      .map((o) => ({ o, score: bestScore(q, [o.label, o.value, o.hint ?? '']) }))
      .filter((r): r is { o: SelectOption<T>; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.o)
  }, [options, query])
  const activeIndex = Math.min(cursor, filtered.length - 1)
  const active = filtered[activeIndex]

  const commit = (option: SelectOption<T> | undefined): void => {
    if (!option || option.disabled) return
    onValueChange(option.value)
    setOpen(false)
    setQuery('')
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div
          className={cx(
            'flex h-ds-ctl min-w-0 items-center gap-1.5 rounded-ds-md border border-ds-border-control bg-ds-surface-1 pr-1.5 pl-2.5 text-ds-base',
            'hover:border-ds-border-strong focus-within:border-ds-accent focus-within:ring-3 focus-within:ring-ds-accent-soft',
            transition,
            className
          )}
        >
          <input
            ref={inputRef}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && active ? `${id}-opt-${String(activeIndex)}` : undefined}
            data-testid={testId}
            spellCheck={false}
            placeholder={selected?.label ?? placeholder ?? t('Search…')}
            className={cx(
              'h-full min-w-0 flex-1 bg-transparent text-ds-fg outline-none',
              selected && !query ? 'placeholder:text-ds-fg' : 'placeholder:text-ds-fg-3'
            )}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
              setOpen(true)
            }}
            onFocus={() => {
              setOpen(true)
            }}
            onClick={() => {
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (!open) {
                  setOpen(true)
                  return
                }
                const delta = e.key === 'ArrowDown' ? 1 : -1
                setCursor((c) => (c + delta + filtered.length) % Math.max(1, filtered.length))
              } else if (e.key === 'Enter' && open) {
                e.preventDefault()
                commit(active)
              } else if (e.key === 'Escape' && open) {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                setQuery('')
              } else if (e.key === 'Tab') {
                setOpen(false)
              }
            }}
          />
          <ChevronDown {...ICON_SM} aria-hidden className="shrink-0 text-ds-fg-3" />
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // Focus ở lại ô nhập; bấm vào ô nhập không tính là "bấm ra ngoài".
          onOpenAutoFocus={(e) => {
            e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (inputRef.current?.contains(e.target as Node)) e.preventDefault()
          }}
          className={cx(
            floatingSurface,
            'max-h-72 w-(--radix-popover-trigger-width) min-w-48 overflow-auto p-1'
          )}
        >
          <div id={`${id}-list`} role="listbox" aria-label={label}>
            {filtered.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-opt-${String(i)}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-highlighted={o === active ? '' : undefined}
                className={cx(itemClass, o.disabled && 'text-ds-fg-disabled')}
                onMouseMove={() => {
                  if (i !== cursor) setCursor(i)
                }}
                onMouseDown={(e) => {
                  // Giữ focus ở ô nhập.
                  e.preventDefault()
                }}
                onClick={() => {
                  commit(o)
                }}
              >
                {o.value === value && (
                  <span className="absolute left-2 flex text-ds-accent-text">
                    <Check {...ICON_SM} aria-hidden />
                  </span>
                )}
                {o.icon}
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="ml-auto pl-4 text-ds-sm text-ds-fg-3">{o.hint}</span>}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-ds-sm text-ds-fg-3">
                {emptyText ?? t('No matches')}
              </div>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
