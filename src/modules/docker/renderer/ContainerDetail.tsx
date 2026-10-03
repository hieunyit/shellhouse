import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Eye, MoreHorizontal, Plug, RefreshCw, Unplug, X } from 'lucide-react'
import { useContextMenu } from '../../../renderer/src/components/ContextMenu'
import {
  DefList,
  Heading,
  LabelChips,
  Pill,
  Sparkline,
  TabStrip,
  SidePanel,
  type Tone
} from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  formatPercent,
  formatRelative,
  t,
  tn
} from '../../registry/renderer-kit'
import type {
  ContainerRow,
  DockerOp,
  Health,
  ImageLayer,
  ProcessList,
  StatsSample
} from '../shared/ops'
import { actionTitle, openMenuBelow, toMenu, type DetailAction } from './actions'
import { FilesPanel } from './FilesPanel'

export type { DetailAction } from './actions'

type Request = <T>(op: DockerOp, signal?: AbortSignal) => Promise<T>
type Obj = Record<string, unknown>
const o = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export function stateTone(state: string): Tone {
  if (state === 'running') return 'ok'
  if (state === 'paused' || state === 'restarting' || state === 'created') return 'warn'
  if (state === 'dead') return 'bad'
  return 'muted'
}

/** Tông màu của trạng thái healthcheck. */
export function healthTone(health: Health): Tone {
  return health === 'healthy' ? 'ok' : health === 'unhealthy' ? 'bad' : 'warn'
}

/** Nhãn trạng thái container / healthcheck (dữ liệu từ Docker → chữ dịch được). */
export function stateLabel(state: string): string {
  switch (state) {
    case 'running':
      return t('running')
    case 'exited':
      return t('exited')
    case 'paused':
      return t('paused')
    case 'restarting':
      return t('restarting')
    case 'created':
      return t('created')
    case 'dead':
      return t('dead')
    case 'removing':
      return t('removing')
    default:
      return state
  }
}

export function healthLabel(health: Health): string {
  return health === 'healthy'
    ? t('healthy')
    : health === 'unhealthy'
      ? t('unhealthy')
      : health === 'starting'
        ? t('starting')
        : ''
}

