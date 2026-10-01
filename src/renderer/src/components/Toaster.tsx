import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Info,
  Loader2,
  X,
  XCircle
} from 'lucide-react'
import { cx } from './ui'
import { dismiss, hold, useToasts, type Toast, type ToastTone } from '../stores/toasts'

const ICON: Record<ToastTone, React.JSX.Element> = {
  success: <CheckCircle2 size={16} className="text-success" />,
  error: <XCircle size={16} className="text-danger" />,
  warning: <AlertTriangle size={16} className="text-warning" />,
  info: <Info size={16} className="text-accent" />,
  loading: <Loader2 size={16} className="animate-spin text-accent" />
}

const BAR: Record<ToastTone, string> = {
  success: 'bg-success',
  error: 'bg-danger-solid',
  warning: 'bg-warning',
  info: 'bg-accent-solid',
  loading: 'bg-accent-solid'
}

/** Ngăn xếp toast góc dưới phải (trên mọi màn hình). */
export function Toaster(): React.JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-10 z-[60] flex w-[22rem] flex-col gap-2"
      aria-live="polite"
      data-testid="toaster"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastCard({ toast }: { toast: Toast }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const long =
    toast.details ??
    (toast.description && toast.description.length > 140 ? toast.description : undefined)
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-testid="toast"
      data-tone={toast.tone}
      className="pointer-events-auto relative flex animate-fade-in gap-2.5 overflow-hidden rounded-lg border border-line bg-elevated py-2.5 pr-2 pl-3.5 text-xs shadow-lg"
      onMouseEnter={() => {
        hold(toast.id, true)
      }}
      onMouseLeave={() => {
        hold(toast.id, false)
      }}
    >
      <span className={cx('absolute inset-y-0 left-0 w-1', BAR[toast.tone])} />
      <span className="mt-px shrink-0">{ICON[toast.tone]}</span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-fg" data-testid="toast-title">
          {toast.title}
        </div>
        {toast.description && (
          <div
            className={cx('mt-0.5 break-words text-muted', !open && 'line-clamp-3')}
            data-testid="toast-description"
          >
            {toast.description}
          </div>
        )}
        {open && toast.details && (
          <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-subtle p-1.5 font-mono text-[10.5px] whitespace-pre-wrap text-muted select-text">
            {toast.details}
          </pre>
        )}
        {(toast.action || long) && (
          <div className="mt-1.5 flex items-center gap-3">
            {toast.action && (
              <button
                type="button"
                data-testid="toast-action"
                className="font-medium text-accent hover:underline"
                onClick={() => {
                  toast.action?.run()
                  dismiss(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
            {long && (
              <button
                type="button"
                className="flex items-center gap-0.5 text-faint hover:text-fg"
                onClick={() => {
                  setOpen((o) => !o)
                }}
              >
                <ChevronDown
                  size={12}
                  className={cx('transition-transform', open && 'rotate-180')}
                />
                {open ? 'Less' : 'Details'}
              </button>
            )}
            {toast.tone === 'error' && (
              <button
                type="button"
                className="flex items-center gap-1 text-faint hover:text-fg"
                onClick={() => {
                  void window.shellhouse
                    .writeClipboard(
                      [toast.title, toast.description, toast.details].filter(Boolean).join('\n')
                    )
                    .then(() => {
                      setCopied(true)
                    })
                }}
              >
                <Copy size={11} /> {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="h-5 shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
        onClick={() => {
          dismiss(toast.id)
        }}
      >
        <X size={13} />
      </button>
    </div>
  )
}
