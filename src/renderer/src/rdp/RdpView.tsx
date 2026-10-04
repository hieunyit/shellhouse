import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent
} from 'react'
import {
  ClipboardPaste,
  Command,
  Expand,
  Keyboard,
  Loader2,
  Lock,
  MonitorSmartphone,
  Plug,
  RotateCw,
  Shrink,
  ShieldAlert,
  ShieldQuestion,
  Unplug
} from 'lucide-react'
import { t } from '@shared/i18n'
import { formatDateTime, formatDuration } from '@shared/i18n/format'
import { PasswordInput } from '../components/PasswordInput'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Notice,
  Segmented,
  StatusDot,
  type ConnectionState
} from '../components/ui'
import { PromptDialog } from '../terminal/PromptDialog'
import { useTabStatus } from '../stores/tab-status'
import { useTabs } from '../stores/tabs'
import { openRdpHost } from '../stores/rdp'
import { toast } from '../stores/toasts'
import { RdpController, tlsLabel, type RdpScale, type RdpViewState } from './controller'
import { rdpControllers } from './registry'

const dotOf: Record<RdpViewState['phase'], ConnectionState> = {
  preparing: 'connecting',
  tunnel: 'connecting',
  certificate: 'connecting',
  credentials: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected'
}

function useController(c: RdpController): RdpViewState {
  return useSyncExternalStore(c.subscribe, c.getState)
}

/** Tab Remote Desktop: thanh công cụ, màn hình từ xa (canvas IronRDP), thanh trạng thái. */
export function RdpView({
  tabId,
  hostId,
  active,
  visible
}: {
  tabId: string
  hostId: string
  active: boolean
  visible: boolean
}): React.JSX.Element {
  const [controller] = useState(
    () =>
      new RdpController(hostId, useTabs.getState().tabs.find((x) => x.id === tabId)?.title ?? '')
  )
  const state = useController(controller)
  const rootRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [area, setArea] = useState({ width: 0, height: 0 })
  const [fullScreen, setFullScreen] = useState(false)
  const [captureKeys, setCaptureKeys] = useState(true)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const el = areaRef.current
    if (!canvas || !el) return
    controller.attach(canvas, el)
    rdpControllers.set(tabId, controller)
    controller.start()
    const observer = new ResizeObserver(() => {
      setArea({ width: el.clientWidth, height: el.clientHeight })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      rdpControllers.delete(tabId)
      // Đóng tab = ngắt kết nối.
      controller.dispose()
      useTabStatus.getState().remove(tabId)
    }
  }, [controller, tabId])

  useEffect(() => {
    useTabStatus.getState().set(tabId, dotOf[state.phase])
  }, [tabId, state.phase])

  // Tab ẩn / mất active: nhả phím đang giữ; active lại thì trả focus cho màn hình từ xa.
  useEffect(() => {
    if (!active || !visible) controller.releaseInputs()
    else if (state.phase === 'connected') controller.focus()
  }, [active, visible, controller, state.phase])

  useEffect(() => {
    const onChange = (): void => {
      setFullScreen(document.fullscreenElement === rootRef.current && rootRef.current !== null)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
    }
  }, [])

  const toggleFullScreen = (): void => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else
      void root.requestFullscreen({ navigationUI: 'hide' }).then(
        () => {
          controller.focus()
        },
        () => {
          toast.error(t('Could not switch to full screen'))
        }
      )
  }

  const connected = state.phase === 'connected'
  const canvasStyle = canvasSize(state, area)

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-terminal text-fg"
      data-testid="rdp-view"
      data-phase={state.phase}
      data-rdp-keyboard={captureKeys ? 'capture' : 'app'}
    >
      <Toolbar
        state={state}
        controller={controller}
        fullScreen={fullScreen}
        captureKeys={captureKeys}
        onCaptureKeys={setCaptureKeys}
        onFullScreen={toggleFullScreen}
      />
      <div
        ref={areaRef}
        className={cx(
          'relative min-h-0 flex-1 bg-black',
          state.scale === 'actual' && connected ? 'overflow-auto' : 'overflow-hidden'
        )}
      >
        <div
          className={cx(
            'flex min-h-full min-w-full',
            state.scale === 'fit' || !connected ? 'items-center justify-center' : 'items-start'
          )}
          style={
            state.scale === 'actual' && canvasStyle
              ? { width: canvasStyle.width, height: canvasStyle.height }
              : undefined
          }
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            data-testid="rdp-view-canvas"
            aria-label={t('Remote desktop of {name}', { name: state.label })}
            className={cx('block outline-none', !connected && 'invisible')}
            style={canvasStyle ?? { width: 0, height: 0 }}
          />
        </div>
        {!connected && <Overlay state={state} controller={controller} hostId={hostId} />}
        {state.prompt && (
          <div className="absolute inset-0 z-10">
            <PromptDialog
              prompt={state.prompt}
              onAnswer={(ok, answers) => {
                if (state.prompt) controller.answerPrompt(state.prompt.id, ok, answers)
              }}
            />
          </div>
        )}
      </div>
      <StatusBar state={state} active={active && visible} />
    </div>
  )
}

