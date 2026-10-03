import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import { formatTime } from '@shared/i18n/format'
import type { UpdateStatus } from '@shared/updates'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, Field, Notice, SectionTitle, Select } from '../ui'

function describe(s: UpdateStatus): string {
  switch (s.state) {
    case 'disabled':
      return s.reason
    case 'idle':
      return t('Not checked yet.')
    case 'checking':
      return t('Checking for updates…')
    case 'none':
      return t('You are up to date (checked at {time}).', { time: formatTime(s.checkedAt) })
    case 'available':
      return t('Version {version} is available.', { version: s.version })
    case 'downloading':
      return t('Downloading… {percent}%', { percent: s.percent })
    case 'ready':
      return t('Version {version} is ready. Restart to install it.', { version: s.version })
    case 'error':
      return t('Error: {message}', { message: s.message })
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
      <SectionTitle description={t('Current version: {version}', { version })}>
        {t('Updates')}
      </SectionTitle>
      <Field label={t('Channel')}>
        <Select
          className="w-56"
          value={settings.updates.channel}
          onChange={(e) =>
            void update({ updates: { channel: e.target.value as 'stable' | 'beta' } })
          }
        >
          <option value="stable">{t('Stable')}</option>
          <option value="beta">{t('Beta (early access)')}</option>
        </Select>
      </Field>
      <Checkbox
        label={t('Check for updates when the app starts')}
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
          {t('Check now')}
        </Button>
        {status.state === 'available' && (
          <Button variant="primary" onClick={() => void window.shellhouse.downloadUpdate()}>
            {t('Download')}
          </Button>
        )}
        {status.state === 'ready' && (
          <Button variant="primary" onClick={() => void window.shellhouse.installUpdate()}>
            {t('Restart to update')}
          </Button>
        )}
      </div>
    </div>
  )
}
