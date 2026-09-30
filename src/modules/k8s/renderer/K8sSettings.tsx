import { useEffect } from 'react'
import { Checkbox, SectionTitle } from '../../../renderer/src/components/ui'
import { useSavedHosts } from '../../registry/renderer-kit'
import { k8sApi } from './api'
import { useK8s } from './store'

/** Settings → Modules → Kubernetes: chế độ chỉ đọc theo context, bản import. */
export function K8sSettings(): React.JSX.Element {
  const { contexts, imported, errors } = useK8s()
  const hosts = useSavedHosts()
  useEffect(() => {
    void useK8s.getState().reload()
  }, [])
  return (
    <div className="flex flex-col gap-3" data-testid="settings-module-k8s">
      <SectionTitle description="Read-only mode hides every action that changes something. Right-click a context in the sidebar for its color, namespace and SSH bastion.">
        Contexts
      </SectionTitle>
      {contexts.length === 0 && (
        <p className="text-xs text-faint">No contexts found in ~/.kube/config.</p>
      )}
      {contexts.map((c) => (
        <Checkbox
          key={c.key}
          label={`${c.name} — read-only`}
          description={`${c.server} · ${c.sourceLabel}${
            c.settings.bastionHostId
              ? ` · through ${hosts.find((h) => h.id === c.settings.bastionHostId)?.label ?? 'an SSH host'}`
              : ''
          }`}
          checked={c.settings.readOnly}
          onChange={(e) => void k8sApi.setContext(c.ref, { readOnly: e.target.checked })}
        />
      ))}
      {errors.map((e) => (
        <p key={e} className="text-xs text-danger">
          {e}
        </p>
      ))}
      {imported.length > 0 && (
        <p className="text-xs text-muted">
          Imported kubeconfigs (encrypted in the vault): {imported.map((i) => i.name).join(', ')}
        </p>
      )}
    </div>
  )
}
