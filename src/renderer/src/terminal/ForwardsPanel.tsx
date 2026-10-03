import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'
import { ArrowLeftRight, Copy, Play, Square, Trash2, TriangleAlert } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { formatBytes } from '@shared/i18n/format'
import { confirmAction } from '../stores/confirm'
import { toast } from '../stores/toasts'
import { cleanError } from '../lib/format'
import {
  forwardEndpoints,
  ForwardSpec,
  isLoopback,
  toForwardSpec,
  type ForwardKind,
  type ForwardStatus,
  type SavedForward
} from '@shared/forwards'
import { Button, Checkbox, cx, IconButton, Input, Notice, Segmented } from '../components/ui'

const stateStyle: Record<ForwardStatus['state'], string> = {
  starting: 'bg-warning animate-pulse',
  active: 'bg-success',
  error: 'bg-danger',
  stopped: 'bg-faint'
}

function stateLabel(state: ForwardStatus['state']): string {
  if (state === 'starting') return t('Starting…')
  if (state === 'active') return t('Running')
  if (state === 'error') return t('Failed')
  return t('Stopped')
}

/** Tên đầy đủ của loại forward (tooltip của nhãn -L / -R / -D). */
function kindLabel(kind: ForwardKind): string {
  if (kind === 'L') return t('Local forward (-L)')
  if (kind === 'R') return t('Remote forward (-R)')
  return t('Dynamic SOCKS proxy (-D)')
}

interface Row {
  spec: ForwardSpec
  saved: SavedForward | null
  status: ForwardStatus | null
}

export interface ForwardActions {
  start(spec: ForwardSpec): void
  stop(id: string): void
  remove(id: string): void
}

type Field = 'bindAddr' | 'bindPort' | 'destHost' | 'destPort'
interface FormError {
  field: Field | null
  message: string
}

/** Như `Hostname` (@shared/hosts) nhưng báo lỗi bằng câu đã dịch, chỉ rõ ô nào sai. */
function addressError(value: string, empty: string): string | null {
  if (!value) return empty
  if (value.length > 255 || !/^[A-Za-z0-9._:[\]%-]+$/.test(value) || value.startsWith('-'))
    return t('“{value}” is not a valid host name or IP address', { value })
  return null
}

