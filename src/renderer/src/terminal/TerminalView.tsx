import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { ArrowLeftRight, Columns2, FolderOpen, KeyRound } from 'lucide-react'
import { LocalPanel } from './LocalPanel'
import type { LocalTarget, SftpActions } from './SftpPanel'
import { connectionLabel, cx, StatusDot } from '../components/ui'
import type { ForwardStatus } from '@shared/forwards'
import { hostBorderClass, hostTileClass } from '../components/hostColors'
import { useHosts } from '../stores/hosts'
import { useTabStatus } from '../stores/tab-status'
import { useBroadcast } from './broadcast'
import { useTerminalMenu } from './TerminalMenu'
import { useTabs, type TerminalTarget } from '../stores/tabs'
import { TerminalController, type ActivePrompt } from './controller'
import { DeployKeyDialog, ForwardsPanel, SftpPanel } from '../lazy'
import type { SftpOp, TransferStatus } from '@shared/sftp'
import type { ServerStats } from '@shared/server-stats'
import { PromptDialog } from './PromptDialog'
import { ServerStatsBar } from './ServerStatsBar'
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
  const [connected, setConnected] = useState(false)
  /** Module có dấu hiệu trên server này (gợi ý bật). */
  const [detected, setDetected] = useState<string[]>([])
  /** undefined = chưa có số liệu / tắt; null = server không hỗ trợ. */
  const [stats, setStats] = useState<ServerStats | null | undefined>(undefined)
  /** 'files' = trình quản lý file hai cột (Local | Remote); terminal vẫn chạy phía sau. */
  const [view, setViewState] = useState<'terminal' | 'files'>(
    () => useTabs.getState().tabs.find((t) => t.id === tabId)?.view ?? 'terminal'
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
    () => useTabs.getState().tabs.find((t) => t.id === tabId)?.initialPanel ?? null
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
  const state = useTabStatus((s) => s.byTab[tabId] ?? 'idle')
  const runSftp = useCallback(
    (op: SftpOp) =>
      controllers.get(tabId)?.sftp(op) ?? Promise.reject(new Error('The tab was closed')),
    [tabId]
  )

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
      onTransfers: setTransfers,
      onStats: setStats,
      onConnectedChange: setConnected,
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

  useEffect(() => {
    if (active && !prompt) controllers.get(tabId)?.activate()
  }, [active, tabId, prompt, panel])

  const activeForwards = forwards.filter((f) => f.state === 'active').length

  return (
    <div className="flex h-full flex-col">
      {isRemote && (
        <div
          className={cx(
            // @container: ô hẹp (lưới, chia màn hình) → chỉ còn icon, không vỡ dòng.
            '@container flex h-8 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-surface px-2 text-xs whitespace-nowrap',
            env?.color && 'border-t-2',
            env?.color && hostBorderClass[env.color]
          )}
          data-env-color={env?.color ?? ''}
        >
          <span className="flex items-center gap-2 pl-1" data-testid="session-state">
            <StatusDot state={state} />
            <span className="hidden text-muted @xs:inline">{connectionLabel[state]}</span>
          </span>
          {protocol === 'telnet' && (
            <span
              className="ml-2 shrink-0 rounded bg-warning-soft px-1.5 py-px text-xs font-medium text-warning"
              data-testid="session-telnet"
              title="Telnet sends everything, including passwords, in clear text"
            >
              Telnet · not encrypted
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
              title="Legacy algorithms are allowed for this host (weaker security)"
            >
              Legacy
            </span>
          )}
          {env?.path && (
            <span
              className={cx(
                'ml-2 hidden min-w-0 truncate rounded px-1.5 py-px text-xs font-medium @md:inline',
                env.color ? hostTileClass[env.color] : 'bg-subtle text-muted'
              )}
              data-testid="session-group-path"
              title="Group"
            >
              {env.path}
            </span>
          )}
          <div className="flex-1" />
          {isSsh && (
            <>
              <ToolbarButton
                testId="toggle-files"
                pressed={view === 'files'}
                icon={<Columns2 size={13} />}
                onClick={() => {
                  setView(view === 'files' ? 'terminal' : 'files')
                  if (panel === 'sftp') setPanel(null)
                }}
              >
                {view === 'files' ? 'Show terminal' : 'File manager'}
              </ToolbarButton>
              <ToolbarButton
                testId="open-deploy-key"
                disabled={!connected}
                icon={<KeyRound size={13} />}
                onClick={() => {
                  setDeploying(true)
                }}
              >
                Deploy key
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
                Forwarding{activeForwards > 0 ? ` (${activeForwards})` : ''}
              </ToolbarButton>
            </>
          )}
        </div>
      )}
      {detected.length > 0 && (
        <ModuleSuggestion
          candidates={detected}
          where={`on ${useTabs.getState().tabs.find((t) => t.id === tabId)?.title ?? 'this server'}`}
        />
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 bg-terminal">
            {view === 'files' && (
              <div className="absolute inset-0 z-10 flex bg-surface" data-testid="file-manager">
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
          {stats && <ServerStatsBar stats={stats} />}
        </div>
        {deploying && (
          <DeployKeyDialog
            onClose={() => {
              setDeploying(false)
            }}
            deploy={(publicKey) =>
              controllers.get(tabId)?.deployKey(publicKey) ??
              Promise.resolve({ status: 'error' as const, message: 'The tab was closed' })
            }
          />
        )}
        {panel === 'sftp' && (
          <SftpPanel run={runSftp} transfers={transfers} connected={connected} />
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
  onClick,
  children
}: {
  testId: string
  pressed?: boolean
  disabled?: boolean
  icon: React.ReactNode
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
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium transition-colors duration-150 disabled:opacity-40',
        pressed ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      <span className="hidden @lg:inline">{children}</span>
    </button>
  )
}
