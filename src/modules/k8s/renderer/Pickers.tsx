import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronsUpDown, Hash } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { EnvLabel, type EnvLike } from '../../../renderer/src/ds'
import { t, tn } from '../../registry/renderer-kit'

/**
 * Menu thả xuống của thanh công cụ cluster. Portal ra gốc trang K8s (`k8s-view`, không có thì
 * `<body>`), z-50: luôn nằm trên thanh công cụ của Map / bảng chi tiết (z-30 / z-40 — trước đây
 * menu bị đè, mục đầu bị che) và không bị khung cha cắt. Vị trí bám nút mở, kẹp trong trang.
 *
 * Đóng khi: bấm ra ngoài (pointerdown pha capture trên window — bản đồ React Flow chặn lan truyền
 * mousedown nên nghe ở document không đủ), Esc (không phụ thuộc focus), đổi kích thước cửa sổ.
 */
function DropMenu({
  anchor,
  onClose,
  className,
  testId,
  menuRef,
  role,
  label,
  children
}: {
  /** Khối chứa nút mở — bấm vào đây không tính là "bấm ra ngoài" (nút tự bật / tắt). */
  anchor: React.RefObject<HTMLElement | null>
  onClose: (refocus: boolean) => void
  className: string
  testId: string
  menuRef?: React.RefObject<HTMLDivElement | null>
  role?: 'menu'
  label?: string
  children: React.ReactNode
}): React.JSX.Element {
  const own = useRef<HTMLDivElement>(null)
  // Gốc trang K8s (menu vẫn nằm trong `k8s-view` → locator / phím của trang vẫn thấy menu). Menu
  // chỉ gắn sau khi bấm nút mở → nút đã có trong DOM.
  const [host] = useState<HTMLElement>(
    () => anchor.current?.closest<HTMLElement>('[data-testid="k8s-view"]') ?? document.body
  )
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  // Đo ngay khi gắn (trước lần vẽ đầu) — bám nút mở, kẹp trong khung chứa.
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect()
    const m = own.current
    if (!a || !m) return
    const box =
      host === document.body
        ? {
            left: 0,
            top: 0,
            width: document.documentElement.clientWidth,
            height: window.innerHeight
          }
        : host.getBoundingClientRect()
    const top = Math.round(a.bottom + 4 - box.top)
    setPos({
      left: Math.round(Math.max(8, Math.min(a.left - box.left, box.width - m.offsetWidth - 8))),
      top,
      maxHeight: Math.max(120, box.height - top - 8)
    })
  }, [anchor, host])
  useEffect(() => {
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (!!own.current?.contains(target) || !!anchor.current?.contains(target))
    const onDown = (e: PointerEvent | MouseEvent): void => {
      if (!inside(e.target)) latest.current(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      latest.current(inside(document.activeElement))
    }
    const onResize = (): void => {
      latest.current(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor])
  return createPortal(
    <div
      ref={(el) => {
        own.current = el
        if (menuRef) menuRef.current = el
      }}
      role={role}
      aria-label={label}
      data-testid={testId}
      className={cx(
        'z-50 flex flex-col rounded-md bg-ds-popover p-1 shadow-ds-popover',
        host === document.body ? 'fixed' : 'absolute',
        className
      )}
      // Lần vẽ đầu chưa đo xong → ẩn (tránh nháy ở góc trái trên).
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    host
  )
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
  version,
  contexts,
  onPick
}: {
  current: string
  label: string
  version: string | undefined
  /** `env`: môi trường của context (nhãn trong danh sách). */
  contexts: { key: string; name: string; source: string; env?: EnvLike | undefined }[]
  onPick: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }, [])
  // Mở → focus mục đang dùng (dùng phím ngay).
  useEffect(() => {
    if (!open) return
    const el =
      list.current?.querySelector<HTMLElement>('[data-menu-item][aria-checked="true"]') ??
      list.current?.querySelector<HTMLElement>('[data-menu-item]')
    el?.focus()
  }, [open])
  return (
    <div
      className="relative"
      ref={box}
      onKeyDown={(e) => {
        if (open)
          menuKeyDown(e, list.current, () => {
            close(true)
          })
      }}
    >
      <button
        ref={button}
        type="button"
        data-testid="k8s-context-picker"
        aria-haspopup="menu"
        aria-expanded={open}
        // Crumb có bộ chuyển (⇅) trong đường dẫn của header (thiết kế v0.5).
        className="flex h-6.5 max-w-56 items-center gap-1.5 rounded-ds-sm px-1.5 text-muted outline-none hover:bg-ds-hover hover:text-fg focus-visible:shadow-ds-focus aria-expanded:bg-ds-active"
        title={version ? `${label} · ${version}` : label}
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
        <span className="truncate text-[13px] font-medium" data-testid="k8s-context-label">
          {label}
        </span>
        <ChevronsUpDown size={13} strokeWidth={1.5} className="shrink-0 text-faint" aria-hidden />
      </button>
      {open && (
        <DropMenu
          anchor={box}
          onClose={close}
          menuRef={list}
          role="menu"
          label={t('Contexts')}
          className="w-72 overflow-auto"
          testId="k8s-context-menu"
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
                'flex w-full items-center gap-2 rounded-ds-md px-2 py-1.5 text-left text-xs outline-none hover:bg-ds-active focus-visible:bg-ds-active',
                c.key === current && 'bg-ds-selected'
              )}
              onClick={() => {
                setOpen(false)
                if (c.key !== current) onPick(c.key)
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg">{c.name}</span>
                <span className="block truncate text-faint">{c.source}</span>
              </span>
              {c.env && <EnvLabel env={c.env} />}
            </button>
          ))}
        </DropMenu>
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
  const box = useRef<HTMLDivElement>(null)
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }, [])
  const many = all.length > 8
  // Mở (không có ô tìm) → focus mục đầu.
  useEffect(() => {
    if (!open || many) return
    list.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
  }, [open, many])
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
        if (open)
          menuKeyDown(e, list.current, () => {
            close(true)
          })
      }}
    >
      <button
        ref={button}
        type="button"
        data-testid="k8s-namespace"
        aria-haspopup="menu"
        aria-expanded={open}
        // Chip phạm vi (Namespaces) trong header.
        className="flex h-6.5 max-w-56 items-center gap-1.5 rounded-ds-md border border-ds-border px-2 text-[13px] text-fg outline-none hover:border-ds-border-strong focus-visible:shadow-ds-focus aria-expanded:bg-ds-active"
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
        <Hash size={13} strokeWidth={1.5} className="shrink-0 text-faint" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDown size={13} strokeWidth={1.5} className="shrink-0 text-faint" aria-hidden />
      </button>
      {open && (
        <DropMenu anchor={box} onClose={close} className="w-60" testId="k8s-namespace-menu">
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
            className="max-h-72 min-h-0 overflow-auto"
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
        </DropMenu>
      )}
    </div>
  )
}
