import { Checkbox, SectionTitle } from '../../../renderer/src/components/ui'
import { useSavedHosts } from '../../registry/renderer-kit'
import { dockerApi, sourceLabel } from './api'
import { useDocker } from './store'
import { useEffect } from 'react'

/** Settings → Modules → Docker: chế độ chỉ đọc theo từng nguồn. */
export function DockerSettings(): React.JSX.Element {
  const endpoints = useDocker((s) => s.endpoints)
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
    <div className="flex flex-col gap-3" data-testid="settings-module-docker">
      <SectionTitle description="Read-only mode hides every action that changes something (start, stop, remove, prune, pull, Compose). Turn it on for production servers.">
        Read-only mode
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
  )
}