/** Cổng dạng chữ → số; null = không hợp lệ. */
function parsePort(text: string, min: number): number | null {
  if (!/^\d{1,5}$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= 65535 ? n : null
}

export function ForwardsPanel({
  hostId,
  statuses,
  connected,
  actions
}: {
  /** null = quick connect (forwards cannot be saved). */
  hostId: string | null
  statuses: ForwardStatus[]
  connected: boolean
  actions: ForwardActions
}): React.JSX.Element {
  const [saved, setSaved] = useState<SavedForward[]>([])
  const [loading, setLoading] = useState(hostId !== null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [kind, setKind] = useState<ForwardKind>('L')
  const [bindAddr, setBindAddr] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('')
  const [destHost, setDestHost] = useState('127.0.0.1')
  const [destPort, setDestPort] = useState('')
  const [save, setSave] = useState(hostId !== null)
  const [autoStart, setAutoStart] = useState(false)
  const [error, setError] = useState<FormError | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => {
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    if (!hostId) return
    let cancelled = false
    window.shellhouse.listForwards(hostId).then(
      (list) => {
        if (cancelled) return
        setSaved(list)
        setLoadError(null)
        setLoading(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setLoadError(cleanError(e))
        setLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [hostId, version])

  const rows: Row[] = [
    ...saved.map((s) => ({
      spec: toForwardSpec(s),
      saved: s,
      status: statuses.find((st) => st.spec.id === s.id) ?? null
    })),
    ...statuses
      .filter((st) => !saved.some((s) => s.id === st.spec.id))
      .map((st) => ({ spec: st.spec, saved: null, status: st }))
  ]
  const runningCount = rows.filter((r) => r.status?.state === 'active').length

  /** Kiểm tra từng ô (câu lỗi chỉ đúng ô sai) rồi mới qua schema dùng chung. */
  const validate = (): { spec: ForwardSpec } | FormError => {
    const addr = bindAddr.trim()
    const addrProblem = addressError(addr, t('Enter the address to listen on'))
    if (addrProblem) return { field: 'bindAddr', message: addrProblem }
    const listen = bindPort.trim() === '' ? 0 : parsePort(bindPort.trim(), 0)
    if (listen === null)
      return {
        field: 'bindPort',
        message: t(
          'The listening port must be a number from 1 to 65535 (leave it empty for any free port)'
        )
      }
    let host: string | null = null
    let port: number | null = null
    if (kind !== 'D') {
      host = destHost.trim()
      const hostProblem = addressError(host, t('Enter the destination host'))
      if (hostProblem) return { field: 'destHost', message: hostProblem }
      if (destPort.trim() === '')
        return { field: 'destPort', message: t('Enter the destination port') }
      port = parsePort(destPort.trim(), 1)
      if (port === null)
        return {
          field: 'destPort',
          message: t('The destination port must be a number from 1 to 65535')
        }
    }
    const parsed = ForwardSpec.safeParse({
      id: crypto.randomUUID(),
      kind,
      bindAddr: addr,
      bindPort: listen,
      destHost: host,
      destPort: port
    })
    if (!parsed.success)
      return { field: null, message: parsed.error.issues[0]?.message ?? t('Invalid forward') }
    return { spec: parsed.data }
  }

  const add = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const checked = validate()
    if (!('spec' in checked)) {
      setError(checked)
      return
    }
    setError(null)
    let spec = checked.spec
    if (save && hostId) {
      setBusy(true)
      try {
        // New record: do not send the id (the main process assigns it), otherwise it is treated as an update.
        const result = await window.shellhouse.saveForward({
          hostId,
          kind: spec.kind,
          bindAddr: spec.bindAddr,
          bindPort: spec.bindPort,
          destHost: spec.destHost,
          destPort: spec.destPort,
          autoStart
        })
        if (!result.ok) {
          setError({ field: null, message: result.message })
          return
        }
        spec = { ...spec, id: result.id }
        reload()
      } catch (e) {
        setError({ field: null, message: cleanError(e) })
        return
      } finally {
        setBusy(false)
      }
    }
    if (connected) actions.start(spec)
    setBindPort('')
    setDestPort('')
  }

  const deleteRow = async (row: Row): Promise<void> => {
    const { bind, dest } = forwardEndpoints(row.spec, row.status?.actualPort)
    const notes = [
      row.status?.state === 'active' ? t('It is running and stops now.') : null,
      row.saved ? t('The saved rule is removed from this host.') : null
    ].filter(Boolean)
    const ok = await confirmAction({
      title: t('Delete this forward?'),
      message: notes.length > 0 ? notes.join(' ') : undefined,
      details: (
        <code className="font-mono text-xs break-all">
          -{row.spec.kind} {dest ? `${bind} → ${dest}` : bind}
        </code>
      ),
      confirmLabel: t('Delete'),
      danger: true
    })
    if (!ok) return
    actions.remove(row.spec.id)
    if (row.saved) {
      try {
        await window.shellhouse.deleteForward(row.saved.id)
      } catch (e) {
        toast.error(t('Could not delete the saved forward'), { description: cleanError(e) })
      }
      reload()
    }
  }

  const copyAddress = (address: string): void => {
    window.shellhouse.writeClipboard(address).then(
      () => toast.success(t('Copied {value}', { value: address }), { duration: 2000 }),
      (e: unknown) => toast.error(t('Could not copy'), { description: cleanError(e) })
    )
  }

  const invalid = (field: Field): boolean => error?.field === field

  return (
    <aside
      className="animate-slide-in-right flex w-80 shrink-0 flex-col border-l border-line bg-surface"
      data-testid="forwards-panel"
      aria-label={t('Port forwarding')}
    >
      <h3 className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-[13px] font-semibold">
        <span className="flex-1">{t('Port forwarding')}</span>
        {runningCount > 0 && (
          <span className="rounded-full bg-success-soft px-2 py-px text-[11px] font-medium text-success">
            {tn(runningCount, '{n} running', '{n} running')}
          </span>
        )}
      </h3>
      <div className="min-h-0 flex-1 overflow-auto p-3" aria-live="polite">
        {loadError && (
          <div className="mb-2 flex flex-col gap-2">
            <Notice tone="danger">
              {t('Could not load the saved forwards: {error}', { error: loadError })}
            </Notice>
            <Button size="sm" variant="ghost" onClick={reload}>
              {t('Retry')}
            </Button>
          </div>
        )}
        {rows.length === 0 && loading && (
          <p className="px-4 py-10 text-center text-xs text-faint">{t('Loading…')}</p>
        )}
        {rows.length === 0 && !loading && !loadError && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <ArrowLeftRight size={20} className="text-faint" />
            <p className="text-xs text-muted">{t('No forwards yet.')}</p>
            <p className="text-xs text-faint">
              {t('Add one below to tunnel a port through this connection.')}
            </p>
          </div>
        )}
        {rows.map((row) => {
          const state = row.status?.state ?? 'stopped'
          const running = state === 'active' || state === 'starting'
          const { bind, dest } = forwardEndpoints(row.spec, row.status?.actualPort)
          return (
            <div
              key={row.spec.id}
              className="animate-pop-in mb-2 rounded-lg border border-line bg-elevated p-2.5 shadow-xs"
              data-testid="forward-row"
              data-forward-state={state}
              data-forward-port={row.status?.actualPort ?? ''}
            >
              <div className="flex items-center gap-2">
                <span
                  role="img"
                  aria-label={stateLabel(state)}
                  title={stateLabel(state)}
                  className={cx('size-2 shrink-0 rounded-full', stateStyle[state])}
                />
                <span
                  className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted"
                  title={kindLabel(row.spec.kind)}
                >
                  -{row.spec.kind}
                </span>
                <span className="sh-selectable min-w-0 flex-1 font-mono text-xs break-all">
                  {row.spec.kind === 'D' ? (
                    <>SOCKS5 {bind}</>
                  ) : (
                    <>
                      {row.spec.kind === 'R' && (
                        <span className="font-sans text-muted">{t('server')} </span>
                      )}
                      {bind} → {dest}
                    </>
                  )}
                </span>
                {state === 'active' && row.spec.kind !== 'R' && (
                  <IconButton
                    size="sm"
                    label={t('Copy address')}
                    onClick={() => {
                      copyAddress(bind)
                    }}
                  >
                    <Copy size={12} />
                  </IconButton>
                )}
              </div>
              {!isLoopback(row.spec.bindAddr) && (
                <p className="mt-1.5 flex items-start gap-1 text-xs text-warning">
                  <TriangleAlert size={12} className="mt-px shrink-0" />
                  {t('Bound to {address}: other machines on the network can use it.', {
                    address: row.spec.bindAddr
                  })}
                </p>
              )}
              {row.status?.error && (
                <p className="sh-selectable mt-1.5 text-xs text-danger" role="alert">
                  {row.status.error}
                </p>
              )}
              {row.status && state === 'active' && (
                <p className="mt-1.5 text-xs text-faint tabular-nums">
                  {tn(row.status.activeConnections, '{n} connection', '{n} connections')} ·{' '}
                  <span title={t('Sent')}>↑ {formatBytes(row.status.bytesOut)}</span> ·{' '}
                  <span title={t('Received')}>↓ {formatBytes(row.status.bytesIn)}</span>
                </p>
              )}
              <div className="mt-2 flex items-center gap-1">
                {running ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Square size={12} />}
                    onClick={() => {
                      actions.stop(row.spec.id)
                    }}
                  >
                    {t('Stop')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play size={12} />}
                    disabled={!connected}
                    title={connected ? undefined : t('Connect first to start this forward')}
                    data-testid="forward-start"
                    onClick={() => {
                      actions.start(row.spec)
                    }}
                  >
                    {t('Start')}
                  </Button>
                )}
                {row.saved?.autoStart && (
                  <span
                    className="rounded bg-subtle px-1.5 py-0.5 text-xs text-muted"
                    title={t('Starts automatically when this host connects')}
                  >
                    {t('auto-start')}
                  </span>
                )}
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() => void deleteRow(row)}
                >
                  {t('Delete')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <form
        className="flex shrink-0 flex-col gap-2.5 border-t border-line bg-subtle/40 p-3"
        aria-label={t('New forward')}
        noValidate
        onSubmit={(e) => void add(e)}
      >
        <Segmented
          value={kind}
          onChange={(k) => {
            setKind(k)
            setError(null)
          }}
          testIdPrefix="forward-kind"
          options={[
            { value: 'L', label: t('Local') },
            { value: 'R', label: t('Remote') },
            { value: 'D', label: 'SOCKS' }
          ]}
        />
        <span className="-mb-1 text-xs font-medium text-muted">
          {kind === 'L'
            ? t('Listen on this machine')
            : kind === 'R'
              ? t('Listen on the server')
              : t('SOCKS proxy on this machine')}
        </span>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Input
            mono
            aria-label={t('Bind address')}
            aria-invalid={invalid('bindAddr') || undefined}
            className={invalid('bindAddr') ? 'border-danger' : undefined}
            spellCheck={false}
            value={bindAddr}
            onChange={(e) => {
              setBindAddr(e.target.value)
            }}
          />
          <Input
            mono
            aria-label={t('Bind port')}
            aria-invalid={invalid('bindPort') || undefined}
            className={invalid('bindPort') ? 'border-danger' : undefined}
            inputMode="numeric"
            data-testid="forward-bind-port"
            placeholder={kind === 'D' ? '1080' : t('auto')}
            title={t('Leave empty to pick a free port')}
            value={bindPort}
            onChange={(e) => {
              setBindPort(e.target.value)
            }}
          />
        </div>
        {kind !== 'D' && (
          <span className="-mb-1 text-xs font-medium text-muted">
            {kind === 'L'
              ? t('Destination (as seen from the server)')
              : t('Destination (as seen from this machine)')}
          </span>
        )}
        {kind !== 'D' && (
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Input
              mono
              aria-label={t('Destination host')}
              aria-invalid={invalid('destHost') || undefined}
              className={invalid('destHost') ? 'border-danger' : undefined}
              spellCheck={false}
              data-testid="forward-dest-host"
              value={destHost}
              onChange={(e) => {
                setDestHost(e.target.value)
              }}
            />
            <Input
              mono
              aria-label={t('Destination port')}
              aria-invalid={invalid('destPort') || undefined}
              className={invalid('destPort') ? 'border-danger' : undefined}
              inputMode="numeric"
              data-testid="forward-dest-port"
              placeholder={t('port')}
              value={destPort}
              onChange={(e) => {
                setDestPort(e.target.value)
              }}
            />
          </div>
        )}
        <p className="text-xs text-faint">
          {kind === 'L' &&
            t('A port on this machine → through SSH → the destination (as seen from the server).')}
          {kind === 'R' &&
            t('The server opens a port → back to the destination (as seen from this machine).')}
          {kind === 'D' &&
            t('A SOCKS5 proxy on this machine; applications choose the destination.')}
        </p>
        {!isLoopback(bindAddr.trim() || '127.0.0.1') && (
          <Notice tone="warning">
            {t('Not a loopback address: other machines on the network can use this port.')}
          </Notice>
        )}
        {hostId && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Checkbox
              label={t('Save for this host')}
              checked={save}
              onChange={(e) => {
                setSave(e.target.checked)
              }}
            />
            {save && (
              <Checkbox
                label={t('Start on connect')}
                checked={autoStart}
                onChange={(e) => {
                  setAutoStart(e.target.checked)
                }}
              />
            )}
          </div>
        )}
        {!hostId && (
          <p className="text-xs text-faint">
            {t('Quick connections cannot save forwards; they stop when the tab closes.')}
          </p>
        )}
        {error && <Notice tone="danger">{error.message}</Notice>}
        <Button type="submit" variant="primary" disabled={busy} data-testid="forward-add">
          {connected ? t('Add and start') : t('Add')}
        </Button>
      </form>
    </aside>
  )
}
