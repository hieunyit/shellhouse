import { useEffect } from 'react'
import { Checkbox, SectionTitle } from '../../../renderer/src/components/ui'
import { t, useSavedHosts } from '../../registry/renderer-kit'
import { dockerApi, sourceLabel } from './api'
import { RegistriesPanel } from './ResourceDialogs'
import { useDocker } from './store'

/** Settings → Modules → Docker: chế độ chỉ đọc theo từng nguồn, registry (đăng nhập riêng tư). */
export function DockerSettings(): React.JSX.Element {
  const endpoints = useDocker((s) => s.endpoints)
  const registries = useDocker((s) => s.registries)
  const hosts = useSavedHosts()
  useEffect(() => {
    void useDocker.getState().reload()
  }, [])
  const rows = [
    {
      hostId: null as string | null,
      readOnly: endpoints.find((e) => e.hostId === null)?.readOnly ?? false
    },
    ...endpoints
      .filter((e) => e.hostId && hosts.some((h) => h.id === e.hostId))
      .map((e) => ({ hostId: e.hostId, readOnly: e.readOnly }))
  ]
  return (
    <div className="flex flex-col gap-6" data-testid="settings-module-docker">
      <div className="flex flex-col gap-3">
        <SectionTitle
          description={t(
            'Read-only mode hides every action that changes something (start, stop, remove, prune, pull, push, build, uploads, Compose). Turn it on for production servers.'
          )}
        >
          {t('Read-only mode')}
        </SectionTitle>
        {rows.map((r) => (
          <Checkbox
            key={r.hostId ?? 'local'}
            label={sourceLabel(r.hostId)}
            data-testid={`docker-read-only-${r.hostId ?? 'local'}`}
            checked={r.readOnly}
            onChange={(e) => void dockerApi.setReadOnly(r.hostId, e.target.checked)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <SectionTitle
          description={t(
            'Logins for pulling and pushing private images. Passwords and tokens are encrypted in your vault and never shown again.'
          )}
        >
          {t('Registries')}
        </SectionTitle>
        <RegistriesPanel registries={registries} />
      </div>
    </div>
  )
}
