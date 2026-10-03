import { useMemo, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { cx, Segmented } from '../../../renderer/src/components/ui'
import { t, tn } from '../../registry/renderer-kit'
import {
  diffStats,
  foldUnchanged,
  lineDiff,
  splitRows,
  type DiffChunk,
  type DiffLine
} from '../shared/diff'

/**
 * So sánh hai văn bản YAML theo dòng (xem trước thay đổi, so sánh revision Helm): một cột (unified)
 * hoặc hai cột; đoạn không đổi dài được gập (bấm để mở). Nhớ kiểu hiển thị theo máy.
 */

const MODE_KEY = 'shellhouse.k8s.diffMode'
type Mode = 'unified' | 'split'

function savedMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

const ROW = 'flex min-h-[1.5em] whitespace-pre'
const GUTTER = 'w-10 shrink-0 select-none pr-2 text-right text-faint tabular-nums'

function tone(op: DiffLine['op'] | undefined): string {
  return op === 'add'
    ? 'bg-success-soft text-fg'
    : op === 'del'
      ? 'bg-danger-soft text-fg'
      : 'text-muted'
}

function Fold({ count, onOpen }: { count: number; onOpen: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 bg-subtle px-2 py-0.5 text-left text-[11px] text-faint hover:bg-hover hover:text-fg"
      onClick={onOpen}
    >
      <ChevronsUpDown size={12} />
      {tn(count, '{n} unchanged line', '{n} unchanged lines')}
    </button>
  )
}

function UnifiedLines({ lines }: { lines: readonly DiffLine[] }): React.JSX.Element {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={cx(ROW, tone(l.op))} data-op={l.op}>
          <span className={GUTTER}>{l.a ?? ''}</span>
          <span className={GUTTER}>{l.b ?? ''}</span>
          <span className="w-4 shrink-0 select-none text-center text-faint">
            {l.op === 'add' ? '+' : l.op === 'del' ? '−' : ''}
          </span>
          <span className="pr-3">{l.text}</span>
        </div>
      ))}
    </>
  )
}

function SplitLines({ lines }: { lines: readonly DiffLine[] }): React.JSX.Element {
  return (
    <>
      {splitRows(lines).map((r, i) => (
        <div key={i} className="grid grid-cols-2">
          <div className={cx(ROW, 'border-r border-line', r.left ? tone(r.left.op) : 'bg-subtle')}>
            <span className={GUTTER}>{r.left?.a ?? ''}</span>
            <span className="pr-3">{r.left?.text ?? ''}</span>
          </div>
          <div className={cx(ROW, r.right ? tone(r.right.op) : 'bg-subtle')}>
            <span className={GUTTER}>{r.right?.b ?? ''}</span>
            <span className="pr-3">{r.right?.text ?? ''}</span>
          </div>
        </div>
      ))}
    </>
  )
}

export function DiffView({
  left,
  right,
  leftLabel,
  rightLabel,
  testId,
  className
}: {
  left: string
  right: string
  leftLabel: string
  rightLabel: string
  testId?: string
  className?: string
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(savedMode)
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  const lines = useMemo(() => lineDiff(left, right), [left, right])
  const chunks = useMemo<DiffChunk[]>(() => foldUnchanged(lines), [lines])
  const stats = diffStats(lines)
  const same = stats.added === 0 && stats.removed === 0
  const Body = mode === 'split' ? SplitLines : UnifiedLines
  return (
    <div className={cx('flex min-h-0 flex-col gap-1.5', className)} data-testid={testId}>
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-muted">
          <span className="font-mono text-danger">−</span> {leftLabel}
          <span className="mx-1.5 text-faint">→</span>
          <span className="font-mono text-success">+</span> {rightLabel}
        </span>
        <span className="ml-auto shrink-0 text-faint tabular-nums" data-testid="k8s-diff-stats">
          {same ? (
            t('No changes')
          ) : (
            <>
              <span className="text-success">+{stats.added}</span>{' '}
              <span className="text-danger">−{stats.removed}</span>
            </>
          )}
        </span>
        <Segmented<Mode>
          value={mode}
          onChange={(m) => {
            setMode(m)
            try {
              window.localStorage.setItem(MODE_KEY, m)
            } catch {
              // Không lưu được thì chỉ áp dụng lần này.
            }
          }}
          options={[
            { value: 'unified', label: t('Unified') },
            { value: 'split', label: t('Side by side') }
          ]}
          testIdPrefix="k8s-diff-mode"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-surface py-1 font-mono text-[11px] leading-relaxed select-text">
        {same ? (
          <p className="px-3 py-2 font-sans text-xs text-faint">{t('Both sides are identical.')}</p>
        ) : (
          chunks.map((c, i) =>
            c.kind === 'fold' && !opened.has(i) ? (
              <Fold
                key={i}
                count={c.count}
                onOpen={() => {
                  setOpened((s) => new Set(s).add(i))
                }}
              />
            ) : (
              <Body key={i} lines={c.lines} />
            )
          )
        )}
      </div>
    </div>
  )
}
