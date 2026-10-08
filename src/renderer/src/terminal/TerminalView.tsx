import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LookMenu } from './LookMenu'
import { useTerminalFind } from '../stores/terminal-find'
import { FindBar } from './FindBar'
import '@xterm/xterm/css/xterm.css'
import { ArrowLeftRight, Columns2, FolderOpen, KeyRound, Maximize2, Search } from 'lucide-react'
import { LocalPanel } from './LocalPanel'
import type { LocalTarget, SftpActions } from './SftpPanel'
import { connectionLabel, cx, StatusDot } from '../components/ui'
import type { ForwardStatus } from '@shared/forwards'
import { hostAddress, useHosts } from '../stores/hosts'
import { useTabStatus } from '../stores/tab-status'
import { useBroadcast } from './broadcast'
import { useTerminalMenu } from './TerminalMenu'
import { setCloseGuard, useTabs, type TerminalTarget } from '../stores/tabs'
import { usePublishTransfers } from '../stores/transfers'
import { useShell } from '../shell/store'
import { useSettings } from '../stores/settings'
import { TerminalController, type ActivePrompt } from './controller'
import { DeployKeyDialog, ForwardsPanel, SftpPanel } from '../lazy'
import type { SftpOp, TransferStatus } from '@shared/sftp'
import type { ServerStats } from '@shared/server-stats'
import { PromptDialog } from './PromptDialog'
import { isFinished, orphanize, splitLocal } from './orphan-transfers'
import { ServerStatsBar, ServerStatsPlaceholder } from './ServerStatsBar'
import { t, tn } from '@shared/i18n'
import { formatNumber, formatTime } from '@shared/i18n/format'
import { controllers } from './registry'
import { ModuleSuggestion } from '../components/ModuleSuggestion'

type Panel = 'forwards' | 'sftp' | null

