import { useRef, useState, type SyntheticEvent } from 'react'
import { ShieldAlert, ShieldQuestion } from 'lucide-react'
import type { PromptRequest } from '@shared/stream-protocol'
import { Button, Checkbox, Field, Input, useFocusTrap } from '../components/ui'
import type { ActivePrompt } from './controller'

type Answer = (ok: boolean, answers: string[]) => void

function Fields({
  fields,
  title,
  description,
  submitLabel,
  onAnswer
}: {
  fields: { prompt: string; echo: boolean }[]
  title: string
  description?: string
  submitLabel: string
  onAnswer: Answer
}): React.JSX.Element {
  const [values, setValues] = useState(() => fields.map(() => ''))
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault()
    onAnswer(true, values)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description && <p className="text-xs whitespace-pre-wrap text-muted">{description}</p>}
      {fields.map((field, i) => (
        <Field key={i} label={field.prompt}>
          <Input
            type={field.echo ? 'text' : 'password'}
            autoFocus={i === 0}
            autoComplete="off"
            spellCheck={false}
            data-testid="prompt-input"
            value={values[i] ?? ''}
            onChange={(e) => {
              const next = [...values]
              next[i] = e.target.value
              setValues(next)
            }}
          />
        </Field>
      ))}
      <div className="flex justify-end gap-2 pt-1">
        <Button
          data-testid="prompt-cancel"
          onClick={() => {
            onAnswer(false, [])
          }}
        >
          Cancel
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
          <h2 className="text-[15px] font-semibold">The host key for {where} has changed</h2>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          Someone could be intercepting this connection (a man-in-the-middle attack), or the server
          was reinstalled. <strong className="text-fg">Do not continue</strong> until you have
          verified the new fingerprint with the server administrator.
        </p>
        <div className="rounded-md border border-danger/30 bg-danger-soft p-3 font-mono text-xs leading-relaxed break-all">
          {changedFrom.map((k) => (
            <div key={k.fingerprint} className="text-muted">
              Previous: {k.keyType} {k.fingerprint}
            </div>
          ))}
          <div className="text-danger">
            New: {key.keyType} {key.fingerprint}
          </div>
        </div>
        <Checkbox
          data-testid="hostkey-confirm"
          checked={confirmed}
          onChange={(e) => {
            setConfirmed(e.target.checked)
          }}
          label="I have verified the new fingerprint with the server administrator."
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
            Cancel connection
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed}
            data-testid="hostkey-accept"
            onClick={() => {
              onAnswer(true, [])
            }}
          >
            Replace key and connect
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="hostkey-new">
      <div className="flex items-center gap-2">
        <ShieldQuestion size={20} className="text-accent" />
        <h2 className="text-[15px] font-semibold">New host: {where}</h2>
      </div>
      <p className="text-xs text-muted">
        This is the first connection to this host. Compare the fingerprint with the one from the
        administrator before trusting it.
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
          Cancel
        </Button>
        <Button
          autoFocus
          variant="primary"
          data-testid="hostkey-accept"
          onClick={() => {
            onAnswer(true, [])
          }}
        >
          Trust and connect
        </Button>
      </div>
    </div>
  )
}

function Body({
  request,
  onAnswer
}: {
  request: PromptRequest
  onAnswer: Answer
}): React.JSX.Element {
  switch (request.kind) {
    case 'hostkey':
      return <HostKey request={request} onAnswer={onAnswer} />
    case 'password':
      return (
        <Fields
          title={`Password for ${request.username}@${request.host}`}
          fields={[{ prompt: 'Password', echo: false }]}
          submitLabel="Log in"
          onAnswer={onAnswer}
        />
      )
    case 'passphrase':
      return (
        <Fields
          title="Key passphrase"
          description={request.keyPath}
          fields={[{ prompt: 'Passphrase', echo: false }]}
          submitLabel="Unlock key"
          onAnswer={onAnswer}
        />
      )
    case 'keyboard-interactive':
      return (
        <Fields
          title={request.name || 'Authentication'}
          {...(request.instructions ? { description: request.instructions } : {})}
          fields={request.fields}
          submitLabel="Continue"
          onAnswer={onAnswer}
        />
      )
  }
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
    hostkey: 'Verify host key',
    password: 'Password',
    passphrase: 'Key passphrase',
    'keyboard-interactive': 'Authentication'
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
      aria-label={labels[prompt.request.kind] ?? 'Connection prompt'}
      data-testid="prompt-dialog"
      data-prompt-kind={prompt.request.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onAnswer(false, [])
      }}
    >
      <div className="shadow-elevated animate-dialog-in w-full max-w-md rounded-xl border border-line bg-elevated p-5">
        {/* key = id: mỗi prompt mới có state (ô nhập, checkbox) mới */}
        <Body key={prompt.id} request={prompt.request} onAnswer={onAnswer} />
      </div>
    </div>
  )
}