/** Kích thước CSS của canvas: vừa khung (giữ tỉ lệ) hoặc 100% (1 pixel từ xa = 1 pixel màn hình). */
function canvasSize(
  state: RdpViewState,
  area: { width: number; height: number }
): { width: number; height: number } | null {
  const d = state.desktop
  if (!d || area.width === 0 || area.height === 0) return null
  const dpr = window.devicePixelRatio || 1
  if (state.scale === 'actual') return { width: d.width / dpr, height: d.height / dpr }
  const k = Math.min(area.width / d.width, area.height / d.height)
  return { width: Math.floor(d.width * k), height: Math.floor(d.height * k) }
}

function Toolbar({
  state,
  controller,
  fullScreen,
  captureKeys,
  onCaptureKeys,
  onFullScreen
}: {
  state: RdpViewState
  controller: RdpController
  fullScreen: boolean
  captureKeys: boolean
  onCaptureKeys: (value: boolean) => void
  onFullScreen: () => void
}): React.JSX.Element {
  const connected = state.phase === 'connected'
  const scales: { value: RdpScale; label: string }[] = [
    { value: 'fit', label: t('Fit') },
    { value: 'actual', label: '100%' }
  ]
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-2"
      role="toolbar"
      aria-label={t('Remote Desktop')}
    >
      <span className="flex min-w-0 items-center gap-2 pr-2">
        <MonitorSmartphone size={15} className="shrink-0 text-muted" aria-hidden />
        <span className="truncate text-[13px] font-medium">{state.label}</span>
        {state.address && (
          <span className="hidden truncate text-xs text-faint sm:inline">
            {state.via
              ? t('{address} via {via}', { address: state.address, via: state.via })
              : state.address}
          </span>
        )}
      </span>
      <span className="flex-1" />
      <IconButton
        size="md"
        label={t('Send Ctrl+Alt+Del')}
        data-testid="rdp-view-cad"
        disabled={!connected}
        onClick={() => {
          controller.sendCtrlAltDel()
        }}
      >
        <span className="text-[10px] font-semibold tracking-tight">CAD</span>
      </IconButton>
      <IconButton
        label={t('Send the Windows key')}
        disabled={!connected}
        onClick={() => {
          controller.sendWindowsKey()
        }}
      >
        <Command size={15} />
      </IconButton>
      <IconButton
        label={
          state.clipboard
            ? t('Send clipboard text to the remote computer')
            : t('Clipboard sharing is turned off for this host')
        }
        data-testid="rdp-view-send-clipboard"
        disabled={!connected || !state.clipboard}
        onClick={() => {
          void controller.pushClipboard(true).then((sent) => {
            if (sent) toast.info(t('Clipboard sent'), { group: 'rdp-clipboard', duration: 1500 })
            controller.focus()
          })
        }}
      >
        <ClipboardPaste size={15} />
      </IconButton>
      <IconButton
        label={
          captureKeys
            ? t('Keyboard shortcuts go to the remote computer — click to keep Shellhouse shortcuts')
            : t('Shellhouse shortcuts are active — click to send all keys to the remote computer')
        }
        active={captureKeys}
        data-testid="rdp-view-capture-keys"
        onClick={() => {
          onCaptureKeys(!captureKeys)
          controller.focus()
        }}
      >
        <Keyboard size={15} />
      </IconButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <Segmented
        value={state.scale}
        options={scales}
        testIdPrefix="rdp-view-scale"
        onChange={(value) => {
          controller.setScale(value)
          controller.focus()
        }}
      />
      <IconButton
        label={fullScreen ? t('Exit full screen') : t('Full screen')}
        data-testid="rdp-view-fullscreen"
        onClick={onFullScreen}
      >
        {fullScreen ? <Shrink size={15} /> : <Expand size={15} />}
      </IconButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      {state.phase === 'disconnected' ? (
        <Button
          size="sm"
          variant="primary"
          icon={<RotateCw size={13} />}
          data-testid="rdp-view-reconnect"
          onClick={() => {
            controller.reconnect()
          }}
        >
          {t('Reconnect')}
        </Button>
      ) : (
        <Button
          size="sm"
          icon={<Unplug size={13} />}
          data-testid="rdp-view-disconnect"
          onClick={() => {
            controller.disconnect()
          }}
        >
          {connected ? t('Disconnect') : t('Cancel')}
        </Button>
      )}
    </div>
  )
}