export function TerminalView({
  tabId,
  target,
  active,
  visible = true
}: {
  tabId: string
  target: TerminalTarget
  active: boolean
  /** Panel đang hiện trong bố cục (không bị tab khác cùng nhóm che). */
  visible?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null)
  const [forwards, setForwards] = useState<ForwardStatus[]>([])
  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  /** Lượt truyền của phiên hiện tại / của các phiên đã đóng (xem orphan-transfers). */
  const liveTransfers = useRef<TransferStatus[]>([])
  const orphanTransfers = useRef<TransferStatus[]>([])
  const [connected, setConnected] = useState(false)
  /** Module có dấu hiệu trên server này (gợi ý bật). */
  const [detected, setDetected] = useState<string[]>([])
  /** undefined = chưa có số liệu / tắt; null = server không hỗ trợ. */
  const [stats, setStats] = useState<ServerStats | null | undefined>(undefined)
  const [latency, setLatency] = useState<number | null | undefined>(undefined)
  /** 'files' = trình quản lý file hai cột (Local | Remote); terminal vẫn chạy phía sau. */
  const [view, setViewState] = useState<'terminal' | 'files'>(
    () => useTabs.getState().tabs.find((x) => x.id === tabId)?.view ?? 'terminal'
  )
  // Ghi lại vào tab để Workspace / Duplicate giữ đúng chế độ.
  const setView = (next: 'terminal' | 'files'): void => {
    // Tab SFTP chưa có shell → mở shell khi người dùng xem terminal lần đầu.
    if (next === 'terminal') controllers.get(tabId)?.openShell()
    setViewState(next)
    useTabs.getState().setView(tabId, next === 'files' ? 'files' : undefined)
  }
  const [localTarget, setLocalTarget] = useState<LocalTarget | undefined>(undefined)
  const sftpActions = useRef<SftpActions | null>(null)
  const [panel, setPanel] = useState<Panel>(
    () => useTabs.getState().tabs.find((x) => x.id === tabId)?.initialPanel ?? null
  )
  // Màu môi trường + đường dẫn nhóm (host đã lưu): nhắc người dùng đang ở server nào.
  // Terminal của module qua SSH (shell vào container…) cũng mang màu của host đi qua.
  const hostId =
    target.kind === 'host'
      ? target.hostId
      : target.kind === 'module-terminal'
        ? (target.hostId ?? null)
        : null
  const envColor = useHosts((s) => (hostId ? (s.effective.get(hostId)?.color ?? null) : null))
  const envPath = useHosts((s) => {
    const groupId = hostId ? s.tree.hosts.find((h) => h.id === hostId)?.groupId : null
    return groupId ? s.groupTree.path(groupId).join(' / ') : ''
  })
  const env = hostId ? { color: envColor, path: envPath } : null
  const encoding = useHosts((s) =>
    hostId ? (s.tree.hosts.find((h) => h.id === hostId)?.encoding ?? null) : null
  )
  const legacy = useHosts((s) =>
    hostId ? (s.tree.hosts.find((h) => h.id === hostId)?.legacyAlgorithms ?? false) : false
  )
  const [deploying, setDeploying] = useState(false)
  const isRemote = target.kind !== 'local'
  // Host Telnet / Serial: không có SFTP, forwarding, deploy key, file manager.
  const protocol = useHosts((s) =>
    hostId ? (s.tree.hosts.find((h) => h.id === hostId)?.protocol ?? 'ssh') : 'ssh'
  )
  // Terminal của module: không có SFTP / forwarding / deploy key trên kênh này.
  const isSsh = protocol === 'ssh' && target.kind !== 'module-terminal'
  const multiExec = useBroadcast((s) => s.enabled)
  const statsEnabled = useSettings((s) => s.settings.terminal.serverStats)
  // Địa chỉ đích trên thanh phiên (host đã lưu: sau kế thừa từ nhóm).
  const address = useHosts((s) => {
    if (target.kind === 'ssh')
      return `${target.username}@${target.host}${target.port === 22 ? '' : `:${String(target.port)}`}`
    if (target.kind !== 'host') return ''
    const h = s.tree.hosts.find((x) => x.id === target.hostId)
    return h ? hostAddress(h, s.effective.get(h.id)) : ''
  })
  const state = useTabStatus((s) => s.byTab[tabId] ?? 'idle')
  // Đếm số lần vào trạng thái "connected" (kết nối lại → đồng hồ chạy lại từ 0).
  const [connectedSeq, setConnectedSeq] = useState(0)
  const [lastState, setLastState] = useState(state)
  if (lastState !== state) {
    setLastState(state)
    if (state === 'connected') setConnectedSeq((n) => n + 1)
  }
  // Editor trong app mở từ SFTP của tab này: "nơi chứa" hiện trên thanh editor.
  const tabTitle = useTabs((s) => s.tabs.find((x) => x.id === tabId)?.title ?? '')
  const sftpOrigin = useMemo(
    () => ({ key: tabId, label: tabTitle.replace(/ \(SFTP\)$/, '') }),
    [tabId, tabTitle]
  )
  const runSftp = useCallback(
    (op: SftpOp) =>
      controllers.get(tabId)?.sftp(op) ?? Promise.reject(new Error(t('The tab was closed'))),
    [tabId]
  )
  // Trung tâm Transfers (khu vực Transfers + status bar) thấy lượt truyền của phiên này.
  const publishTransfers = (): void => {
    setTransfers([...orphanTransfers.current, ...liveTransfers.current])
  }
  /** Bỏ một lượt của phiên cũ; `parts`: xoá luôn file part dở trên máy này (tải xuống). */
  const dropOrphan = (id: string, parts: boolean): void => {
    const orphan = orphanTransfers.current.find((x) => x.id === id)
    orphanTransfers.current = orphanTransfers.current.filter((x) => x.id !== id)
    publishTransfers()
    if (parts && orphan?.direction === 'download' && orphan.state !== 'done') {
      const { dir, name } = splitLocal(orphan.localPath)
      void runSftp({ op: 'discardLocalParts', dir, names: [name] }).catch(() => undefined)
    }
  }
  usePublishTransfers({
    id: `sftp:${tabId}`,
    label: sftpOrigin.label,
    kind: 'sftp',
    transfers,
    cancel: (id) => {
      if (orphanTransfers.current.some((x) => x.id === id)) dropOrphan(id, false)
      else void runSftp({ op: 'cancel', transferId: id }).catch(() => undefined)
    },
    retry: (id) => {
      const orphan = orphanTransfers.current.find((x) => x.id === id)
      // Phiên cũ đã mất hàng đợi: chạy lại như lượt mới trên phiên hiện tại (tiếp tục từ file part).
      if (orphan)
        void runSftp({
          op: orphan.direction,
          localPath: orphan.localPath,
          remotePath: orphan.remotePath,
          overwrite: true
        }).then(
          () => {
            dropOrphan(id, false)
          },
          () => undefined
        )
      else void runSftp({ op: 'retry', transferId: id }).catch(() => undefined)
    },
    discard: (id) => {
      if (orphanTransfers.current.some((x) => x.id === id)) dropOrphan(id, true)
      else void runSftp({ op: 'discard', transferId: id }).catch(() => undefined)
    },
    clear: (keepParts) => {
      for (const x of orphanTransfers.current.filter(isFinished))
        dropOrphan(x.id, keepParts !== true && x.state !== 'done')
      void runSftp({ op: 'clearDone', keepParts: keepParts === true }).catch(() => undefined)
    },
    reveal: () => {
      useTabs.getState().activate(tabId)
    }
  })

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const controller = new TerminalController(tabId, target, container, {
      onTitle: (title) => {
        useTabs.getState().setTitle(tabId, title)
      },
      onPrompt: (p) => {
        setPrompt(p)
        useTabStatus.getState().setPrompt(tabId, p)
      },
      onForwards: setForwards,
      onTransfers: (list) => {
        liveTransfers.current = list
        publishTransfers()
      },
      onStats: setStats,
      onLatency: setLatency,
      onConnectedChange: (isConnected) => {
        setConnected(isConnected)
        // Phiên đóng: lượt đang chạy của nó không bao giờ có tin nữa → chốt thành lỗi (không để "ma").
        if (!isConnected && liveTransfers.current.length > 0) {
          orphanTransfers.current = [
            ...orphanTransfers.current,
            ...orphanize(
              liveTransfers.current,
              t('Connection lost — start the transfer again to resume')
            )
          ]
          liveTransfers.current = []
          publishTransfers()
        }
      },
      onModuleSuggest: setDetected,
      onContextMenu: (x, y) => {
        useTerminalMenu.getState().open(tabId, x, y)
      },
      onStateChange: (state) => {
        useTabStatus.getState().set(tabId, state)
      },
      onCleanExit: () => {
        useTabs.getState().close(tabId)
      }
    })
    controllers.set(tabId, controller)
    controller.start()
    return () => {
      controllers.delete(tabId)
      controller.dispose()
      useBroadcast.getState().forget(tabId)
      useTabStatus.getState().remove(tabId)
    }
    // target không đổi trong suốt vòng đời một tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    controllers.get(tabId)?.setVisible(visible)
  }, [tabId, visible])

  // Đóng tab đang kết nối: đang truyền file → luôn hỏi; tab SSH → hỏi nếu cài đặt bật.
  const transfersRef = useRef(transfers)
  useEffect(() => {
    transfersRef.current = transfers
  }, [transfers])
  useEffect(() => {
    setCloseGuard(tabId, () => {
      if (target.kind === 'local') return null
      if (controllers.get(tabId)?.connectionState !== 'connected') return null
      const name = useTabs.getState().tabs.find((x) => x.id === tabId)?.title ?? t('this server')
      const running = transfersRef.current.filter(
        (x) => x.state === 'running' || x.state === 'queued'
      ).length
      if (running > 0)
        return {
          title: t('Close “{name}”?', { name }),
          message: tn(
            running,
            '{n} file transfer is still running on {name}. Closing the tab cancels it.',
            '{n} file transfers are still running on {name}. Closing the tab cancels them.',
            { name }
          ),
          confirmLabel: t('Close and cancel')
        }
      if (
        (target.kind === 'host' || target.kind === 'ssh') &&
        useSettings.getState().settings.terminal.confirmCloseConnected
      )
        return {
          title: t('Close “{name}”?', { name }),
          message: t('You are connected to {name}. Closing the tab ends the session.', { name }),
          confirmLabel: t('Close')
        }
      return null
    })
    return () => {
      setCloseGuard(tabId, null)
    }
    // target không đổi trong suốt vòng đời một tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  const filesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active || prompt) return
    // File manager che terminal → không focus terminal ẩn (phím gõ sẽ chạy vào shell); focus bảng file.
    if (view === 'files') {
      controllers.get(tabId)?.activate(false)
      const files = filesRef.current
      if (files && !files.contains(document.activeElement)) {
        const grids = files.querySelectorAll<HTMLElement>('[role="grid"]')
        ;(grids[grids.length - 1] ?? files).focus()
      }
      return
    }
    controllers.get(tabId)?.activate()
  }, [active, tabId, prompt, panel, view])

  const activeForwards = forwards.filter((f) => f.state === 'active').length

  return (
    <div className="flex h-full flex-col">
      {isRemote && (
        <div
          className={cx(
            // @container: ô hẹp (lưới, chia màn hình) → chỉ còn icon, không vỡ dòng.
            // Session header (thiết kế v0.5): trạng thái · địa chỉ · độ trễ — môi trường đã có ở
            // breadcrumb + vạch trên cùng của vùng chính, không tô lại ở đây.
            '@container flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-ds-border-subtle bg-surface px-2 text-xs whitespace-nowrap'
          )}
          data-env-color={env?.color ?? ''}
          data-session-bar=""
        >
          <span className="flex items-center gap-2 pl-1" data-testid="session-state">
            <StatusDot state={state} />
            <span
              className={cx(
                'hidden @xs:inline',
                state === 'connected'
                  ? 'text-success'
                  : state === 'disconnected'
                    ? 'text-danger'
                    : state === 'connecting' || state === 'reconnecting'
                      ? 'text-warning'
                      : 'text-muted'
              )}
            >
              {connectionLabel[state]}
            </span>
            {/* Đồng hồ phiên: gắn lại mỗi lần kết nối (key) — đếm từ lúc vào được server. */}
            {state === 'connected' && <SessionClock key={`clock-${String(connectedSeq)}`} />}
            {state === 'connected' && typeof latency === 'number' && (
              <span
                className={cx(
                  'hidden tabular-nums @sm:inline',
                  latency < 100 ? 'text-muted' : latency < 300 ? 'text-warning' : 'text-danger'
                )}
                data-testid="session-latency"
                title={t('Round-trip time to the server (SSH keepalive)')}
              >
                {t('{ms} ms', { ms: formatNumber(latency, 0) })}
              </span>
            )}
          </span>
          {address && (
            <span
              className="ml-2 hidden min-w-0 truncate font-mono text-xs text-muted @lg:inline"
              data-testid="session-address"
              title={address}
            >
              {address}
            </span>
          )}
          {protocol === 'telnet' && (
            <span
              className="ml-2 shrink-0 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
              data-testid="session-telnet"
              title={t('Telnet sends everything, including passwords, in clear text')}
            >
              {t('Telnet · not encrypted')}
            </span>
          )}
          {protocol === 'serial' && (
            <span
              className="ml-2 shrink-0 rounded bg-subtle px-1.5 py-px text-xs font-medium text-muted"
              data-testid="session-serial"
            >
              Serial
            </span>
          )}
          {legacy && (
            <span
              className="ml-2 hidden shrink-0 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning @sm:inline"
              data-testid="session-legacy"
              title={t('Legacy algorithms are allowed for this host (weaker security)')}
            >
              {t('Legacy')}
            </span>
          )}
          {env?.path && (
            <span
              className="ml-2 hidden min-w-0 truncate text-xs text-faint @md:inline"
              data-testid="session-group-path"
              title={t('Group')}
            >
              {env.path}
            </span>
          )}
          {encoding && encoding !== 'utf-8' && (
            <span
              className="ml-2 hidden shrink-0 rounded bg-subtle px-1.5 py-px font-mono text-[11px] text-muted uppercase @sm:inline"
              data-testid="session-encoding"
              title={t('Character encoding of this host (Edit host → Advanced)')}
            >
              {encoding}
            </span>
          )}
          <div className="flex-1" />
          {/* Số liệu server ngay trên thanh phiên (thiết kế v0.5); ô hẹp thì ẩn. */}
          <span className="mr-2 hidden @3xl:flex">
            {stats ? (
              <ServerStatsBar stats={stats} inline />
            ) : (
              // Chờ lần đo đầu (vài giây sau khi vào server): giữ chỗ thay vì để số nhảy ra đột ngột.
              stats === undefined &&
              isSsh &&
              connected &&
              statsEnabled &&
              visible &&
              !multiExec && <StatsLoading key={`stats-${String(connectedSeq)}`} />
            )}
          </span>
          <LookMenu />
          <ToolbarButton
            testId="open-find"
            iconOnly
            icon={<Search size={13} />}
            onClick={() => {
              useTerminalFind.getState().open(tabId)
            }}
          >
            {t('Find')}
          </ToolbarButton>
          {isSsh && (
            <>
              <ToolbarButton
                testId="toggle-files"
                iconOnly
                pressed={view === 'files'}
                icon={<Columns2 size={13} />}
                onClick={() => {
                  setView(view === 'files' ? 'terminal' : 'files')
                  if (panel === 'sftp') setPanel(null)
                }}
              >
                {view === 'files' ? t('Show terminal') : t('File manager')}
              </ToolbarButton>
              <ToolbarButton
                testId="open-deploy-key"
                iconOnly
                disabled={!connected}
                icon={<KeyRound size={13} />}
                onClick={() => {
                  setDeploying(true)
                }}
              >
                {t('Deploy key')}
              </ToolbarButton>
              <ToolbarButton
                testId="toggle-sftp"
                disabled={view === 'files'}
                pressed={panel === 'sftp'}
                icon={<FolderOpen size={13} />}
                onClick={() => {
                  setPanel(panel === 'sftp' ? null : 'sftp')
                }}
              >
                SFTP
              </ToolbarButton>
              <ToolbarButton
                testId="toggle-forwards"
                pressed={panel === 'forwards'}
                icon={<ArrowLeftRight size={13} />}
                onClick={() => {
                  setPanel(panel === 'forwards' ? null : 'forwards')
                }}
              >
                {activeForwards > 0
                  ? t('Forwarding ({count})', { count: formatNumber(activeForwards) })
                  : t('Forwarding')}
              </ToolbarButton>
            </>
          )}
          <ToolbarButton
            testId="session-focus"
            iconOnly
            icon={<Maximize2 size={14} />}
            onClick={() => {
              useShell.getState().setFocus(true)
            }}
          >
            {t('Focus mode: only the terminal')}
          </ToolbarButton>
        </div>
      )}
      {detected.length > 0 && (
        <ModuleSuggestion
          candidates={detected}
          where={t('on {name}', {
            name: useTabs.getState().tabs.find((x) => x.id === tabId)?.title ?? t('this server')
          })}
        />
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 bg-terminal">
            <FindBar tabId={tabId} />
            {view === 'files' && (
              <div
                ref={filesRef}
                tabIndex={-1}
                className="absolute inset-0 z-10 flex bg-surface outline-none"
                data-testid="file-manager"
              >
                <LocalPanel
                  transfers={transfers}
                  actionsRef={sftpActions}
                  onTargetChange={setLocalTarget}
                />
                <SftpPanel
                  run={runSftp}
                  transfers={transfers}
                  connected={connected}
                  layout="pane"
                  localTarget={localTarget}
                  actionsRef={sftpActions}
                  origin={sftpOrigin}
                />
                {prompt && !multiExec && (
                  <PromptDialog
                    prompt={prompt}
                    onAnswer={(ok, answers) => {
                      controllers.get(tabId)?.answerPrompt(prompt.id, ok, answers)
                    }}
                  />
                )}
              </div>
            )}
            <div
              ref={ref}
              data-testid={`terminal-${tabId}`}
              className="absolute inset-0 pt-2 pr-1 pb-1 pl-3"
            />
            {prompt && !multiExec && view === 'terminal' && (
              <PromptDialog
                prompt={prompt}
                onAnswer={(ok, answers) => {
                  controllers.get(tabId)?.answerPrompt(prompt.id, ok, answers)
                }}
              />
            )}
          </div>
        </div>
        {deploying && (
          <DeployKeyDialog
            onClose={() => {
              setDeploying(false)
            }}
            deploy={(publicKey) =>
              controllers.get(tabId)?.deployKey(publicKey) ??
              Promise.resolve({ status: 'error' as const, message: t('The tab was closed') })
            }
          />
        )}
        {panel === 'sftp' && (
          <SftpPanel
            run={runSftp}
            transfers={transfers}
            connected={connected}
            origin={sftpOrigin}
          />
        )}
        {panel === 'forwards' && (
          <ForwardsPanel
            hostId={target.kind === 'host' ? target.hostId : null}
            statuses={forwards}
            connected={connected}
            actions={{
              start: (spec) => controllers.get(tabId)?.startForward(spec),
              stop: (id) => controllers.get(tabId)?.stopForward(id),
              remove: (id) => controllers.get(tabId)?.removeForward(id)
            }}
          />
        )}
      </div>
    </div>
  )
}

function ToolbarButton({
  testId,
  pressed,
  disabled,
  icon,
  iconOnly,
  onClick,
  children
}: {
  testId: string
  pressed?: boolean
  disabled?: boolean
  icon: React.ReactNode
  /** Chỉ icon (tên ở tooltip) — như thanh phiên của thiết kế v0.5; SFTP / Forwards giữ chữ. */
  iconOnly?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      // Nhãn có thể bị ẩn khi ô hẹp → vẫn giữ tên cho trình đọc màn hình và tooltip.
      aria-label={typeof children === 'string' ? children : undefined}
      title={typeof children === 'string' ? children : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      className={cx(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-ds-sm font-medium',
        iconOnly ? 'w-6 justify-center' : 'px-2',
        ' transition-colors duration-(--ds-dur-fast) outline-none focus-visible:shadow-ds-focus disabled:opacity-40 [&_svg]:text-faint',
        pressed
          ? 'bg-ds-active text-fg [&_svg]:text-fg'
          : 'text-muted hover:bg-ds-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      {!iconOnly && <span className="hidden @lg:inline">{children}</span>}
    </button>
  )
}

/** Giữ chỗ thanh số liệu; server không trả lời (treo, chặn exec im lặng) → thôi hiện sau 20 giây. */
function StatsLoading(): React.JSX.Element | null {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setExpired(true)
    }, 20_000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [])
  return expired ? null : <ServerStatsPlaceholder inline />
}

/** "just now", "4 min", "1 h 05 min" — thời gian từ lúc phiên vào được server. */
function SessionClock(): React.JSX.Element {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 15_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  const s = Math.floor((now - start) / 1000)
  const minutes = Math.floor(s / 60)
  const text =
    s < 60
      ? t('just now')
      : minutes < 60
        ? t('{n} min', { n: formatNumber(minutes) })
        : t('{h} h {m} min', {
            h: formatNumber(Math.floor(minutes / 60)),
            m: String(minutes % 60).padStart(2, '0')
          })
  return (
    <span
      className="hidden text-faint tabular-nums @sm:inline"
      data-testid="session-clock"
      title={t('Connected since {time}', { time: formatTime(start, false) })}
    >
      · {text}
    </span>
  )
}
