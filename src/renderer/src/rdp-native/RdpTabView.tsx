import { lazy, Suspense } from 'react'
import { RdpView } from '../lazy'
import { useTabEngine } from './engine'

/** View native chỉ nạp khi dùng tới (Windows). */
const RdpNativeView = lazy(() =>
  import('./RdpNativeView').then((m) => ({ default: m.RdpNativeView }))
)

const loading = <div className="h-full bg-terminal" data-testid="rdp-view-loading" />

/**
 * Tab Remote Desktop: chọn engine — control RDP gốc của Windows (mstscax, như mstsc) hoặc trình xem
 * tích hợp IronRDP (macOS / Linux, hoặc host chọn "Built-in", hoặc người dùng bấm "Open in IronRDP").
 */
export function RdpTabView(props: {
  tabId: string
  hostId: string
  active: boolean
  visible: boolean
}): React.JSX.Element {
  const engine = useTabEngine(props.tabId, props.hostId)
  if (engine === null) return loading
  if (engine === 'native')
    return (
      <Suspense fallback={loading}>
        <RdpNativeView {...props} />
      </Suspense>
    )
  return <RdpView {...props} />
}
