import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx, useEscapeToClose } from './ui'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}
export type MenuEntry = MenuItem | 'separator'

interface OpenMenu {
  x: number
  y: number
  entries: MenuEntry[]
}

/** Menu chuột phải tự vẽ (theo theme). Mở bằng `open(event, entries)`; tự đóng khi chọn / bấm ra ngoài / Esc. */
export function useContextMenu(): {
  menu: React.JSX.Element | null
  open: (
    event: { clientX: number; clientY: number; preventDefault: () => void },
    entries: MenuEntry[]
  ) => void
  close: () => void
} {
  const [state, setState] = useState<OpenMenu | null>(null)
  const close = useCallback(() => {
    setState(null)
  }, [])
  const open = useCallback(
    (
      event: { clientX: number; clientY: number; preventDefault: () => void },
      entries: MenuEntry[]
    ) => {
      event.preventDefault()
      setState({ x: event.clientX, y: event.clientY, entries })
    },
    []
  )
  return {
    menu: state ? <ContextMenu {...state} onClose={close} /> : null,
    open,
    close
  }
}

function ContextMenu({
  x,
  y,
  entries,
  onClose
}: OpenMenu & { onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const items = entries.filter((e): e is MenuItem => e !== 'separator')
  const [cursor, setCursor] = useState(() => items.findIndex((i) => !i.disabled))
  useEscapeToClose(onClose)

  // Không để menu tràn ra ngoài cửa sổ.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4))
    })
    el.focus()
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const select = (item: MenuItem | undefined): void => {
    if (!item || item.disabled) return
    onClose()
    item.onSelect()
  }
  const step = (delta: 1 | -1): void => {
    if (items.length === 0) return
    let next = cursor
    for (let i = 0; i < items.length; i++) {
      next = (next + delta + items.length) % items.length
      if (!items[next]?.disabled) break
    }
    setCursor(next)
  }

  let index = -1
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      className="shadow-elevated animate-pop-in fixed z-50 min-w-52 rounded-lg border border-line bg-elevated p-1 text-[13px] outline-none"
      style={pos}
      onContextMenu={(e) => {
        e.preventDefault()
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          step(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          step(-1)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select(items[cursor])
        }
      }}
    >
      {entries.map((entry, i) => {
        if (entry === 'separator')
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-line" />
        index++
        const current = index
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={entry.disabled}
            data-testid={`menu-${entry.id}`}
            className={cx(
              'flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-left disabled:opacity-40',
              current === cursor &&
                !entry.disabled &&
                (entry.danger ? 'bg-danger-soft' : 'bg-hover'),
              entry.danger ? 'text-danger' : 'text-fg'
            )}
            onMouseMove={() => {
              if (!entry.disabled) setCursor(current)
            }}
            onClick={() => {
              select(entry)
            }}
          >
            <span className={cx('flex w-4 justify-center', !entry.danger && 'text-muted')}>
              {entry.icon}
            </span>
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.hint && <span className="text-xs text-faint">{entry.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}
