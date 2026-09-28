import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { ArrowLeftRight, FolderOpen, KeyRound } from 'lucide-react'
import { cx } from '../components/ui'
import type { ForwardStatus } from '@shared/forwards'
import { useTabs, type TabTarget } from '../stores/tabs'
import { TerminalController, type ActivePrompt } from './controller'
import { ForwardsPanel } from './ForwardsPanel'
import { SftpPanel } from './SftpPanel'
import { DeployKeyDialog } from './DeployKeyDialog'
import type { SftpOp, TransferStatus } from '@shared/sftp'
import { PromptDialog } from './PromptDialog'
import { controllers } from './registry'

type Panel = 'forwards' | 'sftp' | null

export function TerminalView({
  tabId,
  target,
  active
}: {
  tabId: string
  target: TabTarget
  active: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null)
  const [forwards, setForwards] = useState<ForwardStatus[]>([])
  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [connected, setConnected] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [deploying, setDeploying] = useState(false)
  const isRemote = target.kind !== 'local'
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
      onPrompt: setPrompt,
      onForwards: setForwards,
      onTransfers: setTransfers,
      onConnectedChange: setConnected,
      onCleanExit: () => {
        useTabs.getState().close(tabId)
      }
    })
    controllers.set(tabId, controller)
    controller.start()
    return () => {
      controllers.delete(tabId)
      controller.dispose()
    }
    // target không đổi trong suốt vòng đời một tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    if (active && !prompt) controllers.get(tabId)?.activate()
  }, [active, tabId, prompt, panel])

  const activeForwards = forwards.filter((f) => f.state === 'active').length

  return (
    <div className="flex h-full flex-col">
      {isRemote && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-surface px-2 text-xs">
          <span className={cx('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-faint')} />
          <span className="text-muted">{connected ? 'Connected' : 'Not connected'}</span>
          <div className="flex-1" />
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
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-terminal">
          <div ref={ref} data-testid={`terminal-${tabId}`} className="absolute inset-0 px-2 pt-1" />
          {prompt && (
            <PromptDialog
              prompt={prompt}
              onAnswer={(ok, answers) => {
                controllers.get(tabId)?.answerPrompt(prompt.id, ok, answers)
              }}
            />
          )}
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
      aria-pressed={pressed}
      disabled={disabled}
      className={cx(
        'inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-medium disabled:opacity-40',
        pressed ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  )
}
