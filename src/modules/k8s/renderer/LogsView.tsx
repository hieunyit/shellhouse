import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, History, RefreshCw } from 'lucide-react'
import { LogFeed } from '@shared/log-buffer'
import { Notice, Select } from '../../../renderer/src/components/ui'
import { ToolButton } from '../../../renderer/src/components/files/parts'
import { LogViewer } from '../../../renderer/src/components/LogViewer'
import { cleanError } from '../../../renderer/src/lib/format'
import { ConnectionPrompt } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import { contextKey, type K8sLogsParams } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import { useK8s } from './store'
import { useK8sSession } from './useK8sSession'

/** Tab log của một pod: chọn container, follow, previous (lần chạy trước), timestamps. */
export function PodLogsTab({ tabId, params }: ModuleTabProps<K8sLogsParams>): React.JSX.Element {
  const [feed] = useState(() => new LogFeed())
  const subscription = useRef<string | null>(null)
  const readOnly = useK8s(
    (st) => st.contexts.find((c) => c.key === contextKey(params.ref))?.settings.readOnly ?? false
  )
  const [containers, setContainers] = useState<string[]>(params.container ? [params.container] : [])
  const [container, setContainer] = useState(params.container ?? '')
  const [tail, setTail] = useState(500)
  const [timestamps, setTimestamps] = useState(false)
  const [previous, setPrevious] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)

  const onEvent = useCallback(
    (event: string, data: unknown) => {
      const d = data as { subscription: string; text: string; error?: string }
      if (d.subscription !== subscription.current) return
      if (event === 'logs') feed.push(d.text)
      else if (event === 'logs-end') setEnded(d.error ?? 'The log stream ended.')
    },
    [feed]
  )
  const session = useK8sSession(tabId, params.ref, params.bastionHostId, readOnly, onEvent)
  const { ready, request } = session

  // Danh sách container của pod.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    request<K8sObject>({
      op: 'get',
      kind: 'pods',
      namespace: params.namespace,
      name: params.pod,
      format: 'json'
    }).then(
      (pod) => {
        if (cancelled) return
        const list = ((pod.spec?.['containers'] as { name: string }[] | undefined) ?? []).map(
          (c) => c.name
        )
        setContainers(list)
        setContainer((cur) => cur || list[0] || '')
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [ready, request, params.namespace, params.pod])

  useEffect(() => {
    if (!ready) return
    let sub: string | null = null
    let cancelled = false
    request<{ subscription: string }>({
      op: 'logs.subscribe',
      namespace: params.namespace,
      pod: params.pod,
      ...(container ? { container } : {}),
      previous,
      tail,
      timestamps
    }).then(
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
  }, [
    ready,
    request,
    feed,
    params.namespace,
    params.pod,
    container,
    previous,
    tail,
    timestamps,
    restart
  ])

  return (
    <div className="relative flex h-full flex-col bg-surface" data-testid="k8s-logs-view">
      <LogViewer
        feed={feed}
        fileName={`${params.pod}${container ? `-${container}` : ''}`}
        testIdPrefix="k8s"
        controls={
          <>
            {containers.length > 1 && (
              <Select
                aria-label="Container"
                data-testid="k8s-logs-container"
                className="h-7 w-36 text-xs"
                value={container}
                onChange={(e) => {
                  setContainer(e.target.value)
                }}
              >
                {containers.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
            <Select
              aria-label="Lines to load"
              className="h-7 w-28 text-xs"
              value={String(tail)}
              onChange={(e) => {
                setTail(Number(e.target.value))
              }}
            >
              {[100, 500, 1000, 5000, 50_000].map((n) => (
                <option key={n} value={n}>
                  Last {n.toLocaleString('en')}
                </option>
              ))}
            </Select>
            <ToolButton
              icon={<History size={13} />}
              label="Previous run"
              labelAt="3xl"
              pressed={previous}
              testId="k8s-logs-previous"
              onClick={() => {
                setPrevious(!previous)
              }}
            />
            <ToolButton
              icon={<Clock size={13} />}
              label="Timestamps"
              labelAt="3xl"
              pressed={timestamps}
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
                <Notice tone={error ? 'danger' : 'info'} testId="k8s-logs-ended">
                  {error ?? ended}
                </Notice>
              </div>
              <ToolButton
                icon={<RefreshCw size={13} />}
                label="Reconnect"
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
