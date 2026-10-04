import { useState, type SyntheticEvent } from 'react'
import { MonitorSmartphone, X } from 'lucide-react'
import { t } from '@shared/i18n'
import {
  answerRdpPassword,
  answerRdpPrompt,
  disconnectRdp,
  retryRdp,
  useRdp,
  type RdpConnection
} from '../stores/rdp'
import { PromptDialog } from '../terminal/PromptDialog'
import { PasswordInput } from './PasswordInput'
import { Button, cx, IconButton, StatusDot, type ConnectionState } from './ui'

const dotState: Record<RdpConnection['phase'], ConnectionState> = {
  checking: 'connecting',
  password: 'connecting',
  tunnel: 'connecting',
  launching: 'connecting',
  running: 'connected',
  detached: 'connected',
  failed: 'disconnected'
}

function statusText(c: RdpConnection): string {
  const client = c.client ?? 'RDP'
  const address = c.tunnelPort ? `127.0.0.1:${c.tunnelPort}` : null
  switch (c.phase) {
    case 'checking':
      return t('Preparing…')
    case 'password':
      return t('Waiting for the password…')
    case 'tunnel':
      return c.detail
        ? t('Opening SSH tunnel via {via}: {detail}', { via: c.via ?? '?', detail: c.detail })
        : t('Opening SSH tunnel via {via}…', { via: c.via ?? '?' })
    case 'launching':
      return t('Starting {client}…', { client })
    case 'running':
      return address
        ? t('Connected via {client} (tunnel {address} via {via})', {
            client,
            address,
            via: c.via ?? '?'
          })
        : t('Connected via {client}', { client })
    case 'detached':
      return address
        ? t('Opened in {client} (tunnel {address} via {via})', {
            client,
            address,
            via: c.via ?? '?'
          })
        : t('Opened in {client}', { client })
    case 'failed':
      return c.error ?? t('Could not connect')
  }
}

function PasswordForm({ c }: { c: RdpConnection }): React.JSX.Element {
  const [value, setValue] = useState('')
  const submit = (e: SyntheticEvent): void => {
    e.preventDefault()
    if (!value) return
    answerRdpPassword(c.id, value)
    setValue('')
  }
  return (
    <form className="mt-2 flex flex-col gap-2" onSubmit={submit}>
      <PasswordInput
        autoFocus
        aria-label={t('Password')}
        data-testid="rdp-password"
        placeholder={
          c.username ? t('Password for {user}', { user: c.username }) : t('Password (not saved)')
        }
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') disconnectRdp(c.id)
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          onClick={() => {
            disconnectRdp(c.id)
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!value}
          data-testid="rdp-password-submit"
        >
          {t('Connect')}
        </Button>
      </div>
      <p className="text-xs text-faint">
        {t('Used for this connection only. Save it on the host to skip this step.')}
      </p>
    </form>
  )
}

function Card({ c }: { c: RdpConnection }): React.JSX.Element {
  const failed = c.phase === 'failed'
  return (
    <div
      role="status"
      data-testid="rdp-connection"
      data-phase={c.phase}
      data-host-label={c.label}
      className={cx(
        'shadow-elevated animate-dialog-in pointer-events-auto rounded-lg border bg-elevated px-3 py-2.5',
        failed ? 'border-danger/40' : 'border-line'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
          <MonitorSmartphone size={15} aria-hidden />
          <StatusDot
            state={dotState[c.phase]}
            className="absolute -right-0.5 -bottom-0.5 size-2 ring-2 ring-elevated"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[13px] font-medium text-fg">{c.label}</span>
            <span className="text-[11px] text-faint">· {t('Remote Desktop')}</span>
          </div>
          <p
            className={cx(
              'sh-selectable text-xs break-words',
              failed ? 'text-danger' : 'text-muted'
            )}
            data-testid="rdp-status"
          >
            {statusText(c)}
          </p>
          {c.hint && (failed || c.phase === 'running' || c.phase === 'detached') && (
            <p className="mt-1 text-xs text-muted" data-testid="rdp-hint">
              {c.hint}
            </p>
          )}
          {c.phase === 'detached' && (
            <p className="mt-1 text-xs text-faint">
              {c.tunnelPort
                ? t(
                    "Shellhouse can't tell when that window closes — disconnect here when you're done to close the tunnel."
                  )
                : t("Shellhouse can't tell when that window closes.")}
            </p>
          )}
          {c.phase === 'password' && <PasswordForm c={c} />}
          {c.phase !== 'password' && (
            <div className="mt-2 flex gap-2">
              {failed ? (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    data-testid="rdp-retry"
                    onClick={() => {
                      retryRdp(c.id)
                    }}
                  >
                    {t('Try again')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      disconnectRdp(c.id)
                    }}
                  >
                    {t('Dismiss')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  data-testid="rdp-disconnect"
                  onClick={() => {
                    disconnectRdp(c.id)
                  }}
                >
                  {c.phase === 'running' || c.phase === 'detached' ? t('Disconnect') : t('Cancel')}
                </Button>
              )}
            </div>
          )}
        </div>
        {(failed || c.phase === 'detached') && (
          <IconButton
            label={t('Close')}
            size="sm"
            onClick={() => {
              disconnectRdp(c.id)
            }}
          >
            <X size={13} />
          </IconButton>
        )}
      </div>
    </div>
  )
}

/** Thẻ trạng thái các phiên Remote Desktop (góc trên bên phải) + hộp hỏi của tunnel SSH. */
export function RdpConnections(): React.JSX.Element | null {
  const connections = useRdp((s) => s.connections)
  const prompting = connections.find((c) => c.prompt)
  if (connections.length === 0) return null
  return (
    <>
      <div
        className="pointer-events-none fixed top-12 right-3 z-[55] flex w-[22rem] flex-col gap-2"
        aria-label={t('Remote Desktop connections')}
        data-testid="rdp-connections"
      >
        {connections.map((c) => (
          <Card key={c.id} c={c} />
        ))}
      </div>
      {prompting?.prompt && (
        // Hộp hỏi của SSH (host key, mật khẩu của host trung gian) — cùng hộp với tab terminal.
        <div className="fixed inset-0 z-[56]">
          <PromptDialog
            prompt={prompting.prompt}
            onAnswer={(ok, answers) => {
              if (prompting.prompt) answerRdpPrompt(prompting.id, prompting.prompt.id, ok, answers)
            }}
          />
        </div>
      )}
    </>
  )
}
