import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { t, toast } from '../../registry/renderer-kit'
import type { K8sOp, PortForwardInfo } from '../shared/ops'
import type { EventBus } from './useResourceList'

type Request = <T>(op: K8sOp) => Promise<T>

/**
 * Danh sách port-forward của phiên. Tự nghe sự kiện 'forwards' (mỗi kết nối mở / đóng một lần) —
 * chỉ khung này vẽ lại, không cả tab cluster; tab chỉ nhận số lượng (`onCount`) cho nút trên thanh.
 */
export function ForwardsPanel({
  bus,
  request,
  open,
  onCount
}: {
  bus: EventBus
  request: Request
  open: boolean
  onCount: (n: number) => void
}): React.JSX.Element | null {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([])
  useEffect(() => {
    const listener = (event: string, data: unknown): void => {
      if (event !== 'forwards') return
      const list = data as PortForwardInfo[]
      setForwards(list)
      onCount(list.length)
    }
    bus.add(listener)
    return () => {
      bus.delete(listener)
    }
  }, [bus, onCount])
  if (!open) return null
  return (
    <div
      className="max-h-44 shrink-0 overflow-auto border-t border-line p-2 text-xs"
      data-testid="k8s-forwards"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">
          {t('Port forwards')}
        </span>
        <div className="flex-1" />
        {forwards.length > 1 && (
          <button
            type="button"
            className="text-[11px] text-faint hover:text-danger"
            data-testid="k8s-forwards-stop-all"
            onClick={() => {
              for (const f of forwards) void request({ op: 'portForward.stop', id: f.id })
            }}
          >
            {t('Stop all')}
          </button>
        )}
      </div>
      {forwards.length === 0 ? (
        <p className="text-faint">{t('None. Select a pod or service and press f.')}</p>
      ) : (
        forwards.map((f) => (
          <div
            key={f.id}
            className="flex h-7 items-center gap-2 rounded px-1 hover:bg-hover"
            data-testid="k8s-forward"
            data-state={f.state}
          >
            <span
              className={cx(
                'size-2 shrink-0 rounded-full',
                f.state === 'active'
                  ? 'bg-success'
                  : f.state === 'error'
                    ? 'bg-danger-solid'
                    : 'bg-line-strong'
              )}
              title={
                f.state === 'active'
                  ? t('Listening')
                  : f.state === 'paused'
                    ? t('Paused')
                    : (f.error ?? t('Error'))
              }
            />
            <button
              type="button"
              title={t('Copy address')}
              className={cx(
                'font-mono hover:text-accent',
                f.state === 'paused' ? 'text-faint line-through' : 'text-fg'
              )}
              onClick={() => void window.shellhouse.writeClipboard(`localhost:${f.localPort}`)}
            >
              localhost:{f.localPort}
            </button>
            <span className="text-faint">→</span>
            <span
              className="min-w-0 truncate text-muted"
              title={t('via pod {pod}', { pod: f.pod })}
            >
              {f.namespace}/{f.target}:{f.remotePort}
              {f.target.startsWith('service/') && <span className="text-faint"> · {f.pod}</span>}
            </span>
            {f.state === 'error' && f.error ? (
              <span className="min-w-0 truncate text-danger" title={f.error}>
                {f.error}
              </span>
            ) : (
              <span className="shrink-0 text-faint tabular-nums" data-testid="k8s-forward-stats">
                {t('{n} open', { n: f.connections })}
                {f.latencyMs !== null ? ` · ${f.latencyMs} ms` : ''}
                {f.reconnects ? ` · ${t('moved {n}×', { n: f.reconnects })}` : ''}
              </span>
            )}
            <div className="flex-1" />
            <button
              type="button"
              role="switch"
              aria-checked={f.state !== 'paused'}
              title={f.state === 'paused' ? t('Turn on') : t('Turn off (keep it in the list)')}
              data-testid="k8s-forward-toggle"
              className={cx(
                'relative h-4 w-7 shrink-0 rounded-full transition-colors',
                f.state === 'paused' ? 'bg-line-strong' : 'bg-accent-solid'
              )}
              onClick={() =>
                void request({
                  op: f.state === 'paused' ? 'portForward.resume' : 'portForward.pause',
                  id: f.id
                }).catch((e: unknown) => {
                  toast.error(t('Could not turn the port forward on'), {
                    description: cleanError(e)
                  })
                })
              }
            >
              <span
                className={cx(
                  'absolute top-0.5 size-3 rounded-full bg-white shadow transition-[left]',
                  f.state === 'paused' ? 'left-0.5' : 'left-3.5'
                )}
              />
            </button>
            <button
              type="button"
              title={t('Stop and remove')}
              className="text-faint hover:text-danger"
              onClick={() => void request({ op: 'portForward.stop', id: f.id })}
            >
              <X size={13} />
            </button>
          </div>
        ))
      )}
    </div>
  )
}
