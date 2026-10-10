import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Check, ChevronDown } from 'lucide-react'
import { t } from '@shared/i18n'
import { pickResults, type Pickable } from './select-logic'
import { floatingSurface } from './Popover'
import { usePortalContainer } from './provider'
import { cx, focusRing, ICON_SM, transition } from './utils'

export interface SelectOption<T extends string> extends Pickable {
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
  limit,
  className,
  'data-testid': testId,
  optionTestId
}: {
  value: T | undefined
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  placeholder?: string
  label: string
  emptyText?: string
  /** Hiện tối đa chừng này mục (danh sách dài: gõ để thu hẹp, cuối danh sách báo số còn ẩn). */
  limit?: number
  className?: string
  'data-testid'?: string
  /** data-testid của từng mục trong danh sách (mục có `data-name` = nhãn). */
  optionTestId?: string
}): React.JSX.Element {
  const container = usePortalContainer()
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const selected = options.find((o) => o.value === value)
  const { shown: filtered, more } = useMemo(
    () => pickResults(options, query, limit),
    [options, query, limit]
  )
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
          <OptionList
            id={id}
            label={label}
            options={filtered}
            more={more}
            value={value}
            active={active}
            emptyText={emptyText}
            {...(optionTestId ? { optionTestId } : {})}
            onHover={(i) => {
              if (i !== cursor) setCursor(i)
            }}
            onPick={commit}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

/** Danh sách lựa chọn dùng chung của Combobox / SearchList: tiêu đề nhóm, dấu chọn, "còn N mục". */
function OptionList<T extends string>({
  id,
  label,
  options,
  more,
  value,
  active,
  emptyText,
  optionTestId,
  onHover,
  onPick
}: {
  id: string
  label: string
  options: readonly SelectOption<T>[]
  more: number
  value: T | undefined
  active: SelectOption<T> | undefined
  emptyText: string | undefined
  optionTestId?: string
  onHover: (index: number) => void
  onPick: (option: SelectOption<T>) => void
}): React.JSX.Element {
  return (
    <div id={`${id}-list`} role="listbox" aria-label={label}>
      {options.map((o, i) => (
        <div key={o.value} role="presentation">
          {o.group !== undefined && o.group !== options[i - 1]?.group && (
            <div
              role="presentation"
              className="px-2 pt-1.5 pb-0.5 text-ds-xs font-medium text-ds-fg-3 select-none"
            >
              {o.group}
            </div>
          )}
          <div
            id={`${id}-opt-${String(i)}`}
            role="option"
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            data-highlighted={o === active ? '' : undefined}
            data-testid={optionTestId}
            data-name={o.label}
            className={cx(itemClass, o.disabled && 'text-ds-fg-disabled')}
            onMouseMove={() => {
              onHover(i)
            }}
            onMouseDown={(e) => {
              // Giữ focus ở ô nhập.
              e.preventDefault()
            }}
            onClick={() => {
              onPick(o)
            }}
          >
            {o.value === value && (
              <span className="absolute left-2 flex text-ds-accent-text">
                <Check {...ICON_SM} aria-hidden />
              </span>
            )}
            {o.icon}
            <span className="truncate">{o.label}</span>
            {o.hint && (
              <span className="ml-auto truncate pl-4 text-ds-sm text-ds-fg-3">{o.hint}</span>
            )}
          </div>
        </div>
      ))}
      {options.length === 0 && (
        <div className="px-2 py-3 text-center text-ds-sm text-ds-fg-3">
          {emptyText ?? t('No matches')}
        </div>
      )}
      {more > 0 && (
        <div className="px-2 py-1.5 text-center text-ds-sm text-ds-fg-3" data-more={more}>
          {t('{n} more — type to search', { n: more })}
        </div>
      )}
    </div>
  )
}

/**
 * Ô tìm + danh sách NẰM SẴN (không thả xuống) — cho menu dài trong popover (thêm server Docker…):
 * focus ở ô tìm, ↑↓ chọn, Enter nhận. Chỉ hiện `limit` mục đầu; gõ để tìm trong cả danh sách.
 */
export function SearchList<T extends string>({
  options,
  onPick,
  label,
  placeholder,
  emptyText,
  limit,
  autoFocus = true,
  className,
  onEscape,
  'data-testid': testId,
  optionTestId
}: {
  options: readonly SelectOption<T>[]
  onPick: (value: T) => void
  /** Esc trong ô tìm (đã chặn lan ra ngoài — không đóng luôn hộp thoại chứa nó). */
  onEscape?: () => void
  label: string
  placeholder?: string
  emptyText?: string
  limit?: number
  autoFocus?: boolean
  className?: string
  'data-testid'?: string
  optionTestId?: string
}): React.JSX.Element {
  const id = useId()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const { shown, more } = useMemo(() => pickResults(options, query, limit), [options, query, limit])
  const activeIndex = Math.min(cursor, shown.length - 1)
  const active = shown[activeIndex]
  const commit = (option: SelectOption<T> | undefined): void => {
    if (!option || option.disabled) return
    onPick(option.value)
  }
  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={active ? `${id}-opt-${String(activeIndex)}` : undefined}
        data-testid={testId}
        autoFocus={autoFocus}
        spellCheck={false}
        placeholder={placeholder ?? t('Search…')}
        className={cx(
          'mb-1 h-ds-ctl w-full shrink-0 rounded-ds-md border border-ds-border-control bg-ds-surface-1 px-2.5 text-ds-base text-ds-fg outline-none placeholder:text-ds-fg-3',
          'focus:border-ds-accent focus:ring-3 focus:ring-ds-accent-soft',
          transition
        )}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const delta = e.key === 'ArrowDown' ? 1 : -1
            setCursor((c) => (c + delta + shown.length) % Math.max(1, shown.length))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            commit(active)
          } else if (e.key === 'Escape' && onEscape) {
            e.preventDefault()
            e.stopPropagation()
            onEscape()
          }
        }}
      />
      <div className="min-h-0 overflow-auto">
        <OptionList
          id={id}
          label={label}
          options={shown}
          more={more}
          value={undefined}
          active={active}
          emptyText={emptyText}
          {...(optionTestId ? { optionTestId } : {})}
          onHover={(i) => {
            if (i !== cursor) setCursor(i)
          }}
          onPick={commit}
        />
      </div>
    </div>
  )
}

