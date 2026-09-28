import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/updates'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, Field, Notice, SectionTitle, Select } from '../ui'

function describe(s: UpdateStatus): string {
  switch (s.state) {
    case 'disabled':
      return s.reason
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return `You are up to date (checked at ${new Date(s.checkedAt).toLocaleTimeString()}).`
    case 'available':
      return `Version ${s.version} is available.`
    case 'downloading':
      return `Downloading… ${s.percent}%`
    case 'ready':
      return `Version ${s.version} is ready. Restart to install it.`
    case 'error':
      return `Error: ${s.message}`
  }
}

export function UpdatesSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.shellhouse.updateStatus().then(setStatus)
    void window.shellhouse.getInfo().then((info) => {
      setVersion(info.version)
    })
    return window.shellhouse.onUpdateStatus(setStatus)
  }, [])

  return (
    <div className="flex flex-col gap-4" data-testid="settings-updates">
      <SectionTitle description={`Current version: ${version}`}>Updates</SectionTitle>
      <Field label="Channel">
        <Select
          className="w-56"
          value={settings.updates.channel}
          onChange={(e) =>
            void update({ updates: { channel: e.target.value as 'stable' | 'beta' } })
          }
        >
          <option value="stable">Stable</option>
          <option value="beta">Beta (early access)</option>
        </Select>
      </Field>
      <Checkbox
        label="Check for updates when the app starts"
        checked={settings.updates.autoCheck}
        onChange={(e) => void update({ updates: { autoCheck: e.target.checked } })}
      />
      <Notice tone={status.state === 'error' ? 'danger' : 'info'} testId="update-status">
        {describe(status)}
      </Notice>
      <div className="flex gap-2">
        <Button
          disabled={status.state === 'disabled' || status.state === 'checking'}
          onClick={() => void window.shellhouse.checkForUpdates()}
        >
          Check now
        </Button>
        {status.state === 'available' && (
          <Button variant="primary" onClick={() => void window.shellhouse.downloadUpdate()}>
            Download
          </Button>
        )}
        {status.state === 'ready' && (
          <Button variant="primary" onClick={() => void window.shellhouse.installUpdate()}>
            Restart to update
          </Button>
        )}
      </div>
    </div>
  )
}
