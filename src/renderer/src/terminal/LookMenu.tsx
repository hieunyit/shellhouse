import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Minus, Plus, Type } from 'lucide-react'
import { BUILTIN_THEMES } from '@shared/themes'
import { cx } from '../components/ui'
import { useSettings } from '../stores/settings'

/** Font monospace hay gặp; chỉ những font có trên máy mới chọn được. */
const FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Cascadia Mono',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'Source Code Pro',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Hack',
  'IBM Plex Mono',
  'Roboto Mono',
  'Courier New'
]

/** Font có cài không: chữ đo bằng font đó khác chữ đo bằng font dự phòng. */
function installed(name: string): boolean {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return true
  const sample = 'mmmmmmmmmmlli10OO@#'
  const width = (font: string): number => {
    ctx.font = `20px ${font}`
    return ctx.measureText(sample).width
  }
  return ['monospace', 'serif'].some((base) => width(`"${name}", ${base}`) !== width(base))
}

/**
 * Bảng chỉnh nhanh trên thanh phiên: theme màu, font và cỡ chữ của terminal (lưu vào cài đặt —
 * áp dụng cho mọi terminal ngay).
 */
export function LookMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** Vị trí bảng (theo nút) — vẽ qua portal vì thanh phiên cắt phần tràn (overflow-hidden). */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const t = useSettings((s) => s.settings.terminal)
  const custom = useSettings((s) => s.settings.customThemes)
  const update = useSettings((s) => s.update)
  const fonts = useMemo(
    () => (open ? FONTS.filter((f) => f === 'JetBrains Mono' || installed(f)) : []),
    [open]
  )
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const themes = [...BUILTIN_THEMES, ...custom]
  const font = t.fontFamily || 'JetBrains Mono'
  const size = (delta: number): void => {
    void update({ terminal: { fontSize: Math.max(8, Math.min(32, t.fontSize + delta)) } })
  }
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title="Terminal look: theme, font and size"
        aria-label="Terminal look"
        aria-expanded={open}
        data-testid="terminal-look"
        className={cx(
          'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium',
          open ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg'
        )}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor({ top: r.bottom + 6, right: window.innerWidth - r.right })
          setOpen((o) => !o)
        }}
      >
        <Type size={13} />
        <span className="hidden tabular-nums @md:inline">{t.fontSize}</span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={panel}
            className="fixed z-50 flex w-80 flex-col gap-3 rounded-lg border border-line bg-elevated p-3 text-xs shadow-lg"
            style={{ top: anchor.top, right: anchor.right }}
            data-testid="terminal-look-menu"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium text-fg">Text size</span>
              <button
                type="button"
                aria-label="Smaller text"
                className="rounded-md border border-line p-1 hover:bg-hover"
                onClick={() => {
                  size(-1)
                }}
              >
                <Minus size={12} />
              </button>
              <span
                className="w-8 text-center font-mono tabular-nums"
                data-testid="terminal-look-size"
              >
                {t.fontSize}
              </span>
              <button
                type="button"
                aria-label="Bigger text"
                data-testid="terminal-look-bigger"
                className="rounded-md border border-line p-1 hover:bg-hover"
                onClick={() => {
                  size(1)
                }}
              >
                <Plus size={12} />
              </button>
            </div>
            <div>
              <div className="mb-1 font-medium text-fg">Font</div>
              <div className="grid max-h-36 grid-cols-2 gap-1 overflow-auto">
                {fonts.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={cx(
                      'flex items-center gap-1 truncate rounded-md border px-2 py-1 text-left',
                      font === f
                        ? 'border-accent bg-accent-soft text-fg'
                        : 'border-line hover:bg-hover'
                    )}
                    style={{ fontFamily: `"${f}", monospace` }}
                    data-testid="terminal-look-font"
                    data-font={f}
                    onClick={() =>
                      void update({ terminal: { fontFamily: f === 'JetBrains Mono' ? '' : f } })
                    }
                  >
                    {font === f && <Check size={11} className="shrink-0 text-accent" />}
                    <span className="truncate">{f}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 font-medium text-fg">Color theme</div>
              <div className="grid max-h-48 grid-cols-2 gap-1 overflow-auto">
                {[{ id: 'system', name: 'Match app', colors: null } as const, ...themes].map(
                  (th) => (
                    <button
                      key={th.id}
                      type="button"
                      className={cx(
                        'flex items-center gap-2 rounded-md border px-2 py-1 text-left',
                        t.themeId === th.id
                          ? 'border-accent bg-accent-soft'
                          : 'border-line hover:bg-hover'
                      )}
                      data-testid="terminal-look-theme"
                      data-theme={th.id}
                      onClick={() => void update({ terminal: { themeId: th.id } })}
                    >
                      {th.colors ? (
                        <span
                          className="flex h-4 w-6 shrink-0 items-center justify-center gap-px rounded-sm border border-line"
                          style={{ background: th.colors.background }}
                        >
                          {[th.colors.red, th.colors.green, th.colors.blue].map((c) => (
                            <span
                              key={c}
                              className="size-1 rounded-full"
                              style={{ background: c }}
                            />
                          ))}
                        </span>
                      ) : (
                        <span className="h-4 w-6 shrink-0 rounded-sm border border-line bg-gradient-to-r from-white to-zinc-900" />
                      )}
                      <span className="truncate text-fg">{th.name}</span>
                    </button>
                  )
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
