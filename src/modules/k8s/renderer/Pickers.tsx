import { useCallback, useEffect, useRef, useState } from 'react'
import { cx } from '../../../renderer/src/components/ui'
import { t, tn } from '../../registry/renderer-kit'

/** Hộp thả xuống đóng khi bấm ra ngoài. */
function useOutsideClose(open: boolean, close: () => void): React.RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, close])
  return box
}

/**
 * Phím trong menu thả xuống: ↑ ↓ / Home / End đi giữa các mục `[data-menu-item]`, Esc đóng và trả
 * focus về nút mở (preventDefault → phím tắt của tab không chạy "quay lại").
 */
function menuKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  list: HTMLElement | null,
  close: () => void
): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  if (!list || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = [...list.querySelectorAll<HTMLElement>('[data-menu-item]')]
  if (!items.length) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (at + 1) % items.length
          : at <= 0
            ? items.length - 1
            : at - 1
  items[next]?.focus()
}

export function ContextPicker({
  current,
  label,
  color,
  version,
  contexts,
  onPick
}: {
  current: string
  label: string
  color: string
  version: string | undefined
  contexts: { key: string; name: string; source: string; color: string }[]
  onPick: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
  }, [])
  const box = useOutsideClose(open, close)
  // Mở → focus mục đang dùng (dùng phím ngay).
  useEffect(() => {
    if (!open) return
    const el =
      list.current?.querySelector<HTMLElement>('[data-menu-item][aria-checked="true"]') ??
      list.current?.querySelector<HTMLElement>('[data-menu-item]')
    el?.focus()
  }, [open])
  const closeAndFocus = (): void => {
    setOpen(false)
    button.current?.focus()
  }
  return (
    <div
      className="relative"
      ref={box}
      onKeyDown={(e) => {
        if (open) menuKeyDown(e, list.current, closeAndFocus)
      }}
    >
      <button
        ref={button}
        type="button"
        data-testid="k8s-context-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 max-w-56 items-center gap-2 rounded-md px-2 hover:bg-hover"
        onClick={() => {
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className={cx('size-2 shrink-0 rounded-full', color)} />
        <span
          className="truncate text-[13px] font-semibold text-fg"
          data-testid="k8s-context-label"
        >
          {label}
        </span>
        {version && <span className="text-[11px] text-faint">{version}</span>}
        <span className="text-faint" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          aria-label={t('Contexts')}
          className="absolute top-9 left-0 z-30 max-h-80 w-72 overflow-auto rounded-md border border-line bg-elevated p-1 shadow-lg"
          data-testid="k8s-context-menu"
        >
          {contexts.map((c) => (
            <button
              key={c.key}
              type="button"
              role="menuitemradio"
              aria-checked={c.key === current}
              data-menu-item
              data-testid="k8s-context-option"
              data-name={c.name}
              className={cx(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs outline-none hover:bg-hover focus-visible:bg-hover',
                c.key === current && 'bg-accent-soft'
              )}
              onClick={() => {
                setOpen(false)
                if (c.key !== current) onPick(c.key)
              }}
            >
              <span className={cx('size-2 shrink-0 rounded-full', c.color)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg">{c.name}</span>
                <span className="block truncate text-faint">{c.source}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function NamespacePicker({
  all,
  value,
  onChange
}: {
  all: string[]
  value: string[]
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
  }, [])
  const box = useOutsideClose(open, close)
  const many = all.length > 8
  // Mở (không có ô tìm) → focus mục đầu.
  useEffect(() => {
    if (!open || many) return
    list.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
  }, [open, many])
  const closeAndFocus = (): void => {
    setOpen(false)
    button.current?.focus()
  }
  const label =
    value.length === 0
      ? t('All namespaces')
      : value.length === 1
        ? value[0]
        : tn(value.length, '{n} namespace', '{n} namespaces')
  const needle = filter.trim()
  const shown = needle ? all.filter((n) => n.includes(needle)) : all
  return (
    <div
      className="relative"
      ref={box}
      onKeyDown={(e) => {
        if (open) menuKeyDown(e, list.current, closeAndFocus)
      }}
    >
      <button
        ref={button}
        type="button"
        data-testid="k8s-namespace"
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-8 max-w-48 truncate rounded-md border border-line bg-surface px-2 text-xs text-fg hover:border-line-strong"
        onClick={() => {
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div
          className="absolute top-9 left-0 z-30 w-60 rounded-md border border-line bg-elevated p-1 shadow-lg"
          data-testid="k8s-namespace-menu"
        >
          {many && (
            <input
              autoFocus
              aria-label={t('Find namespace')}
              placeholder={t('Find namespace…')}
              className="mb-1 h-7 w-full rounded border border-line bg-subtle px-2 text-xs text-fg outline-none"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
              }}
              onKeyDown={(e) => {
                // ↓ từ ô tìm → vào danh sách.
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  e.stopPropagation()
                  list.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
                }
              }}
            />
          )}
          <div
            ref={list}
            role="menu"
            aria-label={t('Namespaces')}
            className="max-h-72 overflow-auto"
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value.length === 0}
              data-menu-item
              className={cx(
                'block w-full rounded px-2 py-1 text-left text-xs outline-none hover:bg-hover focus-visible:bg-hover',
                value.length === 0 && 'font-medium text-accent'
              )}
              onClick={() => {
                onChange([])
                setOpen(false)
              }}
            >
              {t('All namespaces')}
            </button>
            {shown.map((ns) => (
              <label
                key={ns}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover has-[:focus-visible]:bg-hover"
              >
                <input
                  type="checkbox"
                  role="menuitemcheckbox"
                  aria-checked={value.includes(ns)}
                  data-menu-item
                  data-testid={`k8s-ns-${ns}`}
                  checked={value.includes(ns)}
                  onChange={(e) => {
                    onChange(e.target.checked ? [...value, ns] : value.filter((v) => v !== ns))
                  }}
                  onKeyDown={(e) => {
                    // Enter chọn như Space (thói quen trong menu).
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.currentTarget.click()
                    }
                  }}
                />
                <span className="truncate">{ns}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
