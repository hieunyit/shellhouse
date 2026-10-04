import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent
} from 'react'
import {
  Expand,
  Keyboard,
  Loader2,
  MonitorSmartphone,
  Plug,
  RotateCw,
  Shrink,
  Unplug
} from 'lucide-react'
import { t } from '@shared/i18n'
import { formatDuration } from '@shared/i18n/format'
import type { RdpNativeOverlay, RdpNativeViewport } from '@shared/rdp-native'
import { PasswordInput } from '../components/PasswordInput'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  StatusDot,
  type ConnectionState
} from '../components/ui'
import { PromptDialog } from '../terminal/PromptDialog'
import { useTabStatus } from '../stores/tab-status'
import { useTabs } from '../stores/tabs'
import { openRdpHost } from '../stores/rdp'
import { toast } from '../stores/toasts'
import { NativeRdpController, type NativeRdpState } from './controller'
import { setTabEngine } from './engine'
import { collectOverlayRects, OVERLAY_ATTRIBUTES, planOverlay, sameOverlay } from './overlay'
import { nativeRdpControllers } from './registry'

const dotOf: Record<NativeRdpState['phase'], ConnectionState> = {
  preparing: 'connecting',
  tunnel: 'connecting',
  credentials: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected'
}

function useController(c: NativeRdpController): NativeRdpState {
  return useSyncExternalStore(c.subscribe, c.getState)
}

/**
 * Tab Remote Desktop bằng control gốc của Windows: vùng giữ chỗ (div) mà cửa sổ native của control
 * nằm đè lên đúng vị trí — đo bằng ResizeObserver / IntersectionObserver (gộp theo khung hình) và báo
 * main. Lớp phủ của app đè lên vùng này → khoét lỗ / ẩn cửa sổ native, hiện ảnh chụp thay vào.
 *
 * Khi control giữ bàn phím, phím tắt của Shellhouse không tới được app (cửa sổ khác tiến trình) —
 * bấm vào bất kỳ đâu trong Shellhouse (thanh công cụ, thanh tab) để lấy lại bàn phím.
 */
