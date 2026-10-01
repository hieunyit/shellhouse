import { useEffect, useState } from 'react'
import { FileInput, Pencil, Trash2 } from 'lucide-react'
import { Button, Checkbox, IconButton, SectionTitle } from '../../../renderer/src/components/ui'
import { useSavedHosts } from '../../registry/renderer-kit'
import { k8sApi } from './api'
import { importSummary } from './K8sSection'
import { useK8s } from './store'

/** Settings → Modules → Kubernetes: nguồn kubeconfig, context hiện / ẩn, chỉ đọc. */
export function K8sSettings(): React.JSX.Element {
  const { contexts, imported, files, errors } = useK8s()
  const hosts = useSavedHosts()
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    void useK8s.getState().reload()
  }, [])
  return (
    <div className="flex flex-col gap-4" data-testid="settings-module-k8s">
      <div className="flex flex-col gap-2">
        <SectionTitle description="Shellhouse reads KUBECONFIG (or ~/.kube/config) and every other kubeconfig in ~/.kube, like Lens. Imported files are stored encrypted in the vault, certificates included.">
          Kubeconfig sources
        </SectionTitle>
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-fg">{f.label}</span>
            <span className="text-faint">
              {f.contexts} context{f.contexts === 1 ? '' : 's'}
            </span>
          </div>
        ))}
        {imported.map((i) => (
          <div key={i.id} className="flex items-center gap-2 text-xs" data-testid="k8s-imported">
            <span className="text-fg">Imported: {i.name}</span>
            <span className="text-faint">
              {i.contexts} context{i.contexts === 1 ? '' : 's'}
            </span>
            <IconButton
              label={`Rename ${i.name}`}
              size="sm"
              onClick={() => {
                const name = window.prompt('New name', i.name)?.trim()
                if (name) void k8sApi.renameImported(i.id, name)
              }}
            >
              <Pencil size={12} />
            </IconButton>
            <IconButton
              label={`Remove ${i.name}`}
              size="sm"
              onClick={() => {
                if (window.confirm(`Remove the imported kubeconfig “${i.name}”?`))
                  void k8sApi.removeImported(i.id)
              }}
            >
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
        {errors.map((e) => (
          <p key={e} className="text-xs text-danger">
            {e}
          </p>
        ))}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            icon={<FileInput size={13} />}
            data-testid="k8s-settings-import"
            onClick={() => {
              k8sApi.importFiles().then(
                (r) => {
                  setNote(importSummary(r))
                },
                (e: unknown) => {
                  setNote(e instanceof Error ? e.message : String(e))
                }
              )
            }}
          >
            Import kubeconfig files…
          </Button>
          {note && <span className="text-xs text-muted">{note}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <SectionTitle description="Hidden contexts stay in your kubeconfig but are not listed in the sidebar. Read-only mode hides every action that changes something.">
          Contexts
        </SectionTitle>
        {contexts.length === 0 && <p className="text-xs text-faint">No contexts found.</p>}
        {contexts.map((c) => (
          <div
            key={c.key}
            className="flex flex-col gap-1 rounded-md border border-line p-2"
            data-testid="k8s-settings-context"
            data-name={c.name}
          >
            <div className="text-xs">
              <span className="font-medium text-fg">{c.name}</span>
              <span className="ml-2 text-faint">
                {c.server} · {c.sourceLabel}
                {c.settings.bastionHostId
                  ? ` · through ${hosts.find((h) => h.id === c.settings.bastionHostId)?.label ?? 'an SSH host'}`
                  : ''}
              </span>
            </div>
            <div className="flex gap-4">
              <Checkbox
                label="Show in sidebar"
                checked={!c.settings.hidden}
                data-testid="k8s-settings-visible"
                onChange={(e) => void k8sApi.setContext(c.ref, { hidden: !e.target.checked })}
              />
              <Checkbox
                label="Read-only"
                checked={c.settings.readOnly}
                onChange={(e) => void k8sApi.setContext(c.ref, { readOnly: e.target.checked })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
