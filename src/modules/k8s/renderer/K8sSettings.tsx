import { useEffect, useState } from 'react'
import { FileInput, Pencil, Trash2 } from 'lucide-react'
import {
  Button,
  Checkbox,
  IconButton,
  Input,
  Modal,
  SectionTitle
} from '../../../renderer/src/components/ui'
import { confirmAction, t, tn, useSavedHosts } from '../../registry/renderer-kit'
import { k8sApi } from './api'
import { importSummary } from './K8sSection'
import { useK8s } from './store'

/** Settings → Modules → Kubernetes: nguồn kubeconfig, context hiện / ẩn, chỉ đọc. */
export function K8sSettings(): React.JSX.Element {
  const { contexts, imported, files, errors } = useK8s()
  const hosts = useSavedHosts()
  const [note, setNote] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    void useK8s.getState().reload()
  }, [])
  return (
    <div className="flex flex-col gap-4" data-testid="settings-module-k8s">
      <div className="flex flex-col gap-2">
        <SectionTitle
          description={t(
            'Shellhouse reads KUBECONFIG (or ~/.kube/config) and every other kubeconfig in ~/.kube, like Lens. Imported files are stored encrypted in the vault, certificates included.'
          )}
        >
          {t('Kubeconfig sources')}
        </SectionTitle>
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-fg">{f.label}</span>
            <span className="text-faint">{tn(f.contexts, '{n} context', '{n} contexts')}</span>
          </div>
        ))}
        {imported.map((i) => (
          <div key={i.id} className="flex items-center gap-2 text-xs" data-testid="k8s-imported">
            <span className="text-fg">{t('Imported: {name}', { name: i.name })}</span>
            <span className="text-faint">{tn(i.contexts, '{n} context', '{n} contexts')}</span>
            <IconButton
              label={t('Rename {name}', { name: i.name })}
              size="sm"
              onClick={() => {
                setRenaming({ id: i.id, name: i.name })
              }}
            >
              <Pencil size={12} />
            </IconButton>
            <IconButton
              label={t('Remove {name}', { name: i.name })}
              size="sm"
              onClick={() => {
                void confirmAction({
                  title: t('Remove “{name}”?', { name: i.name }),
                  message: t(
                    'The imported kubeconfig and all its contexts are removed from Shellhouse.'
                  ),
                  confirmLabel: t('Remove'),
                  danger: true
                }).then((ok) => {
                  if (ok) void k8sApi.removeImported(i.id)
                })
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
            {t('Import kubeconfig files…')}
          </Button>
          {note && <span className="text-xs text-muted">{note}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <SectionTitle
          description={t(
            'Hidden contexts stay in your kubeconfig but are not listed in the sidebar. Read-only mode hides every action that changes something.'
          )}
        >
          {t('Contexts')}
        </SectionTitle>
        {contexts.length === 0 && <p className="text-xs text-faint">{t('No contexts found.')}</p>}
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
                  ? ` · ${t('through {host}', { host: hosts.find((h) => h.id === c.settings.bastionHostId)?.label ?? t('an SSH host') })}`
                  : ''}
              </span>
            </div>
            <div className="flex gap-4">
              <Checkbox
                label={t('Show in sidebar')}
                checked={!c.settings.hidden}
                data-testid="k8s-settings-visible"
                onChange={(e) => void k8sApi.setContext(c.ref, { hidden: !e.target.checked })}
              />
              <Checkbox
                label={t('Read-only')}
                checked={c.settings.readOnly}
                onChange={(e) => void k8sApi.setContext(c.ref, { readOnly: e.target.checked })}
              />
            </div>
          </div>
        ))}
      </div>
      {renaming && (
        <RenameDialog
          name={renaming.name}
          onClose={() => {
            setRenaming(null)
          }}
          onRename={(name) => {
            const id = renaming.id
            setRenaming(null)
            void k8sApi.renameImported(id, name)
          }}
        />
      )}
    </div>
  )
}

/** Đổi tên kubeconfig đã import (window.prompt không chạy trong Electron). */
function RenameDialog({
  name,
  onClose,
  onRename
}: {
  name: string
  onClose: () => void
  onRename: (name: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(name)
  const next = value.trim()
  const valid = next.length > 0 && next.length <= 200 && next !== name
  return (
    <Modal
      title={t('Rename imported kubeconfig')}
      width="max-w-sm"
      onClose={onClose}
      testId="k8s-rename-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="k8s-rename-save"
            onClick={() => {
              onRename(next)
            }}
          >
            {t('Rename')}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        aria-label={t('Name')}
        data-testid="k8s-rename-input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
        }}
        onFocus={(e) => {
          e.currentTarget.select()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onRename(next)
        }}
      />
    </Modal>
  )
}
