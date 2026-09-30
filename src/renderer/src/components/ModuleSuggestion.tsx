import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { manifestOf } from '../../../modules/registry/manifests'
import { ModuleIcon } from '../../../modules/registry/renderer-kit'
import { markSuggested, neverSuggest, requestEnableModule, suggestable } from '../stores/module-ui'
import { cx } from './ui'

/**
 * Một dòng gợi ý bật module (ADR-014 mục 3.12.4) — không popup: "Docker detected on web-01 —
 * Enable Docker module · Enable · Not now · Don't suggest again".
 */
export function ModuleSuggestion({
  candidates,
  where,
  className
}: {
  /** Module có dấu hiệu (chưa lọc theo luật gợi ý). */
  candidates: readonly string[]
  /** "on web-01" / "on this computer". */
  where: string
  className?: string
}): React.JSX.Element | null {
  // Chốt danh sách lúc có dấu hiệu mới (không đổi khi cài đặt đổi vì chính dòng này ghi suggestedAt).
  const [shown, setShown] = useState<string | null>(null)
  const key = candidates.join(',')
  useEffect(() => {
    const first = suggestable(candidates)[0] ?? null
    if (!first) return
    markSuggested(first)
    // Hiện sau khi ghi lại — tránh hiện đi hiện lại khi render lại.
    const t = setTimeout(() => {
      setShown(first)
    }, 0)
    return () => {
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ khi tập dấu hiệu đổi
  }, [key])
  const manifest = shown ? manifestOf(shown) : undefined
  if (!shown || !manifest) return null
  const close = (): void => {
    setShown(null)
  }
  return (
    <div
      className={cx(
        'flex h-8 shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-3 text-xs text-fg',
        className
      )}
      data-testid="module-suggestion"
      data-module={shown}
    >
      <ModuleIcon name={manifest.icon} size={13} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">
        {manifest.name} detected {where} — enable the {manifest.name} module?
      </span>
      <button
        type="button"
        data-testid="module-suggestion-enable"
        className="font-medium text-accent hover:underline"
        onClick={() => {
          close()
          void requestEnableModule(shown)
        }}
      >
        Enable
      </button>
      <span className="text-faint">·</span>
      <button type="button" className="text-muted hover:text-fg" onClick={close}>
        Not now
      </button>
      <span className="text-faint">·</span>
      <button
        type="button"
        data-testid="module-suggestion-never"
        className="text-muted hover:text-fg"
        onClick={() => {
          close()
          neverSuggest(shown)
        }}
      >
        Don’t suggest again
      </button>
      <button type="button" aria-label="Close" className="text-faint hover:text-fg" onClick={close}>
        <X size={13} />
      </button>
    </div>
  )
}