function Card({
  children,
  testId,
  wide
}: {
  children: React.ReactNode
  testId: string
  wide?: boolean
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-terminal p-6">
      <div
        data-testid={testId}
        className={cx(
          'shadow-elevated animate-dialog-in w-full rounded-xl border border-line bg-elevated p-5',
          wide ? 'max-w-lg' : 'max-w-sm'
        )}
      >
        {children}
      </div>
    </div>
  )
}

function Overlay({
  state,
  controller,
  hostId
}: {
  state: RdpViewState
  controller: RdpController
  hostId: string
}): React.JSX.Element | null {
  switch (state.phase) {
    case 'certificate':
      return state.probe ? <CertificateCard state={state} controller={controller} /> : null
    case 'credentials':
      return state.credentials ? <CredentialsCard state={state} controller={controller} /> : null
    case 'disconnected':
      return <DisconnectedCard state={state} controller={controller} hostId={hostId} />
    default:
      return (
        <Card testId="rdp-view-progress">
          <div className="flex items-center gap-3">
            <Loader2 size={18} className="shrink-0 animate-spin text-accent" aria-hidden />
            <div className="min-w-0">
              <p className="text-[13px] font-medium">
                {t('Connecting to {name}…', { name: state.label })}
              </p>
              <p
                className="sh-selectable truncate text-xs text-muted"
                data-testid="rdp-view-detail"
              >
                {state.detail ?? t('Preparing…')}
              </p>
            </div>
          </div>
        </Card>
      )
  }
}

function CertificateCard({
  state,
  controller
}: {
  state: RdpViewState
  controller: RdpController
}): React.JSX.Element | null {
  const probe = state.probe
  if (!probe) return null
  const changed = probe.status === 'changed'
  const rows: [string, string][] = [
    [t('Subject'), probe.cert.subject || '—'],
    [t('Issuer'), probe.cert.selfSigned ? t('Self-signed') : probe.cert.issuer || '—'],
    [
      t('Valid'),
      t('{from} to {to}', {
        from: formatDateTime(probe.cert.validFrom),
        to: formatDateTime(probe.cert.validTo)
      })
    ]
  ]
  return (
    <Card testId="rdp-view-certificate" wide>
      <div className="flex items-start gap-3">
        <span
          className={cx(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            changed ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning'
          )}
        >
          {changed ? <ShieldAlert size={18} /> : <ShieldQuestion size={18} />}
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">
            {changed
              ? t('The server certificate has changed')
              : t('Trust this Remote Desktop server?')}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {changed
              ? t(
                  'The certificate of {address} is different from the one you trusted before. This can happen after the server was reinstalled or its certificate renewed — or someone may be intercepting the connection.',
                  { address: state.address }
                )
              : t(
                  'This is the first connection to {address}. Check that the fingerprint matches the server before you sign in.',
                  { address: state.address }
                )}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-faint">{k}</dt>
            <dd className="sh-selectable min-w-0 break-words text-fg">{v}</dd>
          </div>
        ))}
        <dt className="text-faint">{t('Fingerprint')}</dt>
        <dd
          className="sh-selectable font-mono text-[11px] leading-relaxed break-all text-fg"
          data-testid="rdp-view-cert-fingerprint"
        >
          SHA-256 {probe.cert.fingerprint}
        </dd>
        {changed && probe.known && (
          <>
            <dt className="text-faint">{t('Trusted before')}</dt>
            <dd className="sh-selectable font-mono text-[11px] leading-relaxed break-all text-muted">
              SHA-256 {probe.known}
            </dd>
          </>
        )}
      </dl>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          size="sm"
          autoFocus
          onClick={() => {
            controller.answerCertificate(false)
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          size="sm"
          variant={changed ? 'danger' : 'primary'}
          data-testid="rdp-view-cert-trust"
          onClick={() => {
            controller.answerCertificate(true)
          }}
        >
          {changed ? t('Trust the new certificate') : t('Trust and connect')}
        </Button>
      </div>
    </Card>
  )
}