/**
 * Nút giống ô chọn ("Add a jump host…") mở ô tìm + danh sách NGAY BÊN DƯỚI (không portal — dùng được
 * trong hộp thoại có bẫy focus). Chọn xong thì đóng; Esc / bấm ra ngoài đóng, focus về nút.
 */
export function SearchPicker<T extends string>({
  placeholder,
  options,
  onPick,
  label,
  searchPlaceholder,
  emptyText,
  limit = 12,
  'data-testid': testId,
  optionTestId
}: {
  /** Chữ trên nút. */
  placeholder: string
  options: readonly SelectOption<T>[]
  onPick: (value: T) => void
  label: string
  searchPlaceholder?: string
  emptyText?: string
  limit?: number
  'data-testid'?: string
  optionTestId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    // Form cuộn được: kéo danh sách vào tầm nhìn nếu nó tràn xuống dưới.
    panelRef.current?.scrollIntoView({ block: 'nearest' })
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  return (
    <div ref={rootRef} className="relative" data-capture-keys={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        className={cx(
          'flex h-ds-ctl w-full items-center gap-2 rounded-ds-md border border-ds-border-control bg-ds-surface-1 pr-1.5 pl-2.5 text-left text-ds-base text-ds-fg-2',
          'hover:border-ds-border-strong',
          focusRing,
          transition
        )}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="min-w-0 flex-1 truncate">{placeholder}</span>
        <ChevronDown {...ICON_SM} aria-hidden className="shrink-0 text-ds-fg-3" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className={cx(
            floatingSurface,
            'absolute inset-x-0 top-full z-20 mt-1 flex max-h-80 flex-col p-1.5'
          )}
        >
          <SearchList
            options={options}
            label={label}
            {...(searchPlaceholder ? { placeholder: searchPlaceholder } : {})}
            {...(emptyText ? { emptyText } : {})}
            limit={limit}
            data-testid={testId ? `${testId}-search` : undefined}
            {...(optionTestId ? { optionTestId } : {})}
            onEscape={close}
            onPick={(value) => {
              onPick(value)
              close()
            }}
          />
        </div>
      )}
    </div>
  )
}
