import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Eye, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import {
  DefList,
  Heading,
  LabelChips,
  Pill,
  Sparkline,
  TabStrip,
  type Tone
} from '../../../renderer/src/components/panels'
import { cleanError, formatSize } from '../../../renderer/src/lib/format'
import type { ContainerRow, DockerOp, ImageLayer, ProcessList, StatsSample } from '../shared/ops'

type Request = <T>(op: DockerOp) => Promise<T>
type Obj = Record<string, unknown>
const o = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export interface DetailAction {
  id: string
  label: string
  icon: React.ReactNode
  key?: string
  danger?: boolean
  run(): void
}

export function stateTone(state: string): Tone {
  if (state === 'running') return 'ok'
  if (state === 'paused' || state === 'restarting' || state === 'created') return 'warn'
  if (state === 'dead') return 'bad'
  return 'muted'
}

function toMenu(actions: readonly DetailAction[]): MenuEntry[] {
  const out: MenuEntry[] = []
  let danger = false
  for (const a of actions) {
    if (a.danger && !danger && out.length) {
      out.push('separator')
      danger = true
    }
    out.push({
      id: a.id,
      label: a.label,
      icon: a.icon,
      ...(a.key ? { hint: a.key } : {}),
      ...(a.danger ? { danger: true } : {}),
      onSelect: () => {
        a.run()
      }
    })
  }
  return out
}

