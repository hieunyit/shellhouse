import { useState } from 'react'
import { useHosts } from '../stores/hosts'
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
        setResult({ ok: true, text: 'Key added to ~/.ssh/authorized_keys.' })
      else if (r.status === 'exists')
        setResult({ ok: true, text: 'The key is already on the server.' })
      else setResult({ ok: false, text: r.message ?? 'Failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Deploy key to server"
      description="Like ssh-copy-id: no duplicates, ~/.ssh is 700 and authorized_keys is 600. Requires a POSIX shell on the server."
      onClose={onClose}
      width="max-w-md"
      testId="deploy-key-dialog"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={!keyId || busy}
            data-testid="deploy-key-run"
            onClick={() => void run()}
          >
            {busy ? 'Adding…' : 'Add key'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {keys.length === 0 ? (
          <p className="text-[13px] text-muted">
            No keys in the vault yet. Create one in Settings → SSH keys.
          </p>
        ) : (
          <Select
            data-testid="deploy-key-select"
            value={keyId}
            onChange={(e) => {
              setKeyId(e.target.value)
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
