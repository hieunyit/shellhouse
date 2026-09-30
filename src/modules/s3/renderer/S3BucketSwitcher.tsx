import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Database, LayoutList, Search } from 'lucide-react'
import type { S3Bucket } from '../shared/ops'
import { cx } from '../../../renderer/src/components/ui'
import { collator } from './parts'

/**
 * Tên bucket trên thanh đường dẫn: bấm tên = về gốc bucket, bấm ▾ = danh sách để nhảy sang bucket
 * khác (gõ để lọc, ↑↓ Enter) mà không phải quay ra bảng bucket.
 */
export function S3BucketSwitcher({
  buckets,
  current,
  onRoot,
  onPick,
  onAll
}: {
  buckets: S3Bucket[]
  current: string
  onRoot: () => void
  onPick: (bucket: string) => void
  onAll: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return buckets
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [buckets, query])

  // Bấm ra ngoài → đóng.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const pick = (name: string): void => {
    setOpen(false)
    onPick(name)
  }

  return (
    <div ref={boxRef} className="relative flex min-w-0 shrink items-center">
      <div
        className={cx(
          'flex min-w-0 items-stretch rounded-md border border-line bg-surface',
          open && 'border-accent ring-2 ring-accent/20'
        )}
      >
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-l-md py-0.5 pr-1 pl-2 font-medium text-fg hover:bg-hover"
          data-testid="s3-crumb-bucket"
          title={`Go to the top of ${current}`}
          onClick={onRoot}
        >
          <Database size={13} className="shrink-0 text-accent" />
          <span className="truncate">{current}</span>
        </button>
        <button
          type="button"
          aria-label="Switch bucket"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Switch bucket"
          data-testid="s3-bucket-switch"
          className="flex items-center rounded-r-md border-l border-line px-1 text-muted hover:bg-hover hover:text-fg"
          onClick={() => {
            setQuery('')
            setIndex(
              Math.max(
                0,
                buckets.findIndex((b) => b.name === current)
              )
            )
            setOpen(!open)
          }}
        >
          <ChevronDown size={13} />
        </button>
      </div>
      {open && (
        <div
          className="absolute top-full left-0 z-40 mt-1.5 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg"
          data-testid="s3-bucket-menu"
        >
          <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-faint">Switch bucket</p>
          <label className="mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
            <Search size={12} className="shrink-0 text-faint" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
              placeholder="Type to filter…"
              aria-label="Filter buckets"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setIndex(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(false)
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowDown' ? 1 : -1
                  setIndex((i) => Math.max(0, Math.min(matches.length - 1, i + delta)))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const target = matches[index] ?? matches[0]
                  if (target) pick(target.name)
                }
              }}
            />
          </label>
          <ul role="listbox" aria-label="Buckets" className="max-h-72 overflow-auto">
            {matches.length === 0 && (
              <li className="px-2.5 py-2 text-xs text-faint">No bucket matches.</li>
            )}
            {matches.map((b, i) => (
              <li
                key={b.name}
                role="option"
                aria-selected={b.name === current}
                className={cx(
                  'flex h-8 cursor-default items-center gap-2 rounded-md px-2.5 text-[13px]',
                  i === index ? 'bg-hover text-fg' : 'text-muted'
                )}
                onMouseEnter={() => {
                  setIndex(i)
                }}
                onClick={() => {
                  pick(b.name)
                }}
              >
                <Database size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {b.name === current && <Check size={14} className="shrink-0 text-accent" />}
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setOpen(false)
                onAll()
              }}
            >
              <LayoutList size={14} className="shrink-0" />
              All buckets
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
