import { useState } from 'react'
import { Copy, FileDown, KeyRound, Trash2, Upload } from 'lucide-react'
import { useHosts } from '../../stores/hosts'
import { Button, Field, Input, Notice, SectionTitle, Select } from '../ui'

const BITS = { ed25519: [], rsa: [3072, 4096], ecdsa: [256, 384, 521] } as const

export function KeysSection(): React.JSX.Element {
  const keys = useHosts((s) => s.tree.keys)
  const [name, setName] = useState('')
  const [type, setType] = useState<'ed25519' | 'rsa' | 'ecdsa'>('ed25519')
  const [bits, setBits] = useState<number | undefined>(undefined)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const generate = async (): Promise<void> => {
    setBusy(true)
    const result = await window.shellhouse.generateKey({
      name: name.trim(),
      type,
      ...(bits ? { bits } : {}),
      ...(passphrase ? { passphrase } : {})
    })
    setBusy(false)
    setPassphrase('')
    if (result.ok) {
      setName('')
      setMessage({
        ok: true,
        text: 'Key created. Use “Copy public key” or “Deploy key” to add it to a server.'
      })
    } else setMessage({ ok: false, text: result.message })
  }

  return (
    <div className="flex flex-col gap-6" data-testid="settings-keys">
      {message && (
        <Notice tone={message.ok ? 'success' : 'danger'} testId="keys-message">
          {message.text}
        </Notice>
      )}
      <section>
        <SectionTitle description="Private keys are stored encrypted in the vault.">
          Keys
        </SectionTitle>
        <div className="flex flex-col gap-2">
          {keys.length === 0 && <p className="text-xs text-faint">No keys in the vault yet.</p>}
          {keys.map((k) => (
            <div
              key={k.id}
              className="rounded-lg border border-line p-3"
              data-testid="key-row"
              data-key-name={k.name}
            >
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-muted" />
                <span className="text-[13px] font-medium">{k.name}</span>
                <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted">
                  {k.type}
                  {k.encrypted ? ' · passphrase' : ''}
                </span>
              </div>
              <p className="mt-1 font-mono text-[11px] break-all text-faint">{k.fingerprint}</p>
              <div className="mt-2 flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={13} />}
                  data-testid="key-copy-public"
                  onClick={() => {
                    void window.shellhouse
                      .publicKey(k.id)
                      .then((line) => window.shellhouse.writeClipboard(line))
                      .then(() => {
                        setMessage({ ok: true, text: `Copied the public key of “${k.name}”.` })
                      })
                  }}
                >
                  Copy public key
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<FileDown size={13} />}
                  onClick={() => {
                    void window.shellhouse.exportPrivateKey(k.id).then((r) => {
                      if (r)
                        setMessage({
                          ok: r.ok,
                          text: r.ok ? `Saved ${r.path} (mode 600) and ${r.path}.pub` : r.message
                        })
                    })
                  }}
                >
                  Export…
                </Button>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="danger-ghost"
                  icon={<Trash2 size={13} />}
                  onClick={() => {
                    if (!window.confirm(`Delete the key “${k.name}” from the vault?`)) return
                    void window.shellhouse.deleteKey(k.id).then((r) => {
                      if (!r.ok) setMessage({ ok: false, text: r.message })
                    })
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
        <SectionTitle>Generate a new key</SectionTitle>
        <Field label="Name">
          <Input
            placeholder="e.g. laptop-2026"
            data-testid="keygen-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select
              data-testid="keygen-type"
              value={type}
              onChange={(e) => {
                const next = e.target.value as typeof type
                setType(next)
                setBits(BITS[next][0])
              }}
            >
              <option value="ed25519">Ed25519 (recommended)</option>
              <option value="rsa">RSA</option>
              <option value="ecdsa">ECDSA</option>
            </Select>
          </Field>
          {type !== 'ed25519' && (
            <Field label="Size">
              <Select
                value={bits}
                onChange={(e) => {
                  setBits(Number(e.target.value))
                }}
              >
                {BITS[type].map((b) => (
                  <option key={b} value={b}>
                    {b} bits
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Passphrase" hint="Optional. Leave empty for no passphrase.">
          <Input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value)
            }}
          />
        </Field>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!name.trim() || busy}
            data-testid="keygen-create"
            onClick={() => void generate()}
          >
            {busy ? 'Generating…' : 'Generate key'}
          </Button>
          <Button
            icon={<Upload size={14} />}
            onClick={() => {
              void window.shellhouse.importKeyFromFile().then((r) => {
                if (r && !r.ok) setMessage({ ok: false, text: r.message })
              })
            }}
          >
            Import from file…
          </Button>
        </div>
      </section>
    </div>
  )
}
