import { useState, type SyntheticEvent } from 'react'
import { Upload } from 'lucide-react'
import { create } from 'zustand'
import type { PickedKey } from '@shared/hosts'
import { t } from '@shared/i18n'
import { PasswordInput } from '../PasswordInput'
import { Button, Checkbox, Field, Input, Modal, Notice } from '../ui'

/**
 * Import SSH key: chọn file → đặt tên, nhập passphrase (key có passphrase — kiểm tra đúng ngay), chọn
 * có nhớ passphrase trong vault không. Mở từ Keychain, sửa host, sửa tài khoản: `importKey()` trả về
 * id key mới (null = huỷ).
 */
interface Pending {
  key: PickedKey
  resolve: (id: string | null) => void
}

const useKeyImport = create<{ pending: Pending | null }>(() => ({ pending: null }))

export async function importKey(): Promise<string | null> {
  const key = await window.shellhouse.pickKeyFile()
  if (!key) return null
  return new Promise((resolve) => {
    useKeyImport.setState({ pending: { key, resolve } })
  })
}

/** Gắn một lần (App) — hiện hộp thoại khi có yêu cầu import. */
export function KeyImportHost(): React.JSX.Element | null {
  const pending = useKeyImport((s) => s.pending)
  if (!pending) return null
  return (
    <ImportKeyDialog
      key={pending.key.token}
      picked={pending.key}
      onDone={(id) => {
        useKeyImport.setState({ pending: null })
        pending.resolve(id)
      }}
    />
  )
}

function ImportKeyDialog({
  picked,
  onDone
}: {
  picked: PickedKey
  onDone: (id: string | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(picked.suggestedName)
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (event?: SyntheticEvent): Promise<void> => {
    event?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const result = await window.shellhouse.importPickedKey(
        picked.token,
        name.trim(),
        picked.encrypted && passphrase ? passphrase : null,
        remember
      )
      if (!result.ok) {
        setError(result.message)
        return
      }
      onDone(result.id)
    } finally {
      setBusy(false)
    }
  }

  const type = picked.type.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, 'ecdsa ')
  return (
    <Modal
      title={t('Import SSH key')}
      description={t('Private keys are stored encrypted in the vault.')}
      onClose={() => {
        onDone(null)
      }}
      width="max-w-md"
      testId="key-import-dialog"
      footer={
        <>
          <Button
            onClick={() => {
              onDone(null)
            }}
          >
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Upload size={14} />}
            disabled={!name.trim() || busy}
            data-testid="key-import-save"
            onClick={() => void save()}
          >
            {t('Import key')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)}>
        <div
          className="rounded-md bg-subtle px-3 py-2 text-xs text-muted"
          data-testid="key-import-info"
        >
          <div className="truncate font-mono text-fg">{picked.file}</div>
          <div className="mt-0.5 truncate">
            {type} · <span className="font-mono">{picked.fingerprint}</span>
          </div>
        </div>
        <Field label={t('Name')}>
          <Input
            autoFocus
            data-testid="key-import-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        {picked.encrypted && (
          <>
            <Field
              label={t('Passphrase')}
              hint={t('This key is protected. Leave empty to be asked when connecting.')}
            >
              <PasswordInput
                autoComplete="off"
                data-testid="key-import-passphrase"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value)
                  setError(null)
                }}
              />
            </Field>
            {passphrase !== '' && (
              <Checkbox
                label={t('Remember the passphrase in the vault')}
                data-testid="key-import-remember"
                checked={remember}
                onChange={(e) => {
                  setRemember(e.target.checked)
                }}
              />
            )}
          </>
        )}
        {error && (
          <Notice tone="danger" testId="key-import-error">
            {error}
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
