import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, RefreshCw } from 'lucide-react'
import { LogFeed } from '@shared/log-buffer'
import { Notice, Select } from '../../../renderer/src/components/ui'
import { ToolButton } from '../../../renderer/src/components/files/parts'
import { LogViewer } from '../../../renderer/src/components/LogViewer'
import { cleanError } from '../../../renderer/src/lib/format'
import { ConnectionPrompt, formatNumber, t } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type { DockerLogsParams, DockerOp, LogsEvent } from '../shared/ops'
import { useDockerSession } from './useDockerSession'

/** Tab log của một container. */
export function LogsTab({ tabId, params }: ModuleTabProps<DockerLogsParams>): React.JSX.Element {
  const [feed] = useState(() => new LogFeed())
  const subscription = useRef<string | null>(null)
  const [tail, setTail] = useState(500)
  const [timestamps, setTimestamps] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)

  const onEvent = useCallback(
    (event: string, data: unknown) => {
      const d = data as LogsEvent & { error?: string }
      if (d.subscription !== subscription.current) return
      if (event === 'logs') feed.push(d.text, d.stream === 'stderr')
      else if (event === 'logs-end')
        setEnded(d.error ?? t('The log stream ended (the container stopped).'))
    },
    [feed]
  )
  const session = useDockerSession(tabId, params.hostId, onEvent)
  const { ready, request } = session

  useEffect(() => {
    if (!ready) return
    let sub: string | null = null
    let cancelled = false
    // Nhiều container (Compose project) → một luồng gộp, mỗi dòng có tiền tố tên service.
    const op: DockerOp = params.containers?.length
      ? { op: 'logs.subscribeMany', containers: params.containers, tail, timestamps }
      : { op: 'logs.subscribe', id: params.container ?? '', tail, timestamps }
    request<{ subscription: string }>(op).then(
      (r) => {
        if (cancelled) {
          void request({ op: 'unsubscribe', subscription: r.subscription })
          return
        }
        sub = r.subscription
        feed.clear()
        setEnded(null)
        setError(null)
        subscription.current = r.subscription
      },
      (e: unknown) => {
        setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
      subscription.current = null
      if (sub) void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
    }
  }, [ready, request, feed, params.container, params.containers, tail, timestamps, restart])

  return (
    <div className="relative flex h-full flex-col bg-surface" data-testid="docker-logs-view">
      <LogViewer
        feed={feed}
        fileName={params.name}
        testIdPrefix="docker"
        sources={Boolean(params.containers?.length)}
        controls={
          <>
            <Select
              aria-label={t('Lines to load')}
              className="h-7 w-28 text-xs"
              value={String(tail)}
              onChange={(e) => {
                setTail(Number(e.target.value))
              }}
            >
              {[100, 500, 1000, 5000, 50_000].map((n) => (
                <option key={n} value={n}>
                  {t('Last {n}', { n: formatNumber(n) })}
                </option>
              ))}
            </Select>
            <ToolButton
              icon={<Clock size={13} />}
              label={t('Timestamps')}
              labelAt="3xl"
              pressed={timestamps}
              testId="docker-logs-timestamps"
              onClick={() => {
                setTimestamps(!timestamps)
              }}
            />
          </>
        }
        notice={
          (error ?? ended) && (
            <div className="flex items-center gap-2 border-b border-line p-2">
              <div className="flex-1">
                <Notice tone={error ? 'danger' : 'info'} testId="docker-logs-ended">
                  {error ?? ended}
                </Notice>
              </div>
              <ToolButton
                icon={<RefreshCw size={13} />}
                label={t('Reconnect')}
                labelAt="md"
                onClick={() => {
                  setRestart((r) => r + 1)
                }}
              />
            </div>
          )
        }
        placeholder={
          <p className={session.error ? 'p-3 text-danger' : 'p-3 text-faint'}>
            {session.error ?? (session.ready ? '' : session.status)}
          </p>
        }
      />
      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
    </div>
  )
}