/** Chip trạng thái healthcheck (bảng + chi tiết). */
export function HealthPill({ health }: { health: Health }): React.JSX.Element | null {
  if (!health) return null
  return (
    <span
      data-testid="docker-health"
      data-health={health}
      title={t('Health check: {state}', { state: healthLabel(health) })}
    >
      <Pill tone={healthTone(health)}>{healthLabel(health)}</Pill>
    </span>
  )
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
  const primary = actions.filter((a) => !a.danger && !a.secondary).slice(0, 4)
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
            aria-label={t('More actions')}
            title={t('More actions')}
            aria-haspopup="menu"
            data-testid="docker-detail-more"
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
            onClick={(e) => {
              openMenuBelow(e.currentTarget, open, toMenu(actions))
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label={t('Close')}
          title={t('Close (Esc)')}
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
              title={actionTitle(a)}
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

export type DetailTab = 'overview' | 'stats' | 'files' | 'env' | 'processes' | 'inspect'

/** Chi tiết container (kiểu Docker Desktop / Portainer). */
export function ContainerDetail({
  container: c,
  request,
  host,
  stats,
  actions,
  tab,
  onTabChange,
  readOnly,
  onConnect,
  onDisconnect,
  onClose
}: {
  container: ContainerRow
  request: Request
  /** Địa chỉ để mở cổng đã publish (localhost hoặc tên server). */
  host: string
  stats: StatsSample[]
  actions: readonly DetailAction[]
  tab: DetailTab
  onTabChange: (tab: DetailTab) => void
  readOnly: boolean
  /** Nối container vào network khác. */
  onConnect: () => void
  onDisconnect: (network: string) => void
  onClose: () => void
}): React.JSX.Element {
  const setTab = onTabChange
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
    // Trạng thái / health đổi (start / stop, healthcheck) → đọc lại.
  }, [request, c.id, c.state, c.status])
  const running = c.state === 'running'
  return (
    <SidePanel storageKey="docker-detail" testId="docker-detail">
      <DetailHeader
        title={c.name}
        subtitle={`${c.image} · ${c.status}`}
        pill={
          <>
            <Pill tone={stateTone(c.state)}>{stateLabel(c.state)}</Pill>
            <HealthPill health={c.health} />
          </>
        }
        actions={actions}
        onClose={onClose}
      />
      <TabStrip<DetailTab>
        value={tab}
        onChange={setTab}
        testIdPrefix="docker-detail-tab"
        tabs={[
          { id: 'overview', label: t('Overview') },
          { id: 'stats', label: t('Stats') },
          { id: 'files', label: t('Files') },
          { id: 'env', label: t('Environment') },
          { id: 'processes', label: t('Processes') },
          { id: 'inspect', label: t('Inspect') }
        ]}
      />
      {tab === 'files' ? (
        <FilesPanel key={c.id} container={c} request={request} readOnly={readOnly} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
          {error && <p className="text-danger">{error}</p>}
          {tab === 'overview' && (
            <Overview
              c={c}
              inspect={inspect}
              host={host}
              stats={stats}
              readOnly={readOnly}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          )}
          {tab === 'stats' && <Stats running={running} stats={stats} />}
          {tab === 'env' && <Env id={c.id} request={request} inspect={inspect} />}
          {tab === 'processes' && <Processes id={c.id} running={running} request={request} />}
          {tab === 'inspect' && (
            <pre
              className="font-mono text-[11px] leading-relaxed text-fg select-text"
              data-testid="docker-detail-inspect"
            >
              {inspect ? JSON.stringify(inspect, null, 2) : t('Loading…')}
            </pre>
          )}
        </div>
      )}
    </SidePanel>
  )
}

function Overview({
  c,
  inspect,
  host,
  stats,
  readOnly,
  onConnect,
  onDisconnect
}: {
  c: ContainerRow
  inspect: Obj | null
  host: string
  stats: StatsSample[]
  readOnly: boolean
  onConnect: () => void
  onDisconnect: (network: string) => void
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
  const health = o(state['Health'])
  const healthLog = ((health['Log'] as Obj[] | null | undefined) ?? []).slice(-3).reverse()
  return (
    <div className="flex flex-col gap-4" data-testid="docker-detail-overview">
      {c.health && (
        <section data-testid="docker-detail-health">
          <Heading>{t('Health check')}</Heading>
          <DefList
            items={[
              [t('Status'), <HealthPill key="h" health={c.health} />],
              Number(health['FailingStreak'] ?? 0) > 0 && [
                t('Failing streak'),
                tn(Number(health['FailingStreak']), '{n} check', '{n} checks')
              ]
            ]}
          />
          {healthLog.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {healthLog.map((l, i) => (
                <div key={i} className="rounded-md bg-subtle px-2 py-1">
                  <div className="flex justify-between gap-2 text-faint">
                    <span>{formatDateTimeSeconds(s(l['Start']))}</span>
                    <span className={Number(l['ExitCode']) === 0 ? 'text-success' : 'text-danger'}>
                      {t('exit {code}', { code: s(l['ExitCode']) })}
                    </span>
                  </div>
                  {s(l['Output']).trim() && (
                    <pre className="mt-0.5 max-h-16 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap text-fg">
                      {s(l['Output']).trim()}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {last && c.state === 'running' && (
        <div className="grid grid-cols-2 gap-3" data-testid="docker-stats">
          <div>
            <div className="flex justify-between">
              <span className="text-muted">{t('CPU')}</span>
              <span className="text-fg tabular-nums">{cpuText(last.cpuPercent)}</span>
            </div>
            <Sparkline
              values={stats.map((x) => Math.max(0, x.cpuPercent))}
              max={Math.max(100, ...stats.map((x) => Math.max(0, x.cpuPercent)))}
            />
          </div>
          <div>
            <div className="flex justify-between">
              <span className="text-muted">{t('Memory')}</span>
              <span className="text-fg tabular-nums">{formatBytes(last.memUsage)}</span>
            </div>
            <Sparkline
              values={stats.map((x) => x.memUsage)}
              max={last.memLimit || Math.max(...stats.map((x) => x.memUsage), 1)}
            />
          </div>
        </div>
      )}
      <section>
        <Heading>{t('Container')}</Heading>
        <DefList
          items={[
            [
              t('ID'),
              <span key="id" className="inline-flex items-center gap-1 font-mono">
                {c.id.slice(0, 12)}
                <button
                  type="button"
                  aria-label={t('Copy ID')}
                  title={t('Copy ID')}
                  className="text-faint hover:text-fg"
                  onClick={() => void window.shellhouse.writeClipboard(c.id)}
                >
                  <Copy size={11} />
                </button>
              </span>
            ],
            [
              t('Image'),
              <span key="i" className="font-mono">
                {c.image}
              </span>
            ],
            [
              t('Created'),
              <span key="cr" title={formatDateTime(c.created)}>
                {formatRelative(c.created)}
              </span>
            ],
            state['StartedAt'] !== undefined &&
              c.state === 'running' && [
                t('Started'),
                <span key="st" title={formatDateTime(s(state['StartedAt']))}>
                  {formatRelative(s(state['StartedAt']))}
                </span>
              ],
            state['ExitCode'] !== undefined &&
              c.state === 'exited' && [t('Exit code'), s(state['ExitCode'])],
            !!cmd && [
              t('Command'),
              <span key="c" className="font-mono break-all">
                {cmd}
              </span>
            ],
            !!s(config['WorkingDir']) && [
              t('Working dir'),
              <span key="w" className="font-mono">
                {s(config['WorkingDir'])}
              </span>
            ],
            [t('Restart'), s(o(hostConfig['RestartPolicy'])['Name']) || 'no'],
            !!c.project && [t('Compose'), `${c.project}${c.service ? ` / ${c.service}` : ''}`]
          ]}
        />
      </section>
      {c.ports.length > 0 && (
        <section>
          <Heading>{t('Ports')}</Heading>
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
                    {t('open')} <ExternalLink size={11} />
                  </a>
                )}
              </div>
            ))}
            {published.length === 0 && (
              <span className="text-faint">{t('Not published to the host')}</span>
            )}
          </div>
        </section>
      )}
      <section data-testid="docker-detail-networks">
        <div className="flex items-center justify-between">
          <Heading>{t('Networks')}</Heading>
          {!readOnly && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-accent hover:underline"
              data-testid="docker-detail-connect"
              onClick={onConnect}
            >
              <Plug size={11} /> {t('Connect…')}
            </button>
          )}
        </div>
        {Object.keys(networks).length === 0 ? (
          <span className="text-faint">{t('Not connected to any network')}</span>
        ) : (
          <div className="flex flex-col gap-1">
            {Object.entries(networks).map(([name, n]) => {
              const aliases = ((o(n)['Aliases'] as string[] | null | undefined) ?? []).filter(
                (a) => !c.id.startsWith(a)
              )
              return (
                <div key={name} className="group flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg" title={name}>
                    {name}
                  </span>
                  <span className="font-mono text-muted">{s(o(n)['IPAddress']) || '—'}</span>
                  {aliases.length > 0 && (
                    <span className="truncate text-faint" title={aliases.join(', ')}>
                      {aliases.join(', ')}
                    </span>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      title={t('Disconnect from {network}', { network: name })}
                      aria-label={t('Disconnect from {network}', { network: name })}
                      data-testid="docker-detail-disconnect"
                      className="rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                      onClick={() => {
                        onDisconnect(name)
                      }}
                    >
                      <Unplug size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
      {mounts.length > 0 && (
        <section>
          <Heading>{t('Mounts')}</Heading>
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
          <Heading>{t('Labels')}</Heading>
          <LabelChips labels={o(config['Labels']) as Record<string, string>} />
        </section>
      )}
    </div>
  )
}

function Stats({ running, stats }: { running: boolean; stats: StatsSample[] }): React.JSX.Element {
  const last = stats.at(-1)
  if (!running) return <p className="text-faint">{t('The container is not running.')}</p>
  if (!last) return <p className="text-faint">{t('Collecting…')}</p>
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
        t('CPU'),
        cpuText(last.cpuPercent),
        stats.map((x) => Math.max(0, x.cpuPercent)),
        Math.max(100, ...stats.map((x) => Math.max(0, x.cpuPercent)))
      )}
      {chart(
        t('Memory'),
        `${formatBytes(last.memUsage)}${last.memLimit ? ` / ${formatBytes(last.memLimit)}` : ''}`,
        stats.map((x) => x.memUsage),
        last.memLimit || Math.max(...stats.map((x) => x.memUsage), 1)
      )}
      <DefList
        items={[
          [t('Network in'), formatBytes(last.netRx)],
          [t('Network out'), formatBytes(last.netTx)]
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
          <Eye size={12} /> {t('Show hidden values')}
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
        if (cancelled) return
        setList(r)
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, id, running, tick])
  if (!running) return <p className="text-faint">{t('The container is not running.')}</p>
  const refresh = (
    <button
      type="button"
      className="inline-flex items-center gap-1 self-end text-faint hover:text-fg"
      data-testid="docker-processes-refresh"
      onClick={() => {
        setTick((n) => n + 1)
      }}
    >
      <RefreshCw size={12} /> {t('Refresh')}
    </button>
  )
  // Lỗi vẫn có nút Refresh (lỗi thoáng qua không kẹt tới khi đóng bảng).
  if (error)
    return (
      <div className="flex flex-col gap-2">
        {refresh}
        <p className="text-danger">{error}</p>
      </div>
    )
  if (!list) return <p className="text-faint">{t('Loading…')}</p>
  return (
    <div className="flex flex-col gap-2" data-testid="docker-detail-processes">
      {refresh}
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
    <SidePanel storageKey="docker-detail" testId="docker-image-detail">
      <DetailHeader
        title={title}
        subtitle={`${formatBytes(size)} · ${formatDate(created)}`}
        actions={actions}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        <section className="mb-4">
          <Heading>{t('Image')}</Heading>
          <DefList
            items={[
              [
                t('ID'),
                <span key="id" className="font-mono">
                  {id.replace(/^sha256:/, '').slice(0, 12)}
                </span>
              ],
              [t('Tags'), tags.length ? tags.join(', ') : t('— (dangling)')],
              [t('Size'), formatBytes(size)],
              [
                t('Created'),
                <span key="c" title={formatDateTime(created)}>
                  {formatRelative(created)}
                </span>
              ]
            ]}
          />
        </section>
        <Heading>{t('Layers')}</Heading>
        {error && <p className="text-danger">{error}</p>}
        {!layers && !error && <p className="text-faint">{t('Loading…')}</p>}
        {layers && (
          <div className="flex flex-col divide-y divide-line" data-testid="docker-image-layers">
            {layers.map((l, i) => (
              <div key={`${l.id}${i}`} className="flex gap-2 py-1.5">
                <span className="w-16 shrink-0 text-right text-faint tabular-nums">
                  {formatBytes(l.size)}
                </span>
                <span className="min-w-0 font-mono text-[11px] break-all text-fg">
                  {l.createdBy.replace(/^\/bin\/sh -c (#\(nop\) )?/, '').trim()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </SidePanel>
  )
}

/** % CPU; -1 = chưa có mẫu để so (lần lấy đầu tiên). */
function cpuText(v: number): string {
  return v >= 0 ? formatPercent(v / 100, 1) : '—'
}
