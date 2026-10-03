import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from './ui'

/** Tên vùng đã dịch (nhãn lạ → giữ nguyên). */
function areaName(label: string): string {
  switch (label) {
    case 'tab':
      return t('tab')
    case 'tab bar':
      return t('tab bar')
    case 'sidebar':
      return t('sidebar')
    case 'window':
      return t('window')
    case 'module':
      return t('module')
    default:
      return label
  }
}

/**
 * Chặn lỗi render trong một vùng (tab, panel module, cả app): lỗi của một tab không gỡ cả cây React
 * — nếu không, mọi terminal bị dispose và mất hết phiên. "Reload" mount lại phần bên trong.
 */
interface Props {
  children: ReactNode
  /** Tên vùng cho log / thông báo ("tab", "app"…). */
  label?: string
  /** Đổi giá trị → tự xoá lỗi (vd. tab chuyển sang đích khác). */
  resetKey?: unknown
  /** Giao diện gọn (thanh bên / panel nhỏ). */
  compact?: boolean
}

interface State {
  error: Error | null
  /** Tăng mỗi lần "Reload" → con được mount lại từ đầu. */
  attempt: number
  resetKey: unknown
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, attempt: 0, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null }
    return null
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Không có logger phía renderer: DevTools / log của Electron giữ lại lỗi này.
    // eslint-disable-next-line no-console
    console.error(`[shellhouse] ${this.props.label ?? 'view'} crashed`, error, info.componentStack)
  }

  private readonly reload = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
  }

  override render(): ReactNode {
    const { error, attempt } = this.state
    // key = attempt: "Reload" mount lại phần bên trong từ đầu.
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>
    const what = areaName(this.props.label ?? 'tab')
    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className={
          this.props.compact
            ? 'flex flex-col gap-2 p-3 text-xs'
            : 'flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto p-6 text-center'
        }
      >
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <AlertTriangle size={16} className="shrink-0 text-warning" />
          {t('This {what} hit an error', { what })}
        </div>
        <Button size="sm" icon={<RotateCw size={13} />} onClick={this.reload}>
          {t('Reload {what}', { what })}
        </Button>
        <details className="sh-selectable max-w-full text-left text-xs text-muted">
          <summary className="cursor-pointer select-none">{t('Error details')}</summary>
          <pre className="mt-2 max-h-60 max-w-[min(48rem,100%)] overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap">
            {error.stack ?? error.message}
          </pre>
        </details>
      </div>
    )
  }
}