export function RdpNativeView({
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
      new NativeRdpController(
        hostId,
        useTabs.getState().tabs.find((x) => x.id === tabId)?.title ?? ''
      )
  )
  const state = useController(controller)
  const rootRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const [fullScreen, setFullScreen] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const intersecting = useRef(true)
  const frame = useRef(0)
  const connected = state.phase === 'connected'
  const shown = visible && connected

  // Đo vùng tab (CSS px trong cửa sổ) → main đổi sang pixel vật lý, đặt cửa sổ native.
  const measure = useCallback(() => {
    frame.current = 0
    const el = areaRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const viewport: RdpNativeViewport = {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      dpr: window.devicePixelRatio || 1,
      visible:
        visible &&
        intersecting.current &&
        document.visibilityState === 'visible' &&
        r.width > 0 &&
        r.height > 0
    }
    controller.setViewport(viewport)
  }, [controller, visible])
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(measure)
  }, [measure])

  useLayoutEffect(() => {
    nativeRdpControllers.set(tabId, controller)
    controller.start()
    return () => {
      nativeRdpControllers.delete(tabId)
      // Đóng tab = ngắt kết nối (tiến trình phụ thoát).
      controller.dispose()
      useTabStatus.getState().remove(tabId)
    }
  }, [controller, tabId])

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    measure()
    const resize = new ResizeObserver(schedule)
    resize.observe(el)
    // Vùng tab dời chỗ mà không đổi cỡ (thu thanh bên, kéo chia đôi màn hình…).
    resize.observe(document.documentElement)
    const intersection = new IntersectionObserver((entries) => {
      intersecting.current = entries.some((e) => e.isIntersecting)
      schedule()
    })
    intersection.observe(el)
    // Đổi màn hình khác DPI / zoom trang → devicePixelRatio đổi.
    let media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDpr = (): void => {
      media.removeEventListener('change', onDpr)
      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      media.addEventListener('change', onDpr)
      schedule()
    }
    media.addEventListener('change', onDpr)
    window.addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    document.addEventListener('transitionend', schedule, true)
    // Lưới an toàn: thay đổi bố cục không phát sự kiện nào ở trên.
    const timer = window.setInterval(schedule, 750)
    return () => {
      resize.disconnect()
      intersection.disconnect()
      media.removeEventListener('change', onDpr)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
      document.removeEventListener('transitionend', schedule, true)
      window.clearInterval(timer)
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [measure, schedule])

  useEffect(() => {
    useTabStatus.getState().set(tabId, dotOf[state.phase])
  }, [tabId, state.phase])

  // Tab active lại → bàn phím về máy từ xa (như trình xem IronRDP).
  useEffect(() => {
    if (active && visible && connected) controller.focus()
  }, [active, visible, connected, controller])

  // Lớp phủ của app đè lên vùng RDP → khoét lỗ / ẩn cửa sổ native (chụp ảnh trước để hiện thay).
  useEffect(() => {
    if (!shown) {
      controller.setOverlay({ mode: 'none' })
      return
    }
    let current: RdpNativeOverlay = { mode: 'none' }
    let raf = 0
    let clear = 0
    let disposed = false
    const scan = (): void => {
      raf = 0
      const el = areaRef.current
      if (!el || disposed) return
      const r = el.getBoundingClientRect()
      const plan = planOverlay(
        { x: r.left, y: r.top, width: r.width, height: r.height },
        collectOverlayRects(document, rootRef.current)
      )
      if (sameOverlay(plan, current)) return
      const before = current
      current = plan
      window.clearTimeout(clear)
      if (plan.mode === 'none') {
        controller.setOverlay(plan)
        // Đợi cửa sổ native vẽ lại rồi mới bỏ ảnh (khỏi chớp nền đen).
        clear = window.setTimeout(() => {
          setSnapshot(null)
        }, 150)
        return
      }
      if (before.mode !== 'none') {
        controller.setOverlay(plan)
        return
      }
      // Chụp TRƯỚC khi khoét lỗ / ẩn: ảnh không dính lớp phủ đang hiện dần. Chậm quá thì thôi.
      const late = new Promise<null>((resolve) => {
        window.setTimeout(() => {
          resolve(null)
        }, 250)
      })
      const shot = controller.snapshot()
      void Promise.race([shot, late]).then(() => {
        if (!disposed) controller.setOverlay(current)
      })
      void shot.then((image) => {
        if (!disposed && image && current.mode !== 'none') setSnapshot(image)
      })
    }
    const request = (): void => {
      if (!raf) raf = requestAnimationFrame(scan)
    }
    const mutations = new MutationObserver(request)
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OVERLAY_ATTRIBUTES
    })
    window.addEventListener('resize', request)
    const timer = window.setInterval(request, 1000)
    request()
    return () => {
      disposed = true
      mutations.disconnect()
      window.removeEventListener('resize', request)
      window.clearInterval(timer)
      window.clearTimeout(clear)
      if (raf) cancelAnimationFrame(raf)
      // Ảnh chụp cũ không còn đúng khi tab ẩn / mất kết nối.
      setSnapshot(null)
    }
  }, [shown, controller])

  useEffect(() => {
    schedule()
  }, [visible, connected, schedule])

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

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-terminal text-fg"
      data-testid="rdp-native-view"
      data-phase={state.phase}
      data-keyboard={state.keyboard ? 'remote' : 'app'}
    >
      <Toolbar
        state={state}
        controller={controller}
        fullScreen={fullScreen}
        onFullScreen={toggleFullScreen}
      />
      <div
        ref={areaRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        data-testid="rdp-native-area"
      >
        {connected && snapshot && (
          <img
            src={snapshot}
            alt=""
            draggable={false}
            data-testid="rdp-native-snapshot"
            className="pointer-events-none absolute inset-0 size-full select-none"
          />
        )}
        {!connected && (
          <Overlay
            state={state}
            controller={controller}
            onIronRdp={() => {
              setTabEngine(tabId, 'ironrdp')
            }}
            hostId={hostId}
          />
        )}
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

function Toolbar({
  state,
  controller,
  fullScreen,
  onFullScreen
}: {
  state: NativeRdpState
  controller: NativeRdpController
  fullScreen: boolean
  onFullScreen: () => void
}): React.JSX.Element {
  const connected = state.phase === 'connected'
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
        data-testid="rdp-native-cad"
        disabled={!connected}
        onClick={() => {
          controller.sendCtrlAltDel()
        }}
      >
        <span className="text-[10px] font-semibold tracking-tight">CAD</span>
      </IconButton>
      <IconButton
        label={
          state.keyboard
            ? t('The remote computer has the keyboard — click to give it back to Shellhouse')
            : t('Send the keyboard to the remote computer')
        }
        active={state.keyboard}
        data-testid="rdp-native-keyboard"
        disabled={!connected}
        onClick={(e) => {
          // Bấm nút đã đưa focus về Shellhouse; chỉ cần đưa sang máy từ xa khi đang ở app.
          if (state.keyboard) e.currentTarget.blur()
          else controller.focus()
        }}
      >
        <Keyboard size={15} />
      </IconButton>
      <IconButton
        label={fullScreen ? t('Exit full screen') : t('Full screen')}
        data-testid="rdp-native-fullscreen"
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
          data-testid="rdp-native-reconnect"
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
          data-testid="rdp-native-disconnect"
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

function Card({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-terminal p-6">
      <div
        data-testid={testId}
        className="shadow-elevated animate-dialog-in w-full max-w-sm rounded-xl border border-line bg-elevated p-5"
      >
        {children}
      </div>
    </div>
  )
}

function Overlay({
  state,
  controller,
  hostId,
  onIronRdp
}: {
  state: NativeRdpState
  controller: NativeRdpController
  hostId: string
  onIronRdp: () => void
}): React.JSX.Element | null {
  if (state.phase === 'credentials')
    return state.credentials ? <CredentialsCard state={state} controller={controller} /> : null
  if (state.phase === 'disconnected')
    return (
      <DisconnectedCard
        state={state}
        controller={controller}
        hostId={hostId}
        onIronRdp={onIronRdp}
      />
    )
  if (state.prompt) return null
  return (
    <Card testId="rdp-native-progress">
      <div className="flex items-center gap-3">
        <Loader2 size={18} className="shrink-0 animate-spin text-accent" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-medium">
            {t('Connecting to {name}…', { name: state.label })}
          </p>
          <p className="sh-selectable truncate text-xs text-muted" data-testid="rdp-native-detail">
            {state.detail ?? t('Preparing…')}
          </p>
        </div>
      </div>
    </Card>
  )
}

function CredentialsCard({
  state,
  controller
}: {
  state: NativeRdpState
  controller: NativeRdpController
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
    <Card testId="rdp-native-credentials">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div>
          <h2 className="text-[14px] font-semibold">
            {t('Sign in to {name}', { name: state.label })}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{state.address}</p>
        </div>
        <Field label={t('Username')}>
          <Input
            autoFocus={request.askUsername || !username}
            value={username}
            data-testid="rdp-native-username"
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
            data-testid="rdp-native-password"
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
            data-testid="rdp-native-credentials-submit"
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
  hostId,
  onIronRdp
}: {
  state: NativeRdpState
  controller: NativeRdpController
  hostId: string
  onIronRdp: () => void
}): React.JSX.Element {
  const failed = state.error !== null && !state.userClosed
  return (
    <Card testId="rdp-native-disconnected">
      <div className="flex items-start gap-3">
        <StatusDot state={failed ? 'disconnected' : 'exited'} className="mt-1.5 size-2" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">
            {failed ? t('Could not connect to {name}', { name: state.label }) : t('Disconnected')}
          </p>
          {state.error && (
            <p
              className={cx(
                'sh-selectable mt-1 text-xs break-words whitespace-pre-line',
                failed ? 'text-danger' : 'text-muted'
              )}
              data-testid="rdp-native-error"
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
            {/* IronRDP chưa hỗ trợ RD Gateway. */}
            {!state.gateway && (
              <Button size="sm" data-testid="rdp-native-ironrdp" onClick={onIronRdp}>
                {t('Open in IronRDP')}
              </Button>
            )}
            {state.error?.fallback && (
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

function StatusBar({
  state,
  active
}: {
  state: NativeRdpState
  active: boolean
}): React.JSX.Element {
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
  const label: Record<NativeRdpState['phase'], string> = {
    preparing: t('Preparing…'),
    tunnel: t('Opening SSH tunnel…'),
    credentials: t('Waiting for credentials'),
    connecting: t('Connecting…'),
    connected: t('Connected'),
    disconnected: t('Disconnected')
  }
  return (
    <div
      className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-muted"
      data-testid="rdp-native-status"
    >
      <span className="flex items-center gap-1.5">
        <StatusDot state={dotOf[state.phase]} />
        {label[state.phase]}
      </span>
      {connected && state.desktop && (
        <span data-testid="rdp-native-resolution">
          {state.desktop.width}×{state.desktop.height}
        </span>
      )}
      <span
        title={t(
          'Rendered by the Remote Desktop control of Windows (the engine of mstsc). Change it in the host settings.'
        )}
      >
        {t('Windows RDP')}
      </span>
      {state.via && <span>{t('via {via}', { via: state.via })}</span>}
      {state.gateway && <span>{t('Gateway {gateway}', { gateway: state.gateway })}</span>}
      <span className="flex-1" />
      {connected && state.keyboard && (
        <span className="flex items-center gap-1 text-fg" data-testid="rdp-native-keyboard-hint">
          <Keyboard size={11} aria-hidden />
          {t('Keyboard on the remote computer — click Shellhouse to use its shortcuts')}
        </span>
      )}
      {connected && state.connectedAt !== null && (
        <span className="tabular-nums">{formatDuration(Math.max(0, now - state.connectedAt))}</span>
      )}
    </div>
  )
}