function CredentialsCard({
  state,
  controller
}: {
  state: RdpViewState
  controller: RdpController
}): React.JSX.Element | null {
  const request = state.credentials
  const [username, setUsername] = useState(request?.username ?? '')
  const [domain, setDomain] = useState(request?.domain ?? '')
  const [password, setPassword] = useState('')
  const [save, setSave] = useState(false)
  if (!request) return null
  const submit = (e: SyntheticEvent): void => {
    e.preventDefault()
    if (!password || !username.trim()) return
    controller.submitCredentials({
      username: username.trim(),
      domain: domain.trim(),
      password,
      save
    })
    setPassword('')
  }
  return (
    <Card testId="rdp-view-credentials">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div>
          <h2 className="text-[14px] font-semibold">
            {t('Sign in to {name}', { name: state.label })}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{state.address}</p>
        </div>
        {request.error && <Notice tone="danger">{request.error}</Notice>}
        <Field label={t('Username')}>
          <Input
            autoFocus={request.askUsername || !username}
            value={username}
            data-testid="rdp-view-username"
            placeholder={t('user or DOMAIN\\user')}
            spellCheck={false}
            onChange={(e) => {
              setUsername(e.target.value)
            }}
          />
        </Field>
        <Field label={t('Domain (optional)')}>
          <Input
            value={domain}
            spellCheck={false}
            onChange={(e) => {
              setDomain(e.target.value)
            }}
          />
        </Field>
        <Field label={t('Password')}>
          <PasswordInput
            autoFocus={!request.askUsername && !!username}
            value={password}
            data-testid="rdp-view-password-input"
            onChange={(e) => {
              setPassword(e.target.value)
            }}
          />
        </Field>
        <Checkbox
          checked={save}
          label={t('Save password in vault')}
          onChange={(e) => {
            setSave(e.target.checked)
          }}
        />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            onClick={() => {
              controller.submitCredentials(null)
            }}
          >
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            type="submit"
            icon={<Plug size={13} />}
            disabled={!password || !username.trim()}
            data-testid="rdp-view-credentials-submit"
          >
            {t('Connect')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function DisconnectedCard({
  state,
  controller,
  hostId
}: {
  state: RdpViewState
  controller: RdpController
  hostId: string
}): React.JSX.Element {
  const failed = state.error !== null && !state.userClosed
  return (
    <Card testId="rdp-view-disconnected">
      <div className="flex items-start gap-3">
        <StatusDot state={failed ? 'disconnected' : 'exited'} className="mt-1.5 size-2" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">
            {failed ? t('Could not connect to {name}', { name: state.label }) : t('Disconnected')}
          </p>
          {state.error && (
            <p
              className={cx(
                'sh-selectable mt-1 text-xs break-words',
                failed ? 'text-danger' : 'text-muted'
              )}
              data-testid="rdp-view-error"
            >
              {state.error.message}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCw size={13} />}
              onClick={() => {
                controller.reconnect()
              }}
            >
              {t('Reconnect')}
            </Button>
            {state.error?.external && (
              <Button
                size="sm"
                onClick={() => {
                  openRdpHost(hostId, { external: true })
                }}
              >
                {t('Open in external client')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

function StatusBar({ state, active }: { state: RdpViewState; active: boolean }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const connected = state.phase === 'connected'
  useEffect(() => {
    if (!connected || !active) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [connected, active])
  const label: Record<RdpViewState['phase'], string> = {
    preparing: t('Preparing…'),
    tunnel: t('Opening SSH tunnel…'),
    certificate: t('Waiting for you to check the certificate'),
    credentials: t('Waiting for credentials'),
    connecting: t('Connecting…'),
    connected: t('Connected'),
    disconnected: t('Disconnected')
  }
  return (
    <div
      className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-muted"
      data-testid="rdp-view-status"
    >
      <span className="flex items-center gap-1.5">
        <StatusDot state={dotOf[state.phase]} />
        {label[state.phase]}
      </span>
      {connected && state.desktop && (
        <span data-testid="rdp-view-resolution">
          {state.desktop.width}×{state.desktop.height}
        </span>
      )}
      {connected && (
        <span
          className="flex items-center gap-1"
          data-testid="rdp-view-tls"
          title={
            state.tls?.legacyRsa
              ? t(
                  'Encrypted with TLS 1.2 using RSA key exchange ({cipher}): the server certificate does not allow modern key exchange, as is usual for Windows. Server certificate verified',
                  { cipher: state.tls.cipher }
                )
              : t('Encrypted with TLS; server certificate verified')
          }
        >
          <Lock size={10} aria-hidden />
          {tlsLabel(state.tls)}
        </span>
      )}
      {state.via && <span>{t('via {via}', { via: state.via })}</span>}
      <span className="flex-1" />
      {connected && state.connectedAt !== null && (
        <span className="tabular-nums">{formatDuration(Math.max(0, now - state.connectedAt))}</span>
      )}
    </div>
  )
}
