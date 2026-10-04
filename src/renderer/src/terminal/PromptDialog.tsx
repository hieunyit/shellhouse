import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { useHosts } from '../stores/hosts'
import { ShieldAlert, ShieldQuestion } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PromptRequest } from '@shared/stream-protocol'
import { PasswordInput } from '../components/PasswordInput'
import { Button, Checkbox, Field, Input, useFocusTrap } from '../components/ui'
import {
  dropPending,
  passwordKey,
  promptTab,
  rememberAfterLogin,
  savedHostForPassword,
  takeRememberedPassphrase
} from '../stores/credentials'
import { useVault } from '../stores/vault'
import type { ActivePrompt } from './controller'

type Answer = (ok: boolean, answers: string[]) => void

/** Tuỳ chọn ghi nhớ dưới các ô nhập (lưu mật khẩu vào vault / nhớ passphrase trong phiên chạy). */
interface RememberOption {
  label: string
  description: string
  testId: string
  onSubmit: (values: string[]) => void
}

function Fields({
  fields,
  title,
  description,
  submitLabel,
  remember,
  onAnswer
}: {
  fields: { prompt: string; echo: boolean }[]
  title: string
  description?: string
  submitLabel: string
  remember?: RememberOption | null
  onAnswer: Answer
}): React.JSX.Element {
  const [values, setValues] = useState(() => fields.map(() => ''))
  const [keep, setKeep] = useState(false)
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault()
    if (remember && keep && values.some((v) => v !== '')) remember.onSubmit(values)
    onAnswer(true, values)
  }
  const change = (i: number, value: string): void => {
    const next = [...values]
    next[i] = value
    setValues(next)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold break-all">{title}</h2>
      {description && (
        <p className="text-xs break-all whitespace-pre-wrap text-muted">{description}</p>
      )}
      {fields.map((field, i) => (
        <Field key={i} label={field.prompt}>
          {field.echo ? (
            <Input
              type="text"
              autoFocus={i === 0}
              autoComplete="off"
              spellCheck={false}
              data-testid="prompt-input"
              value={values[i] ?? ''}
              onChange={(e) => {
                change(i, e.target.value)
              }}
            />
          ) : (
            <PasswordInput
              autoFocus={i === 0}
              data-testid="prompt-input"
              value={values[i] ?? ''}
              onChange={(e) => {
                change(i, e.target.value)
              }}
            />
          )}
        </Field>
      ))}
      {remember && (
        <Checkbox
          data-testid={remember.testId}
          checked={keep}
          onChange={(e) => {
            setKeep(e.target.checked)
          }}
          label={remember.label}
          description={remember.description}
        />
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button
          data-testid="prompt-cancel"
          onClick={() => {
            onAnswer(false, [])
          }}
        >
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="primary" data-testid="prompt-submit">
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

function HostKey({
  request,
  onAnswer
}: {
  request: Extract<PromptRequest, { kind: 'hostkey' }>
  onAnswer: Answer
}): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false)
  const { key, changedFrom } = request
  const where = key.port === 22 ? key.host : `${key.host}:${key.port}`

  if (changedFrom) {
    return (
      <div className="flex flex-col gap-3" data-testid="hostkey-changed">
        <div className="flex items-center gap-2 text-danger">
          <ShieldAlert size={20} />
          <h2 className="text-[15px] font-semibold">
            {t('The host key for {host} has changed', { host: where })}
          </h2>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          {t(
            'Someone could be intercepting this connection (a man-in-the-middle attack), or the server was reinstalled.'
          )}{' '}
          <strong className="text-fg">
            {t(
              'Do not continue until you have verified the new fingerprint with the server administrator.'
            )}
          </strong>
        </p>
        <div className="rounded-md border border-danger/30 bg-danger-soft p-3 font-mono text-xs leading-relaxed break-all">
          {changedFrom.map((k) => (
            <div key={k.fingerprint} className="text-muted">
              {t('Previous:')} {k.keyType} {k.fingerprint}
            </div>
          ))}
          <div className="text-danger">
            {t('New:')} {key.keyType} {key.fingerprint}
          </div>
        </div>
        <Checkbox
          data-testid="hostkey-confirm"
          checked={confirmed}
          onChange={(e) => {
            setConfirmed(e.target.checked)
          }}
          label={t('I have verified the new fingerprint with the server administrator.')}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button
            autoFocus
            variant="primary"
            data-testid="prompt-cancel"
            onClick={() => {
              onAnswer(false, [])
            }}
          >
            {t('Cancel connection')}
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed}
            data-testid="hostkey-accept"
            onClick={() => {
              onAnswer(true, [])
            }}
          >
            {t('Replace key and connect')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="hostkey-new">
      <div className="flex items-center gap-2">
        <ShieldQuestion size={20} className="text-accent" />
        <h2 className="text-[15px] font-semibold">{t('New host: {host}', { host: where })}</h2>
      </div>
      <p className="text-xs text-muted">
        {t(
          'This is the first connection to this host. Compare the fingerprint with the one from the administrator before trusting it.'
        )}
      </p>
      <div className="flex gap-4">
        <pre className="rounded-md border border-line bg-subtle p-2 font-mono text-xs leading-tight text-fg">
          {key.randomart}
        </pre>
        <div className="flex min-w-0 flex-col justify-center gap-1 font-mono text-xs break-all">
          <span className="text-muted">{key.keyType}</span>
          <span className="text-fg" data-testid="hostkey-fingerprint">
            {key.fingerprint}
          </span>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button
          data-testid="prompt-cancel"
          onClick={() => {
            onAnswer(false, [])
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          autoFocus
          variant="primary"
          data-testid="hostkey-accept"
          onClick={() => {
            onAnswer(true, [])
          }}
        >
          {t('Trust and connect')}
        </Button>
      </div>
    </div>
  )
}

function Body({
  prompt,
  onAnswer
}: {
  prompt: ActivePrompt
  onAnswer: Answer
}): React.JSX.Element | null {
  const request = prompt.request
  switch (request.kind) {
    case 'hostkey':
      return <HostKey request={request} onAnswer={onAnswer} />
    case 'password':
      return <PasswordPrompt prompt={prompt} request={request} onAnswer={onAnswer} />
    case 'passphrase':
      return <PassphrasePrompt prompt={prompt} request={request} onAnswer={onAnswer} />
    case 'keyboard-interactive':
      return (
        <Fields
          title={request.name || t('Authentication')}
          {...(request.instructions ? { description: request.instructions } : {})}
          fields={request.fields}
          submitLabel={t('Continue')}
          onAnswer={onAnswer}
        />
      )
  }
}

/** Mật khẩu SSH: host đã lưu + vault mở → cho lưu vào vault (chỉ ghi sau khi đăng nhập được). */
function PasswordPrompt({
  prompt,
  request,
  onAnswer
}: {
  prompt: ActivePrompt
  request: Extract<PromptRequest, { kind: 'password' }>
  onAnswer: Answer
}): React.JSX.Element {
  const unlocked = useVault((s) => s.state === 'unlocked')
  const [target] = useState(() => {
    const tabId = promptTab(prompt)
    const key = passwordKey(request)
    // Hỏi lại cùng tài khoản trong cùng tab → mật khẩu vừa gõ sai: không lưu nó.
    if (tabId) dropPending(tabId, 'password', key)
    const host = tabId ? savedHostForPassword(request, tabId) : null
    return tabId && host ? { tabId, key, host } : null
  })
  // Host dùng tài khoản chung: mật khẩu lưu vào TÀI KHOẢN (mọi host dùng nó đều nhận) — nói rõ.
  const account = useHosts((s) =>
    target?.host.accountId ? s.tree.accounts.find((a) => a.id === target.host.accountId) : undefined
  )
  const remember: RememberOption | null =
    target && unlocked
      ? {
          label: t('Save password in vault'),
          description: account
            ? t(
                'Saved to the account {account} once you are signed in — every host using this account gets it.',
                { account: account.name }
              )
            : target.host.hasPassword
              ? t('Replaces the saved password of {name} once you are signed in.', {
                  name: target.host.label
                })
              : t(
                  'Saved for {name} once you are signed in. Next time you connect without a prompt.',
                  {
                    name: target.host.label
                  }
                ),
          testId: 'prompt-save-password',
          onSubmit: ([password]) => {
            if (!password) return
            rememberAfterLogin({
              kind: 'password',
              tabId: target.tabId,
              key: target.key,
              hostId: target.host.id,
              label: target.host.label,
              secret: password
            })
          }
        }
      : null
  return (
    <Fields
      title={t('Password for {user}@{host}', { user: request.username, host: request.host })}
      fields={[{ prompt: t('Password'), echo: false }]}
      submitLabel={t('Log in')}
      remember={remember}
      onAnswer={onAnswer}
    />
  )
}

/** Passphrase của key: nhớ trong phiên chạy (bộ nhớ, tới khi thoát app / khoá vault). */
function PassphrasePrompt({
  prompt,
  request,
  onAnswer
}: {
  prompt: ActivePrompt
  request: Extract<PromptRequest, { kind: 'passphrase' }>
  onAnswer: Answer
}): React.JSX.Element | null {
  const [tabId] = useState(() => {
    const id = promptTab(prompt)
    if (id) dropPending(id, 'passphrase', request.keyPath)
    return id
  })
  // Đã nhớ passphrase cho key này → tự trả lời (bị hỏi lại ngay = sai → hiện hộp như thường).
  const [auto] = useState(() => takeRememberedPassphrase(request.keyPath, tabId))
  useEffect(() => {
    if (auto !== null) onAnswer(true, [auto])
    // Chỉ một lần cho mỗi prompt (component được gắn key = id prompt).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (auto !== null) return null
  const remember: RememberOption | null = tabId
    ? {
        label: t('Remember for this session'),
        description: t('Kept in memory until you quit Shellhouse or lock the vault.'),
        testId: 'prompt-remember-passphrase',
        onSubmit: ([passphrase]) => {
          if (!passphrase) return
          rememberAfterLogin({
            kind: 'passphrase',
            tabId,
            key: request.keyPath,
            hostId: null,
            label: request.keyPath,
            secret: passphrase
          })
        }
      }
    : null
  return (
    <Fields
      title={t('Key passphrase')}
      description={request.keyPath}
      fields={[{ prompt: t('Passphrase'), echo: false }]}
      submitLabel={t('Unlock key')}
      remember={remember}
      onAnswer={onAnswer}
    />
  )
}

/** Hộp thoại phủ lên tab terminal. Esc = huỷ. */
export function PromptDialog({
  prompt,
  onAnswer
}: {
  prompt: ActivePrompt
  onAnswer: Answer
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  const labels: Record<string, string> = {
    hostkey: t('Verify host key'),
    password: t('Password'),
    passphrase: t('Key passphrase'),
    'keyboard-interactive': t('Authentication')
  }
  return (
    <div
      className="bg-overlay animate-fade-in absolute inset-0 z-10 flex items-center justify-center p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault()
      }}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={labels[prompt.request.kind] ?? t('Connection prompt')}
      data-testid="prompt-dialog"
      data-prompt-kind={prompt.request.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onAnswer(false, [])
      }}
    >
      <div className="shadow-elevated animate-dialog-in w-full max-w-md rounded-xl border border-line bg-elevated p-5">
        {/* key = id: mỗi prompt mới có state (ô nhập, checkbox) mới */}
        <Body key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
      </div>
    </div>
  )
}
