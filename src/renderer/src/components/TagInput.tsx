import { useId, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cx } from './ui'

/** Giới hạn khớp với schema HostInput (tag ≤ 40 ký tự, ≤ 20 tag). */
export const MAX_TAG_LENGTH = 40
export const MAX_TAGS = 20

/** Tách chuỗi gõ / dán ("prod, web db") thành tag; bỏ trùng (không phân biệt hoa thường). */
export function addTags(current: readonly string[], text: string): string[] {
  const next = [...current]
  const seen = new Set(current.map((x) => x.toLowerCase()))
  for (const raw of text.split(/[,\n]/)) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH)
    if (!tag || seen.has(tag.toLowerCase()) || next.length >= MAX_TAGS) continue
    seen.add(tag.toLowerCase())
    next.push(tag)
  }
  return next
}

/**
 * Ô nhập tag dạng chip: Enter / dấu phẩy để thêm, Backspace (ô trống) xoá tag cuối, gợi ý từ các tag
 * đã dùng (↑/↓ chọn, Enter thêm). Dán "a, b, c" → ba tag.
 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  testId
}: {
  value: readonly string[]
  onChange: (tags: string[]) => void
  suggestions?: readonly string[]
  placeholder?: string
  testId?: string
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [cursor, setCursor] = useState(0)
  /** Đã dùng ↑/↓ trong gợi ý (Enter thêm mục đang chọn thay vì chữ đang gõ). */
  const [browsing, setBrowsing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const matches = useMemo(() => {
    const have = new Set(value.map((x) => x.toLowerCase()))
    const q = text.trim().toLowerCase()
    return suggestions
      .filter((s) => !have.has(s.toLowerCase()) && (!q || s.toLowerCase().includes(q)))
      .slice(0, 8)
  }, [suggestions, value, text])
  // Gợi ý hiện khi đang gõ hoặc bấm ↓ — không bật ra mỗi lần Tab qua ô.
  const open =
    focused && (browsing || text.trim() !== '') && matches.length > 0 && value.length < MAX_TAGS

  const commit = (raw: string): void => {
    const next = addTags(value, raw)
    if (next.length !== value.length) onChange(next)
    setText('')
    setCursor(0)
    setBrowsing(false)
  }

  return (
    <div className="relative">
      <div
        className={cx(
          'flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-1 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong',
          focused && 'border-accent ring-3 ring-accent/20 hover:border-accent'
        )}
        data-testid={testId}
        onMouseDown={(e) => {
          // Bấm vào chỗ trống trong khung → focus ô gõ (không mất focus đang có).
          if (e.target === e.currentTarget) {
            e.preventDefault()
            inputRef.current?.focus()
          }
        }}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex h-6 max-w-full items-center gap-0.5 rounded bg-subtle pr-0.5 pl-2 text-xs text-fg"
            data-testid="tag-chip"
          >
            <span className="truncate">{tag}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('Remove tag {tag}', { tag })}
              title={t('Remove tag {tag}', { tag })}
              className="flex size-5 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
              onClick={() => {
                onChange(value.filter((x) => x !== tag))
                inputRef.current?.focus()
              }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={t('Add tag')}
          // Có chữ / gợi ý đang mở: Esc thuộc về ô này (hộp thoại không đóng).
          data-capture-keys={text || open ? 'true' : undefined}
          spellCheck={false}
          maxLength={MAX_TAG_LENGTH * 4}
          data-testid={testId ? `${testId}-input` : undefined}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="h-6 min-w-[6rem] flex-1 bg-transparent px-1 text-[13px] text-fg outline-none placeholder:text-faint"
          value={text}
          onFocus={() => {
            setFocused(true)
          }}
          onBlur={() => {
            setFocused(false)
            setBrowsing(false)
            // Rời ô mà còn chữ → thành tag (không mất chữ người dùng đã gõ).
            if (text.trim()) commit(text)
          }}
          onChange={(e) => {
            const v = e.target.value
            if (v.includes(',')) commit(v)
            else {
              setText(v)
              setCursor(0)
              setBrowsing(false)
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (!/[,\n]/.test(pasted)) return
            e.preventDefault()
            commit(text + pasted)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Đang gõ / chọn tag: Enter thêm tag (không gửi form); ô trống thì Enter lưu form.
              const picked = open && browsing ? matches[cursor] : undefined
              if (picked !== undefined) {
                e.preventDefault()
                commit(picked)
              } else if (text.trim()) {
                e.preventDefault()
                commit(text)
              }
            } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
              e.preventDefault()
              onChange(value.slice(0, -1))
            } else if (e.key === 'ArrowDown' && matches.length > 0) {
              e.preventDefault()
              if (!browsing) {
                setBrowsing(true)
                setCursor(0)
              } else setCursor((c) => Math.min(c + 1, matches.length - 1))
            } else if (e.key === 'ArrowUp' && open) {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (e.key === 'Escape' && (text || open)) {
              // Esc đóng gợi ý / xoá chữ đang gõ trước, không đóng cả hộp thoại.
              e.preventDefault()
              e.stopPropagation()
              setText('')
              setBrowsing(false)
            }
          }}
        />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('Existing tags')}
          className="shadow-elevated absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-auto rounded-md border border-line bg-elevated p-1"
        >
          {matches.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={browsing && i === cursor}
              className={cx(
                'flex h-7 cursor-default items-center rounded px-2 text-[13px] text-fg',
                browsing && i === cursor ? 'bg-accent-soft' : 'hover:bg-hover'
              )}
              onMouseDown={(e) => {
                // Không để ô gõ mất focus (onBlur sẽ biến chữ đang gõ thành tag).
                e.preventDefault()
                commit(s)
              }}
              onMouseEnter={() => {
                setCursor(i)
                setBrowsing(true)
              }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
