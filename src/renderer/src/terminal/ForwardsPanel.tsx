import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'
import { ArrowLeftRight, Play, Square, Trash2, TriangleAlert } from 'lucide-react'
import {
  describeForward,
  ForwardSpec,
  isLoopback,
  toForwardSpec,
  type ForwardKind,
  type ForwardStatus,
  type SavedForward
} from '@shared/forwards'
import { Button, Checkbox, cx, Input, Notice, Segmented } from '../components/ui'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const stateStyle: Record<ForwardStatus['state'], string> = {
  starting: 'bg-warning',
  active: 'bg-success',
  error: 'bg-danger',
  stopped: 'bg-faint'
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
  const [kind, setKind] = useState<ForwardKind>('L')
  const [bindAddr, setBindAddr] = useState('127.0.0.1')
  const [bindPort, setBindPort] = useState('')
  const [destHost, setDestHost] = useState('127.0.0.1')
  const [destPort, setDestPort] = useState('')
  const [save, setSave] = useState(hostId !== null)
  const [autoStart, setAutoStart] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => {
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    if (!hostId) return
    let cancelled = false
    void window.shellhouse.listForwards(hostId).then((list) => {
      if (!cancelled) setSaved(list)
    })
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

  const add = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault()
    const draft = {
      id: crypto.randomUUID(),
      kind,
      bindAddr: bindAddr.trim(),
      bindPort: Number(bindPort || 0),
      destHost: kind === 'D' ? null : destHost.trim(),
      destPort: kind === 'D' ? null : Number(destPort)
    }
    const parsed = ForwardSpec.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid forward')
      return
    }
    setError(null)
    let spec = parsed.data
    if (save && hostId) {
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
        setError(result.message)
        return
      }
      spec = { ...spec, id: result.id }
      reload()
    }
    if (connected) actions.start(spec)
    setBindPort('')
    setDestPort('')
  }

  const deleteRow = async (row: Row): Promise<void> => {
    actions.remove(row.spec.id)
    if (row.saved) {
      await window.shellhouse.deleteForward(row.saved.id)
      reload()
    }
  }

  return (
    <aside
      className="animate-slide-in-right flex w-80 shrink-0 flex-col border-l border-line bg-surface"
      data-testid="forwards-panel"
    >
      <h3 className="flex h-10 items-center border-b border-line px-4 text-[13px] font-semibold">
        Port forwarding
      </h3>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <ArrowLeftRight size={20} className="text-faint" />
            <p className="text-xs text-muted">No forwards yet.</p>
            <p className="text-xs text-faint">
              Add one below to tunnel a port through this connection.
            </p>
          </div>
        )}
        {rows.map((row) => {
          const state = row.status?.state ?? 'stopped'
          const running = state === 'active' || state === 'starting'
          return (
            <div
              key={row.spec.id}
              className="animate-pop-in mb-2 rounded-lg border border-line bg-elevated p-2.5 shadow-xs"
              data-testid="forward-row"
              data-forward-state={state}
              data-forward-port={row.status?.actualPort ?? ''}
            >
              <div className="flex items-center gap-2">
                <span className={cx('size-2 shrink-0 rounded-full', stateStyle[state])} />
                <span className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted">
                  -{row.spec.kind}
                </span>
                <span className="min-w-0 flex-1 font-mono text-xs break-all">
                  {describeForward(row.spec, row.status?.actualPort)}
                </span>
              </div>
              {!isLoopback(row.spec.bindAddr) && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-warning">
                  <TriangleAlert size={12} /> Bound to {row.spec.bindAddr}: other machines on the
                  network can use it.
                </p>
              )}
              {row.status?.error && (
                <p className="mt-1.5 text-xs text-danger">{row.status.error}</p>
              )}
              {row.status && state === 'active' && (
                <p className="mt-1.5 text-xs text-faint">
                  {row.status.activeConnections} connection
                  {row.status.activeConnections === 1 ? '' : 's'} · ↑{' '}
                  {formatBytes(row.status.bytesOut)} · ↓ {formatBytes(row.status.bytesIn)}
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
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play size={12} />}
                    disabled={!connected}
                    data-testid="forward-start"
                    onClick={() => {
                      actions.start(row.spec)
                    }}
                  >
                    Start
                  </Button>
                )}
                {row.saved?.autoStart && (
                  <span className="rounded bg-subtle px-1.5 py-0.5 text-xs text-muted">
                    auto-start
                  </span>
                )}
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() => void deleteRow(row)}
                >
                  Delete
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <form
        className="flex flex-col gap-2.5 border-t border-line bg-subtle/40 p-3"
        onSubmit={(e) => void add(e)}
      >
        <Segmented
          value={kind}
          onChange={setKind}
          testIdPrefix="forward-kind"
          options={[
            { value: 'L', label: 'Local' },
            { value: 'R', label: 'Remote' },
            { value: 'D', label: 'SOCKS' }
          ]}
        />
        <span className="-mb-1 text-xs font-medium text-muted">
          {kind === 'L'
            ? 'Listen on this machine'
            : kind === 'R'
              ? 'Listen on the server'
              : 'SOCKS proxy on this machine'}
        </span>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <Input
            mono
            aria-label="Bind address"
            value={bindAddr}
            onChange={(e) => {
              setBindAddr(e.target.value)
            }}
          />
          <Input
            mono
            aria-label="Bind port"
            data-testid="forward-bind-port"
            placeholder={kind === 'D' ? '1080' : 'auto'}
            value={bindPort}
            onChange={(e) => {
              setBindPort(e.target.value)
            }}
          />
        </div>
        {kind !== 'D' && (
          <span className="-mb-1 text-xs font-medium text-muted">
            {kind === 'L'
              ? 'Destination (as seen from the server)'
              : 'Destination (as seen from this machine)'}
          </span>
        )}
        {kind !== 'D' && (
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Input
              mono
              aria-label="Destination host"
              data-testid="forward-dest-host"
              value={destHost}
              onChange={(e) => {
                setDestHost(e.target.value)
              }}
            />
            <Input
              mono
              aria-label="Destination port"
              data-testid="forward-dest-port"
              placeholder="port"
              value={destPort}
              onChange={(e) => {
                setDestPort(e.target.value)
              }}
            />
          </div>
        )}
        <p className="text-xs text-faint">
          {kind === 'L' &&
            'A port on this machine → through SSH → the destination (as seen from the server).'}
          {kind === 'R' &&
            'The server opens a port → back to the destination (as seen from this machine).'}
          {kind === 'D' && 'A SOCKS5 proxy on this machine; applications choose the destination.'}
        </p>
        {!isLoopback(bindAddr.trim() || '127.0.0.1') && (
          <Notice tone="warning">
            Not a loopback address: other machines on the network can use this port.
          </Notice>
        )}
        {hostId && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Checkbox
              label="Save for this host"
              checked={save}
              onChange={(e) => {
                setSave(e.target.checked)
              }}
            />
            {save && (
              <Checkbox
                label="Start on connect"
                checked={autoStart}
                onChange={(e) => {
                  setAutoStart(e.target.checked)
                }}
              />
            )}
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" data-testid="forward-add">
          {connected ? 'Add and start' : 'Add'}
        </Button>
      </form>
    </aside>
  )
}
