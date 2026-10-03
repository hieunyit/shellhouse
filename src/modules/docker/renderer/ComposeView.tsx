import { Fragment, useState } from 'react'
import {
  ArrowDownToLine,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleArrowUp,
  Copy,
  FileText,
  MoreHorizontal,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { Button, cx } from '../../../renderer/src/components/ui'
import type { MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { Empty } from '../../../renderer/src/components/files/parts'
import { Pill, type Tone } from '../../../renderer/src/components/panels'
import { formatDateTime, formatNumber, t, tn } from '../../registry/renderer-kit'
import type { ComposeAction, ContainerRow } from '../shared/ops'
import { ago, type ComposeProject, type ComposeService, portsText } from '../shared/view-model'
import { openMenuBelow } from './actions'
import { HealthPill, stateLabel, stateTone } from './ContainerDetail'

/**
 * Trang Compose: bảng toàn chiều rộng, mỗi dòng một project (tên, trạng thái, số service, file
 * cấu hình, lần cập nhật) với thao tác ngay cạnh tên; mở dòng → bảng service (image, trạng thái,
 * port, replica, thao tác nhanh). Các cột dùng chung một lưới (subgrid) nên thẳng hàng giữa các dòng.
 */

type OpenMenu = (
  event: { clientX: number; clientY: number; preventDefault: () => void },
  entries: MenuEntry[]
) => void

export function composeLabels(): Record<ComposeAction, { label: string; title: string }> {
  return {
    up: { label: t('Up'), title: t('Create and start everything (docker compose up -d)') },
    down: {
      label: t('Down'),
      title: t('Stop and remove the containers and networks (docker compose down)')
    },
    start: { label: t('Start'), title: t('Start the stopped containers') },
    stop: { label: t('Stop'), title: t('Stop every container') },
    restart: { label: t('Restart'), title: t('Restart every container') },
    pull: { label: t('Pull'), title: t('Pull newer images (docker compose pull)') }
  }
}

const ICONS: Record<ComposeAction, React.ReactNode> = {
  up: <CircleArrowUp size={13} />,
  down: <Trash2 size={13} />,
  start: <Play size={13} />,
  stop: <Square size={12} />,
  restart: <RotateCw size={13} />,
  pull: <ArrowDownToLine size={13} />
}

const STATUS_TONE: Record<ComposeProject['status'], Tone> = {
  running: 'ok',
  partial: 'warn',
  stopped: 'muted'
}

/** Nút biểu tượng nhỏ trên dòng service (chú thích + nhãn trợ năng). */
function IconAction({
  label,
  icon,
  testId,
  disabled,
  onClick
}: {
  label: string
  icon: React.ReactNode
  testId: string
  disabled?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className="inline-flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30"
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

export function ComposeView({
  projects,
  totalProjects,
  busy,
  readOnly,
  filtered,
  openMenu,
  onAction,
  onLogs,
  onServiceLogs,
  onShell,
  onContainerAction,
  containerMenu,
  quick,
  onCopy,
  emptyFiltered
}: {
  projects: readonly ComposeProject[]
  /** Số project trước khi lọc. */
  totalProjects: number
  busy: boolean
  readOnly: boolean
  filtered: boolean
  openMenu: OpenMenu
  onAction: (p: ComposeProject, a: ComposeAction) => void
  onLogs: (p: ComposeProject) => void
  onServiceLogs: (p: ComposeProject, s: ComposeService) => void
  onShell: (c: ContainerRow) => void
  /** Thao tác cho một nhóm container (service nhiều replica); qua hộp xác nhận hàng loạt. */
  onContainerAction: (containers: ContainerRow[], action: 'restart' | 'stop' | 'start') => void
  /** Menu đầy đủ của một container (cùng danh sách với tab Containers). */
  containerMenu: (c: ContainerRow) => MenuEntry[]
  /** Nút nhanh của một container (dòng replica). */
  quick: (c: ContainerRow) => React.JSX.Element
  onCopy: (text: string) => void
  emptyFiltered: React.ReactNode
}): React.JSX.Element {
  /** Project đang thu gọn (mặc định mở hết — thấy ngay các service). */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const labels = composeLabels()

  if (projects.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="docker-compose">
        {filtered ? (
          emptyFiltered
        ) : (
          <Empty
            icon={<Boxes size={18} />}
            title={t('No Compose projects')}
            text={t(
              'Run docker compose up -d in a project folder — its containers are grouped here by project.'
            )}
            action={null}
          />
        )}
      </div>
    )

  const containers = projects.reduce((n, p) => n + p.containers.length, 0)
  const running = projects.reduce((n, p) => n + p.running, 0)
  const unhealthy = projects.reduce((n, p) => n + p.unhealthy, 0)
  const allCollapsed = projects.every((p) => collapsed.has(p.name))
  const toggle = (name: string): void => {
    const next = new Set(collapsed)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setCollapsed(next)
  }

  const projectMenu = (p: ComposeProject): MenuEntry[] => {
    const out: MenuEntry[] = []
    if (!readOnly) {
      const mixed = p.running > 0 && p.running < p.containers.length
      for (const a of ['pull', ...(mixed ? (['start'] as const) : [])] as ComposeAction[])
        out.push({
          id: `compose-${a}`,
          label: labels[a].label,
          icon: ICONS[a],
          onSelect: () => {
            onAction(p, a)
          }
        })
      out.push('separator')
    }
    out.push({
      id: 'copy-project',
      label: t('Copy project name'),
      icon: <Copy size={14} />,
      onSelect: () => {
        onCopy(p.name)
      }
    })
    if (p.workingDir)
      out.push({
        id: 'copy-dir',
        label: t('Copy folder path'),
        icon: <Copy size={14} />,
        onSelect: () => {
          onCopy(p.workingDir ?? '')
        }
      })
    if (p.configFiles.length)
      out.push({
        id: 'copy-config',
        label: t('Copy config file path'),
        icon: <Copy size={14} />,
        onSelect: () => {
          onCopy(p.configFiles.join('\n'))
        }
      })
    if (p.workingDir)
      out.push({
        id: 'copy-up',
        label: t('Copy the up command'),
        icon: <SquareTerminal size={14} />,
        onSelect: () => {
          onCopy(
            `cd ${shellQuote(p.workingDir ?? '')} && docker compose${p.configFiles
              .map((f) => ` -f ${shellQuote(f)}`)
              .join('')} up -d`
          )
        }
      })
    if (!readOnly)
      out.push('separator', {
        id: 'compose-down',
        label: labels.down.label,
        icon: ICONS.down,
        danger: true,
        onSelect: () => {
          onAction(p, 'down')
        }
      })
    return out
  }

  const serviceMenu = (p: ComposeProject, s: ComposeService): MenuEntry[] => {
    const only = s.containers.length === 1 ? s.containers[0] : undefined
    if (only) return containerMenu(only)
    // Nhiều replica: thao tác cho cả service (từng replica có nút riêng trên dòng con).
    const out: MenuEntry[] = [
      {
        id: 'service-logs',
        label: t('Logs'),
        icon: <FileText size={14} />,
        onSelect: () => {
          onServiceLogs(p, s)
        }
      },
      {
        id: 'service-copy',
        label: t('Copy names'),
        icon: <Copy size={14} />,
        onSelect: () => {
          onCopy(s.containers.map((c) => c.name).join('\n'))
        }
      }
    ]
    if (!readOnly) {
      out.push('separator', {
        id: 'service-restart',
        label: t('Restart all replicas'),
        icon: <RotateCw size={14} />,
        onSelect: () => {
          onContainerAction(s.containers, 'restart')
        }
      })
      if (s.running < s.containers.length)
        out.push({
          id: 'service-start',
          label: t('Start all replicas'),
          icon: <Play size={14} />,
          onSelect: () => {
            onContainerAction(s.containers, 'start')
          }
        })
      if (s.running > 0)
        out.push({
          id: 'service-stop',
          label: t('Stop all replicas'),
          icon: <Square size={14} />,
          onSelect: () => {
            onContainerAction(s.containers, 'stop')
          }
        })
    }
    return out
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="docker-compose">
      {/* Tóm tắt + mở / thu gọn tất cả */}
      <div className="flex h-9 items-center gap-3 border-b border-line px-4 text-xs text-muted">
        <span className="font-medium text-fg tabular-nums" data-testid="docker-compose-summary">
          {filtered
            ? t('{shown} of {total}', {
                shown: formatNumber(projects.length),
                total: tn(totalProjects, '{n} project', '{n} projects')
              })
            : tn(projects.length, '{n} project', '{n} projects')}
        </span>
        <span className="text-faint">·</span>
        <span className="tabular-nums">
          {t('{running}/{total} containers running', {
            running: formatNumber(running),
            total: formatNumber(containers)
          })}
        </span>
        {unhealthy > 0 && (
          <>
            <span className="text-faint">·</span>
            <span className="text-danger tabular-nums">
              {tn(unhealthy, '{n} unhealthy', '{n} unhealthy')}
            </span>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          icon={allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
          data-testid="docker-compose-expand-all"
          onClick={() => {
            setCollapsed(allCollapsed ? new Set() : new Set(projects.map((p) => p.name)))
          }}
        >
          {allCollapsed ? t('Expand all') : t('Collapse all')}
        </Button>
      </div>

      <div
        role="table"
        aria-label={t('Compose projects')}
        className="grid grid-cols-[1.75rem_minmax(9rem,1fr)_auto_auto] @3xl:grid-cols-[1.75rem_minmax(11rem,1fr)_auto_auto_auto] @5xl:grid-cols-[1.75rem_minmax(11rem,1fr)_auto_auto_auto_auto] @6xl:grid-cols-[1.75rem_minmax(12rem,1.1fr)_auto_auto_minmax(10rem,1.4fr)_auto_auto]"
      >
        {/* Tiêu đề cột */}
        <div
          role="row"
          className="sticky top-0 z-10 col-span-full grid h-8 grid-cols-subgrid items-center gap-x-4 border-b border-line bg-surface px-2 text-xs font-medium text-faint"
        >
          <span />
          <span role="columnheader">{t('Project')}</span>
          <span role="columnheader">{t('Status')}</span>
          <span role="columnheader" className="hidden @3xl:block">
            {t('Services')}
          </span>
          <span role="columnheader" className="hidden @6xl:block">
            {t('Config')}
          </span>
          <span role="columnheader" className="hidden @5xl:block">
            {t('Updated')}
          </span>
          <span role="columnheader" className="text-right">
            {t('Actions')}
          </span>
        </div>

        {projects.map((p) => {
          const open = !collapsed.has(p.name)
          const anyRunning = p.running > 0
          const primary: ComposeAction[] = ['up', 'restart', anyRunning ? 'stop' : 'start']
          const config = p.configFiles[0] ?? null
          return (
            <Fragment key={p.name}>
              <div
                role="row"
                data-testid="docker-project"
                data-name={p.name}
                data-status={p.status}
                aria-expanded={open}
                className="group col-span-full grid min-h-12 cursor-default grid-cols-subgrid items-center gap-x-4 border-b border-line px-2 py-1.5 hover:bg-hover/60"
                onClick={(e) => {
                  // Bấm vào chỗ trống của dòng → mở / thu gọn (nút bên trong tự xử lý).
                  if ((e.target as HTMLElement).closest('button')) return
                  toggle(p.name)
                }}
              >
                <button
                  type="button"
                  aria-label={
                    open
                      ? t('Collapse {name}', { name: p.name })
                      : t('Expand {name}', { name: p.name })
                  }
                  data-testid="docker-compose-toggle"
                  className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                  onClick={() => {
                    toggle(p.name)
                  }}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <div role="cell" className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <Boxes size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-fg" title={p.name}>
                      {p.name}
                    </div>
                    {p.workingDir && (
                      <div
                        className="truncate font-mono text-[11px] text-faint @6xl:hidden"
                        title={p.workingDir}
                      >
                        {p.workingDir}
                      </div>
                    )}
                  </div>
                </div>
                <div role="cell" className="flex items-center gap-1.5 whitespace-nowrap">
                  <Pill tone={p.unhealthy ? 'bad' : STATUS_TONE[p.status]}>
                    {t('{running}/{total} running', {
                      running: p.running,
                      total: p.containers.length
                    })}
                  </Pill>
                  {p.unhealthy > 0 && (
                    <span className="text-xs text-danger" data-testid="docker-compose-unhealthy">
                      {tn(p.unhealthy, '{n} unhealthy', '{n} unhealthy')}
                    </span>
                  )}
                </div>
                <div role="cell" className="hidden text-xs text-muted tabular-nums @3xl:block">
                  {tn(p.services, '{n} service', '{n} services')}
                </div>
                <div role="cell" className="hidden min-w-0 @6xl:block">
                  {config ? (
                    <button
                      type="button"
                      className="group/path flex max-w-full items-center gap-1 rounded text-left font-mono text-[11px] text-muted hover:text-fg"
                      title={t('{path} — click to copy', {
                        path: [p.workingDir, ...p.configFiles].filter(Boolean).join('\n')
                      })}
                      data-testid="docker-compose-config"
                      onClick={() => {
                        onCopy(config)
                      }}
                    >
                      <span className="truncate">{config}</span>
                      {p.configFiles.length > 1 && (
                        <span className="shrink-0 rounded bg-subtle px-1 font-sans text-[10px] text-faint">
                          {`+${String(p.configFiles.length - 1)}`}
                        </span>
                      )}
                      <Copy size={11} className="shrink-0 opacity-0 group-hover/path:opacity-100" />
                    </button>
                  ) : (
                    <span className="text-xs text-faint">{p.workingDir ?? '—'}</span>
                  )}
                </div>
                <div
                  role="cell"
                  className="hidden text-xs whitespace-nowrap text-muted @5xl:block"
                  title={p.updated ? formatDateTime(p.updated) : undefined}
                >
                  {p.updated ? ago(p.updated) : '—'}
                </div>
                <div role="cell" className="flex items-center justify-end gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<FileText size={13} />}
                    data-testid="docker-compose-logs"
                    title={t('Logs of every service in one tab')}
                    aria-label={t('Logs of {name}', { name: p.name })}
                    onClick={() => {
                      onLogs(p)
                    }}
                  >
                    <span className="hidden @4xl:inline">{t('Logs')}</span>
                  </Button>
                  {!readOnly &&
                    primary.map((a) => (
                      <Button
                        key={a}
                        size="sm"
                        variant={a === 'up' ? 'secondary' : 'ghost'}
                        icon={ICONS[a]}
                        disabled={busy}
                        title={labels[a].title}
                        aria-label={`${labels[a].label} — ${p.name}`}
                        data-testid={`docker-compose-${a}`}
                        onClick={() => {
                          onAction(p, a)
                        }}
                      >
                        <span className="hidden @4xl:inline">{labels[a].label}</span>
                      </Button>
                    ))}
                  <button
                    type="button"
                    title={t('More actions')}
                    aria-label={t('More actions for {name}', { name: p.name })}
                    aria-haspopup="menu"
                    data-testid="docker-compose-more"
                    disabled={busy}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                    onClick={(e) => {
                      openMenuBelow(e.currentTarget, openMenu, projectMenu(p))
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              </div>
              {open && (
                <div
                  role="row"
                  className="col-span-full border-b border-line bg-subtle/60 py-1.5 pr-2 pl-11"
                >
                  <ServicesTable
                    project={p}
                    readOnly={readOnly}
                    onLogs={(s) => {
                      onServiceLogs(p, s)
                    }}
                    onShell={onShell}
                    onRestart={(cs) => {
                      onContainerAction(cs, 'restart')
                    }}
                    menu={(s) => serviceMenu(p, s)}
                    openMenu={openMenu}
                    quick={quick}
                  />
                </div>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

const DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  info: 'bg-accent',
  muted: 'bg-line-strong'
}

/** Trạng thái gộp của một service: một container → trạng thái của nó; nhiều → "2/3 running". */
function serviceState(s: ComposeService): { tone: Tone; text: string } {
  const only = s.containers.length === 1 ? s.containers[0] : undefined
  if (only) return { tone: stateTone(only.state), text: stateLabel(only.state) }
  return {
    tone: s.running === s.containers.length ? 'ok' : s.running ? 'warn' : 'muted',
    text: t('{running}/{total} running', { running: s.running, total: s.containers.length })
  }
}

function ServicesTable({
  project: p,
  readOnly,
  onLogs,
  onShell,
  onRestart,
  menu,
  openMenu,
  quick
}: {
  project: ComposeProject
  readOnly: boolean
  onLogs: (s: ComposeService) => void
  onShell: (c: ContainerRow) => void
  onRestart: (containers: ContainerRow[]) => void
  menu: (s: ComposeService) => MenuEntry[]
  openMenu: OpenMenu
  quick: (c: ContainerRow) => React.JSX.Element
}): React.JSX.Element {
  return (
    <div
      role="table"
      aria-label={t('Services of {name}', { name: p.name })}
      className="grid grid-cols-[minmax(8rem,1fr)_auto_auto_auto] text-xs @3xl:grid-cols-[minmax(8rem,1fr)_minmax(8rem,1.3fr)_auto_minmax(6rem,1fr)_auto_auto] @5xl:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1.5fr)_auto_minmax(8rem,1fr)_auto_auto]"
    >
      <div
        role="row"
        className="col-span-full grid h-7 grid-cols-subgrid items-center gap-x-4 px-2 text-[11px] font-medium text-faint"
      >
        <span role="columnheader">{t('Service')}</span>
        <span role="columnheader" className="hidden @3xl:block">
          {t('Image')}
        </span>
        <span role="columnheader">{t('State')}</span>
        <span role="columnheader" className="hidden @3xl:block">
          {t('Ports')}
        </span>
        <span role="columnheader" className="text-right">
          {t('Replicas')}
        </span>
        <span role="columnheader" className="sr-only">
          {t('Actions')}
        </span>
      </div>
      {p.serviceList.map((s) => {
        const st = serviceState(s)
        const shellTarget = s.containers.find((c) => c.state === 'running')
        const multi = s.containers.length > 1
        return (
          <Fragment key={s.name}>
            <div
              role="row"
              data-testid="docker-compose-service"
              data-name={s.name}
              className="col-span-full grid h-9 grid-cols-subgrid items-center gap-x-4 rounded-md px-2 hover:bg-surface"
            >
              <span role="cell" className="flex min-w-0 items-center gap-2">
                <span className={cx('size-2 shrink-0 rounded-full', DOT[st.tone])} />
                <span className="truncate text-[13px] text-fg" title={s.name}>
                  {s.name}
                </span>
              </span>
              <span
                role="cell"
                className="hidden truncate font-mono text-[11px] text-muted @3xl:block"
                title={s.image}
              >
                {s.image}
              </span>
              <span role="cell" className="flex items-center gap-1 whitespace-nowrap">
                <Pill tone={st.tone}>{st.text}</Pill>
                <HealthPill health={s.health} />
              </span>
              <span
                role="cell"
                className="hidden truncate text-muted tabular-nums @3xl:block"
                title={s.ports}
              >
                {s.ports || '—'}
              </span>
              <span role="cell" className="text-right text-muted tabular-nums">
                {`${String(s.running)}/${String(s.containers.length)}`}
              </span>
              <span role="cell" className="flex items-center justify-end gap-0.5">
                <IconAction
                  label={t('Logs — {name}', { name: s.name })}
                  icon={<FileText size={13} />}
                  testId="docker-compose-service-logs"
                  onClick={() => {
                    onLogs(s)
                  }}
                />
                {!readOnly && (
                  <>
                    <IconAction
                      label={t('Shell — {name}', { name: s.name })}
                      icon={<SquareTerminal size={13} />}
                      testId="docker-compose-service-shell"
                      disabled={!shellTarget}
                      onClick={() => {
                        if (shellTarget) onShell(shellTarget)
                      }}
                    />
                    <IconAction
                      label={t('Restart — {name}', { name: s.name })}
                      icon={<RotateCw size={13} />}
                      testId="docker-compose-service-restart"
                      onClick={() => {
                        onRestart(s.containers)
                      }}
                    />
                  </>
                )}
                <IconAction
                  label={t('More actions for {name}', { name: s.name })}
                  icon={<MoreHorizontal size={14} />}
                  testId="docker-compose-service-more"
                  onClick={(e) => {
                    openMenuBelow(e.currentTarget, openMenu, menu(s))
                  }}
                />
              </span>
            </div>
            {/* Nhiều replica: mỗi container một dòng con (thao tác riêng từng cái). */}
            {multi &&
              s.containers.map((c) => (
                <div
                  key={c.id}
                  role="row"
                  data-testid="docker-compose-replica"
                  data-name={c.name}
                  className="col-span-full grid h-8 grid-cols-subgrid items-center gap-x-4 rounded-md px-2 hover:bg-surface"
                >
                  <span role="cell" className="flex min-w-0 items-center gap-2 pl-4">
                    <span
                      className={cx('size-1.5 shrink-0 rounded-full', DOT[stateTone(c.state)])}
                    />
                    <span className="truncate text-muted" title={c.name}>
                      {c.name.startsWith(`${p.name}-`) ? c.name.slice(p.name.length + 1) : c.name}
                    </span>
                  </span>
                  <span role="cell" className="hidden @3xl:block" />
                  <span role="cell" className="flex items-center gap-1 whitespace-nowrap">
                    <span className="text-muted">{stateLabel(c.state)}</span>
                    <HealthPill health={c.health} />
                  </span>
                  <span role="cell" className="hidden truncate text-faint @3xl:block">
                    {portsText(c)}
                  </span>
                  <span role="cell" />
                  <span role="cell" className="flex justify-end">
                    {quick(c)}
                  </span>
                </div>
              ))}
          </Fragment>
        )
      })}
    </div>
  )
}

/** Đặt trong nháy đơn nếu có ký tự đặc biệt (lệnh sao chép dán vào shell). */
function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
