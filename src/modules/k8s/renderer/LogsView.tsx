import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Copy, History, RefreshCw } from 'lucide-react'
import { LogFeed } from '@shared/log-buffer'
import { IconButton, Notice, Select } from '../../../renderer/src/components/ui'
import { ToolButton } from '../../../renderer/src/components/files/parts'
import { LogViewer } from '../../../renderer/src/components/LogViewer'
import { cleanError } from '../../../renderer/src/lib/format'
import { ConnectionPrompt, formatNumber, t } from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import { logsCommands } from '../shared/commands'
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
  /** '*' = mọi container của pod. */
  const [container, setContainer] = useState(params.allContainers ? '*' : (params.container ?? ''))
  const pod = params.pod
  const [tail, setTail] = useState(500)
  const [timestamps, setTimestamps] = useState(false)
  const [previous, setPrevious] = useState(false)
  /** Khoảng thời gian (giây, 0 = không giới hạn) — như kubectl --since. */
  const [since, setSince] = useState(0)
  const [ended, setEnded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)

  const onEvent = useCallback(
    (event: string, data: unknown) => {
      const d = data as { subscription: string; text: string; error?: string }
      if (d.subscription !== subscription.current) return
      if (event === 'logs') feed.push(d.text)
      else if (event === 'logs-end') setEnded(d.error ?? t('The log stream ended.'))
    },
    [feed]
  )
  const session = useK8sSession(tabId, params.ref, params.bastionHostId, readOnly, onEvent)
  const { ready, request } = session

  // Danh sách container của pod.
  useEffect(() => {
    if (!ready || !pod) return
    let cancelled = false
    request<K8sObject>({
      op: 'get',
      kind: 'pods',
      namespace: params.namespace,
      name: pod,
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
  }, [ready, request, params.namespace, pod])

  useEffect(() => {
    if (!ready) return
    let sub: string | null = null
    let cancelled = false
    request<{ subscription: string }>({
      op: 'logs.subscribe',
      namespace: params.namespace,
      ...(pod
        ? { pod }
        : params.selector
          ? { selector: params.selector }
          : params.pods
            ? { pods: params.pods }
            : {}),
      ...(container === '*' ? { allContainers: true } : container ? { container } : {}),
      previous,
      tail,
      timestamps,
      ...(since ? { sinceSeconds: since } : {})
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
    pod,
    params.selector,
    params.pods,
    container,
    previous,
    tail,
    timestamps,
    since,
    restart
  ])

  return (
    <div className="relative flex h-full flex-col bg-surface" data-testid="k8s-logs-view">
      <LogViewer
        feed={feed}
        fileName={
          (pod ?? params.title ?? 'logs').replace(/\//g, '-') +
          (container && container !== '*' ? `-${container}` : '')
        }
        testIdPrefix="k8s"
        sources={Boolean(params.selector) || Boolean(params.pods) || container === '*'}
        controls={
          <>
            {containers.length > 1 && (
              <Select
                aria-label={t('Container')}
                data-testid="k8s-logs-container"
                className="h-7 w-36 text-xs"
                value={container}
                onChange={(e) => {
                  setContainer(e.target.value)
                }}
              >
                <option value="*">{t('All containers')}</option>
                {containers.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
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
            <Select
              aria-label={t('Time range')}
              data-testid="k8s-logs-since"
              className="h-7 w-28 text-xs"
              value={String(since)}
              onChange={(e) => {
                setSince(Number(e.target.value))
              }}
            >
              <option value="0">{t('Any time')}</option>
              {SINCE.map(([seconds, label]) => (
                <option key={seconds} value={seconds}>
                  {t('Last {time}', { time: label })}
                </option>
              ))}
            </Select>
            <ToolButton
              icon={<History size={13} />}
              label={t('Previous run')}
              labelAt="3xl"
              pressed={previous}
              testId="k8s-logs-previous"
              onClick={() => {
                setPrevious(!previous)
              }}
            />
            <ToolButton
              icon={<Clock size={13} />}
              label={t('Timestamps')}
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
      <CommandFooter
        commands={logsCommands({
          ref: params.ref,
          namespace: params.namespace,
          ...(params.selector ? { selector: params.selector } : {}),
          ...(pod ? { pods: [pod] } : params.pods ? { pods: params.pods } : {}),
          ...(since ? { since: SINCE.find(([s]) => s === since)?.[1] } : {}),
          previous,
          follow: !previous
        })}
      />
      {session.prompt && <ConnectionPrompt prompt={session.prompt} onAnswer={session.answer} />}
    </div>
  )
}

/** Khoảng thời gian chọn được (giây, nhãn kiểu kubectl --since). */
const SINCE: readonly (readonly [number, string])[] = [
  [300, '5m'],
  [900, '15m'],
  [3600, '1h'],
  [6 * 3600, '6h'],
  [24 * 3600, '24h']
]

/** Chân trang: lệnh kubectl tương đương của đúng cấu hình đang xem — sao chép một chạm. */
function CommandFooter({ commands }: { commands: string[] }): React.JSX.Element | null {
  const command = commands[0]
  if (!command) return null
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2 border-t border-ds-border-subtle px-3 text-xs"
      data-testid="k8s-logs-command"
    >
      <span className="shrink-0 text-faint">{t('Same as')}</span>
      <code
        className="sh-selectable min-w-0 flex-1 truncate font-mono text-muted"
        title={commands.join('\n')}
      >
        {command}
      </code>
      {commands.length > 1 && (
        // kubectl logs nhận một pod mỗi lệnh — nút sao chép lấy đủ mọi lệnh.
        <span className="shrink-0 text-faint" data-testid="k8s-logs-command-more">
          {t('+{n} more', { n: String(commands.length - 1) })}
        </span>
      )}
      <IconButton
        label={commands.length > 1 ? t('Copy all') : t('Copy')}
        size="sm"
        onClick={() => void window.shellhouse.writeClipboard(commands.join('\n'))}
      >
        <Copy size={12} />
      </IconButton>
    </div>
  )
}
