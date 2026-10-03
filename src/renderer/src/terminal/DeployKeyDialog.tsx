import { useState } from 'react'
import { t } from '@shared/i18n'
import { useHosts } from '../stores/hosts'
import { cleanError } from '../lib/format'
import { Button, Modal, Notice, Select } from '../components/ui'

/** Thêm public key của một key trong vault vào ~/.ssh/authorized_keys của server đang kết nối. */
export function DeployKeyDialog({
  onClose,
  deploy
}: {
  onClose: () => void
  deploy: (
    publicKey: string
  ) => Promise<{ status: 'added' | 'exists' | 'error'; message: string | null }>
}): React.JSX.Element {
  const keys = useHosts((s) => s.tree.keys)
  const [keyId, setKeyId] = useState(keys[0]?.id ?? '')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const line = await window.shellhouse.publicKey(keyId)
      const r = await deploy(line)
      if (r.status === 'added')
        setResult({ ok: true, text: t('Key added to ~/.ssh/authorized_keys.') })
      else if (r.status === 'exists')
        setResult({ ok: true, text: t('The key is already on the server.') })
      else setResult({ ok: false, text: r.message ?? t('Could not add the key.') })
    } catch (error) {
      // Đọc public key hỏng (vault khoá, key bị xoá…) → báo trong hộp thoại, không nuốt lỗi.
      setResult({ ok: false, text: cleanError(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('Deploy key to server')}
      description={t(
        'Like ssh-copy-id: no duplicates, ~/.ssh is 700 and authorized_keys is 600. Requires a POSIX shell on the server.'
      )}
      onClose={onClose}
      width="max-w-md"
      testId="deploy-key-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('Close')}</Button>
          <Button
            variant="primary"
            disabled={!keyId || busy}
            data-testid="deploy-key-run"
            onClick={() => void run()}
          >
            {busy ? t('Adding…') : t('Add key')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {keys.length === 0 ? (
          <p className="text-[13px] text-muted">
            {t('No keys in the vault yet. Create one in Settings → SSH keys.')}
          </p>
        ) : (
          <Select
            data-testid="deploy-key-select"
            aria-label={t('SSH key')}
            value={keyId}
            onChange={(e) => {
              setKeyId(e.target.value)
              setResult(null)
            }}
          >
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.type})
              </option>
            ))}
          </Select>
        )}
        {result && (
          <Notice tone={result.ok ? 'success' : 'danger'} testId="deploy-key-result">
            {result.text}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
