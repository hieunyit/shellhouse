import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from 'lucide-react'
import type { ISearchOptions } from '@xterm/addon-search'
import { t } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import { cx } from '../components/ui'
import { useTerminalFind } from '../stores/terminal-find'
import { controllers } from './registry'

/** Màu tô kết quả (vàng nhạt / cam cho kết quả đang chọn) — đọc được trên mọi theme terminal. */
const DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#f5d04a66',
  matchBorder: '#e0b20055',
  matchOverviewRuler: '#e0b200',
  activeMatchBackground: '#ff8a1fcc',
  activeMatchBorder: '#ff6a00',
  activeMatchColorOverviewRuler: '#ff6a00'
}

function Toggle({
  on,
  label,
  onClick,
  children
}: {
  on: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={cx(
        'flex size-6 items-center justify-center rounded',
        on ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * Tìm trong terminal (cả phần đã cuộn): tô mọi kết quả, đếm "3 of 12", phân biệt hoa thường /
 * nguyên từ / regex; Enter = kết quả sau, Shift+Enter = trước, Esc = đóng.
 */
export function FindBar({ tabId }: { tabId: string }): React.JSX.Element | null {
  const open = useTerminalFind((s) => s.tabId === tabId)
  const seq = useTerminalFind((s) => s.seq)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [wholeWord, setWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const search = controllers.get(tabId)?.search

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open, seq])

  useEffect(() => {
    if (!search) return
    const d = search.onDidChangeResults((r) => {
      setResult({ index: r.resultIndex, count: r.resultCount })
    })
    return () => {
      d.dispose()
    }
  }, [search])

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive,
    wholeWord,
    regex,
    incremental,
    decorations: DECORATIONS
  })

  // Gõ / đổi tuỳ chọn → tìm lại từ vị trí hiện tại.
  useEffect(() => {
    if (!open || !search) return
    if (!query) {
      search.clearDecorations()
      return
    }
    try {
      search.findNext(query, {
        caseSensitive,
        wholeWord,
        regex,
        incremental: true,
        decorations: DECORATIONS
      })
    } catch {
      // Regex dở dang — đợi gõ tiếp.
    }
  }, [open, search, query, caseSensitive, wholeWord, regex])

  if (!open) return null
  const close = (): void => {
    search?.clearDecorations()
    useTerminalFind.getState().close()
    controllers.get(tabId)?.term.focus()
  }
  const next = (back: boolean): void => {
    if (!search || !query) return
    if (back) search.findPrevious(query, options(false))
    else search.findNext(query, options(false))
  }
  const none = query !== '' && result !== null && result.count === 0

  return (
    <div
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-line bg-elevated p-1 shadow-lg"
      data-testid="terminal-find"
      role="search"
      aria-label={t('Find in terminal')}
      onMouseDown={(e) => {
        e.stopPropagation()
      }}
      onKeyDown={(e) => {
        // Esc khi focus đang ở nút tuỳ chọn (không phải ô nhập) cũng đóng thanh tìm.
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        }
      }}
    >
      <input
        ref={input}
        value={query}
        placeholder={t('Find')}
        aria-label={t('Find in terminal')}
        data-testid="terminal-find-input"
        className={cx(
          'h-7 w-56 rounded-md border bg-surface px-2 font-mono text-xs text-fg outline-none',
          none ? 'border-danger' : 'border-line focus:border-accent'
        )}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            next(e.shiftKey)
          }
        }}
      />
      <span
        className={cx(
          'w-16 text-center text-[11px] tabular-nums',
          none ? 'text-danger' : 'text-faint'
        )}
        data-testid="terminal-find-count"
        aria-live="polite"
      >
        {!query || !result
          ? ''
          : result.count === 0
            ? t('No results')
            : result.index < 0
              ? t('{n} found', { n: formatNumber(result.count) })
              : t('{index} of {count}', {
                  index: formatNumber(result.index + 1),
                  count: formatNumber(result.count)
                })}
      </span>
      <Toggle
        on={caseSensitive}
        label={t('Match case')}
        onClick={() => {
          setCase((v) => !v)
        }}
      >
        <CaseSensitive size={15} />
      </Toggle>
      <Toggle
        on={wholeWord}
        label={t('Whole word')}
        onClick={() => {
          setWord((v) => !v)
        }}
      >
        <WholeWord size={15} />
      </Toggle>
      <Toggle
        on={regex}
        label={t('Regular expression')}
        onClick={() => {
          setRegex((v) => !v)
        }}
      >
        <Regex size={14} />
      </Toggle>
      <span className="mx-0.5 h-4 w-px bg-line" />
      <Toggle
        on={false}
        label={t('Previous (Shift+Enter)')}
        onClick={() => {
          next(true)
        }}
      >
        <ArrowUp size={14} />
      </Toggle>
      <Toggle
        on={false}
        label={t('Next (Enter)')}
        onClick={() => {
          next(false)
        }}
      >
        <ArrowDown size={14} />
      </Toggle>
      <Toggle on={false} label={t('Close (Esc)')} onClick={close}>
        <X size={14} />
      </Toggle>
    </div>
  )
}
