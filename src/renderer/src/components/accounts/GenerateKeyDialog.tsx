import { useState, type SyntheticEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { t } from '@shared/i18n'
import { PasswordInput } from '../PasswordInput'
import { Button, Field, Input, Modal, Notice, Select } from '../ui'

type KeyType = 'ed25519' | 'rsa' | 'ecdsa'
const BITS = { ed25519: [], rsa: [3072, 4096], ecdsa: [256, 384, 521] } as const

/** Tạo SSH key mới trong vault (Keychain → New → Generate SSH key). */
export function GenerateKeyDialog({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (id: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [type, setType] = useState<KeyType>('ed25519')
  const [bits, setBits] = useState<number | undefined>(undefined)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mismatch = passphrase !== '' && confirm !== '' && passphrase !== confirm

  const generate = async (event?: SyntheticEvent): Promise<void> => {
    event?.preventDefault()
    if (!name.trim() || busy) return
    if (passphrase !== confirm) {
      setError(t('The passphrases do not match'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.shellhouse.generateKey({
        name: name.trim(),
        type,
        ...(bits ? { bits } : {}),
        ...(passphrase ? { passphrase } : {})
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      onCreated(result.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('Generate SSH key')}
      description={t('Private keys are stored encrypted in the vault.')}
      onClose={onClose}
      width="max-w-md"
      testId="keygen-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            icon={<KeyRound size={14} />}
            disabled={!name.trim() || busy || mismatch}
            data-testid="keygen-create"
            onClick={() => void generate()}
          >
            {busy ? t('Generating…') : t('Generate key')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void generate(e)}>
        <Field label={t('Name')}>
          <Input
            autoFocus
            placeholder={t('e.g. laptop-2026')}
            data-testid="keygen-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Type')}>
            <Select
              data-testid="keygen-type"
              value={type}
              onChange={(e) => {
                const next = e.target.value as KeyType
                setType(next)
                setBits(next === 'rsa' ? 4096 : BITS[next][0])
              }}
            >
              <option value="ed25519">{t('Ed25519 (recommended)')}</option>
              <option value="rsa">RSA</option>
              <option value="ecdsa">ECDSA</option>
            </Select>
          </Field>
          {type !== 'ed25519' && (
            <Field label={t('Size')}>
              <Select
                data-testid="keygen-bits"
                value={bits}
                onChange={(e) => {
                  setBits(Number(e.target.value))
                }}
              >
                {BITS[type].map((b) => (
                  <option key={b} value={b}>
                    {t('{n} bits', { n: b })}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label={t('Passphrase')} hint={t('Optional. Leave empty for no passphrase.')}>
          <PasswordInput
            autoComplete="new-password"
            data-testid="keygen-passphrase"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value)
            }}
          />
        </Field>
        {passphrase !== '' && (
          <Field label={t('Confirm passphrase')}>
            <PasswordInput
              autoComplete="new-password"
              data-testid="keygen-passphrase-confirm"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
              }}
            />
          </Field>
        )}
        {(error ?? (mismatch ? t('The passphrases do not match') : null)) && (
          <Notice tone="danger" testId="keygen-error">
            {error ?? t('The passphrases do not match')}
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