/** Thanh tiêu đề + thao tác dùng chung cho các trang chi tiết Docker. */
function DetailHeader({
  title,
  subtitle,
  pill,
  actions,
  onClose
}: {
  title: string
  subtitle: string
  pill?: React.ReactNode
  actions: readonly DetailAction[]
  onClose: () => void
}): React.JSX.Element {
  const { menu, open } = useContextMenu()
  const primary = actions.filter((a) => !a.danger).slice(0, 4)
  return (
    <>
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg" title={title}>
              {title}
            </span>
            {pill}
          </div>
          <div className="truncate text-xs text-faint">{subtitle}</div>
        </div>
        {actions.length > 0 && (
          <button
            type="button"
            aria-label="More actions"
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
            onClick={(e) => {
              open(e, toMenu(actions))
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label="Close"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      {primary.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5">
          {primary.map((a) => (
            <button
              key={a.id}
              type="button"
              data-testid={`docker-action-${a.id}`}
              title={a.key ? `${a.label} (${a.key})` : a.label}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                a.run()
              }}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      )}
      {menu}
    </>
  )
}

type Tab = 'overview' | 'stats' | 'env' | 'processes' | 'inspect'

/** Chi tiết container (kiểu Docker Desktop / Portainer). */
export function ContainerDetail({
  container: c,
  request,
  host,
  stats,
  actions,
  onClose
}: {
  container: ContainerRow
  request: Request
  /** Địa chỉ để mở cổng đã publish (localhost hoặc tên server). */
  host: string
  stats: StatsSample[]
  actions: readonly DetailAction[]
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const [inspect, setInspect] = useState<Obj | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    request<Obj>({ op: 'inspect', kind: 'container', id: c.id }).then(
      (d) => {
        if (!cancelled) setInspect(d)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
    // Trạng thái đổi (start / stop) → đọc lại.
  }, [request, c.id, c.state])
  const running = c.state === 'running'
  return (
    <aside
      className="flex w-[26rem] max-w-[45%] shrink-0 flex-col border-l border-line bg-surface"
      data-testid="docker-detail"
    >
      <DetailHeader
        title={c.name}
        subtitle={`${c.image} · ${c.status}`}
        pill={<Pill tone={stateTone(c.state)}>{c.state}</Pill>}
        actions={actions}
        onClose={onClose}
      />
      <TabStrip<Tab>
        value={tab}
        onChange={setTab}
        testIdPrefix="docker-detail-tab"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'stats', label: 'Stats' },
          { id: 'env', label: 'Environment' },
          { id: 'processes', label: 'Processes' },
          { id: 'inspect', label: 'Inspect' }
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        {error && <p className="text-danger">{error}</p>}
        {tab === 'overview' && <Overview c={c} inspect={inspect} host={host} stats={stats} />}
        {tab === 'stats' && <Stats running={running} stats={stats} />}
        {tab === 'env' && <Env id={c.id} request={request} inspect={inspect} />}
        {tab === 'processes' && <Processes id={c.id} running={running} request={request} />}
        {tab === 'inspect' && (
          <pre
            className="font-mono text-[11px] leading-relaxed text-fg select-text"
            data-testid="docker-detail-inspect"
          >
            {inspect ? JSON.stringify(inspect, null, 2) : 'Loading…'}
          </pre>
        )}
      </div>
    </aside>
  )
}

function Overview({
  c,
  inspect,
  host,
  stats
}: {
  c: ContainerRow
  inspect: Obj | null
  host: string
  stats: StatsSample[]
}): React.JSX.Element {
  const state = o(inspect?.['State'])
  const config = o(inspect?.['Config'])
  const hostConfig = o(inspect?.['HostConfig'])
  const networks = o(o(inspect?.['NetworkSettings'])['Networks'])
  const mounts = (inspect?.['Mounts'] as Obj[] | undefined) ?? []
  const last = stats.at(-1)
  const cmd = [
    ...((config['Entrypoint'] as string[] | null) ?? []),
    ...((config['Cmd'] as string[] | null) ?? [])
  ].join(' ')
  const published = c.ports.filter((p) => p.publicPort)
  return (
    <div className="flex flex-col gap-4" data-testid="docker-detail-overview">
      {last && c.state === 'running' && (
        <div className="grid grid-cols-2 gap-3" data-testid="docker-stats">
          <div>
            <div className="flex justify-between">
              <span className="text-muted">CPU</span>
              <span className="text-fg tabular-nums">{last.cpuPercent.toFixed(1)}%</span>
            </div>
            <Sparkline
              values={stats.map((x) => x.cpuPercent)}
              max={Math.max(100, ...stats.map((x) => x.cpuPercent))}
            />
          </div>
          <div>
            <div className="flex justify-between">
              <span className="text-muted">Memory</span>
              <span className="text-fg tabular-nums">{formatSize(last.memUsage)}</span>
            </div>
            <Sparkline
              values={stats.map((x) => x.memUsage)}
              max={last.memLimit || Math.max(...stats.map((x) => x.memUsage), 1)}
            />
          </div>
        </div>
      )}
      <section>
        <Heading>Container</Heading>
        <DefList
          items={[
            [
              'ID',
              <span key="id" className="inline-flex items-center gap-1 font-mono">
                {c.id.slice(0, 12)}
                <button
                  type="button"
                  aria-label="Copy ID"
                  className="text-faint hover:text-fg"
                  onClick={() => void window.shellhouse.writeClipboard(c.id)}
                >
                  <Copy size={11} />
                </button>
              </span>
            ],
            [
              'Image',
              <span key="i" className="font-mono">
                {c.image}
              </span>
            ],
            ['Created', new Date(c.created).toLocaleString()],
            state['StartedAt'] !== undefined &&
              c.state === 'running' && [
                'Started',
                new Date(s(state['StartedAt'])).toLocaleString()
              ],
            state['ExitCode'] !== undefined &&
              c.state === 'exited' && ['Exit code', s(state['ExitCode'])],
            !!cmd && [
              'Command',
              <span key="c" className="font-mono break-all">
                {cmd}
              </span>
            ],
            !!s(config['WorkingDir']) && [
              'Working dir',
              <span key="w" className="font-mono">
                {s(config['WorkingDir'])}
              </span>
            ],
            ['Restart', s(o(hostConfig['RestartPolicy'])['Name']) || 'no'],
            !!c.project && ['Compose', `${c.project}${c.service ? ` / ${c.service}` : ''}`]
          ]}
        />
      </section>
      {c.ports.length > 0 && (
        <section>
          <Heading>Ports</Heading>
          <div className="flex flex-col gap-1">
            {c.ports.map((p) => (
              <div
                key={`${p.ip}${p.publicPort ?? ''}${p.privatePort}${p.type}`}
                className="flex items-center gap-2 font-mono"
              >
                <span className="text-fg">
                  {p.publicPort ? `${p.publicPort} → ` : ''}
                  {p.privatePort}/{p.type}
                </span>
                {p.publicPort && p.type === 'tcp' && (
                  <a
                    href={`http://${host}:${p.publicPort}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-sans text-accent hover:underline"
                    data-testid="docker-port-open"
                  >
                    open <ExternalLink size={11} />
                  </a>
                )}
              </div>
            ))}
            {published.length === 0 && (
              <span className="text-faint">Not published to the host</span>
            )}
          </div>
        </section>
      )}
      {Object.keys(networks).length > 0 && (
        <section>
          <Heading>Networks</Heading>
          <DefList
            items={Object.entries(networks).map(
              ([name, n]) =>
                [
                  name,
                  <span key={name} className="font-mono">
                    {s(o(n)['IPAddress']) || '—'}
                  </span>
                ] as const
            )}
          />
        </section>
      )}
      {mounts.length > 0 && (
        <section>
          <Heading>Mounts</Heading>
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {mounts.map((m) => (
              <div key={s(m['Destination'])} className="break-all">
                <span className="text-fg">{s(m['Destination'])}</span>
                <span className="text-faint"> ← {s(m['Name']) || s(m['Source'])}</span>
                {m['RW'] === false && <span className="text-warning"> (ro)</span>}
              </div>
            ))}
          </div>
        </section>
      )}
      {config['Labels'] !== undefined && Object.keys(o(config['Labels'])).length > 0 && (
        <section>
          <Heading>Labels</Heading>
          <LabelChips labels={o(config['Labels']) as Record<string, string>} />
        </section>
      )}
    </div>
  )
}

function Stats({ running, stats }: { running: boolean; stats: StatsSample[] }): React.JSX.Element {
  const last = stats.at(-1)
  if (!running) return <p className="text-faint">The container is not running.</p>
  if (!last) return <p className="text-faint">Collecting…</p>
  const chart = (
    label: string,
    value: string,
    values: number[],
    max: number
  ): React.JSX.Element => (
    <div className="rounded-md border border-line p-2">
      <div className="flex justify-between">
        <span className="text-muted">{label}</span>
        <span className="text-fg tabular-nums">{value}</span>
      </div>
      <Sparkline className="h-16" values={values} max={max} />
    </div>
  )
  return (
    <div className="flex flex-col gap-2" data-testid="docker-detail-stats">
      {chart(
        'CPU',
        `${last.cpuPercent.toFixed(1)}%`,
        stats.map((x) => x.cpuPercent),
        Math.max(100, ...stats.map((x) => x.cpuPercent))
      )}
      {chart(
        'Memory',
        `${formatSize(last.memUsage)}${last.memLimit ? ` / ${formatSize(last.memLimit)}` : ''}`,
        stats.map((x) => x.memUsage),
        last.memLimit || Math.max(...stats.map((x) => x.memUsage), 1)
      )}
      <DefList
        items={[
          ['Network in', formatSize(last.netRx)],
          ['Network out', formatSize(last.netTx)]
        ]}
      />
    </div>
  )
}

function Env({
  id,
  request,
  inspect
}: {
  id: string
  request: Request
  inspect: Obj | null
}): React.JSX.Element {
  const [revealed, setRevealed] = useState<string[] | null>(null)
  const env = revealed ?? (o(inspect?.['Config'])['Env'] as string[] | undefined) ?? []
  return (
    <div className="flex flex-col gap-2" data-testid="docker-detail-env">
      {!revealed && env.some((e) => e.endsWith('=••••••')) && (
        <button
          type="button"
          className="inline-flex items-center gap-1 self-start text-accent hover:underline"
          data-testid="docker-env-reveal"
          onClick={() => {
            void request<Obj>({ op: 'inspect', kind: 'container', id, reveal: true }).then((d) => {
              setRevealed((o(d['Config'])['Env'] as string[] | undefined) ?? [])
            })
          }}
        >
          <Eye size={12} /> Show hidden values
        </button>
      )}
      <div className="flex flex-col gap-0.5 font-mono text-[11px]">
        {env.map((e) => {
          const eq = e.indexOf('=')
          return (
            <div key={e} className="break-all">
              <span className="text-fg">{eq > 0 ? e.slice(0, eq) : e}</span>
              {eq > 0 && <span className="text-faint">=</span>}
              <span className="text-muted">{eq > 0 ? e.slice(eq + 1) : ''}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Processes({
  id,
  running,
  request
}: {
  id: string
  running: boolean
  request: Request
}): React.JSX.Element {
  const [list, setList] = useState<ProcessList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    let cancelled = false
    request<ProcessList>({ op: 'top', id }).then(
      (r) => {
        if (!cancelled) setList(r)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, id, running, tick])
  if (!running) return <p className="text-faint">The container is not running.</p>
  if (error) return <p className="text-danger">{error}</p>
  if (!list) return <p className="text-faint">Loading…</p>
  return (
    <div className="flex flex-col gap-2" data-testid="docker-detail-processes">
      <button
        type="button"
        className="inline-flex items-center gap-1 self-end text-faint hover:text-fg"
        onClick={() => {
          setTick((n) => n + 1)
        }}
      >
        <RefreshCw size={12} /> Refresh
      </button>
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr className="text-left text-faint">
            {list.titles.map((t) => (
              <th key={t} className="pr-2 font-medium">
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.processes.map((p, i) => (
            <tr key={i} className="align-top text-fg">
              {p.map((cell, j) => (
                <td key={j} className="pr-2 break-all">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Chi tiết image: thẻ, kích thước, các lớp (`docker history`). */
export function ImageDetail({
  title,
  tags,
  size,
  created,
  id,
  request,
  actions,
  onClose
}: {
  title: string
  tags: string[]
  size: number
  created: number
  id: string
  request: Request
  actions: readonly DetailAction[]
  onClose: () => void
}): React.JSX.Element {
  const [layers, setLayers] = useState<ImageLayer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    request<ImageLayer[]>({ op: 'image.history', id }).then(
      (l) => {
        if (!cancelled) setLayers(l)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, id])
  return (
    <aside
      className="flex w-[26rem] max-w-[45%] shrink-0 flex-col border-l border-line bg-surface"
      data-testid="docker-image-detail"
    >
      <DetailHeader
        title={title}
        subtitle={`${formatSize(size)} · ${new Date(created).toLocaleDateString()}`}
        actions={actions}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        <section className="mb-4">
          <Heading>Image</Heading>
          <DefList
            items={[
              [
                'ID',
                <span key="id" className="font-mono">
                  {id.replace(/^sha256:/, '').slice(0, 12)}
                </span>
              ],
              ['Tags', tags.length ? tags.join(', ') : '— (dangling)'],
              ['Size', formatSize(size)]
            ]}
          />
        </section>
        <Heading>Layers</Heading>
        {error && <p className="text-danger">{error}</p>}
        {!layers && !error && <p className="text-faint">Loading…</p>}
        {layers && (
          <div className="flex flex-col divide-y divide-line" data-testid="docker-image-layers">
            {layers.map((l, i) => (
              <div key={`${l.id}${i}`} className="flex gap-2 py-1.5">
                <span className="w-16 shrink-0 text-right text-faint tabular-nums">
                  {formatSize(l.size)}
                </span>
                <span className="min-w-0 font-mono text-[11px] break-all text-fg">
                  {l.createdBy.replace(/^\/bin\/sh -c (#\(nop\) )?/, '').trim()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
