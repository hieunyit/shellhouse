import { useEffect, useState } from 'react'
import { ChevronRight, Eye, FileInput, Settings2, Ship, Trash2 } from 'lucide-react'
import {
  Button,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Modal,
  Notice,
  Select,
  TextArea
} from '../../../renderer/src/components/ui'
import { useContextMenu } from '../../../renderer/src/components/ContextMenu'
import { useSavedHosts } from '../../registry/renderer-kit'
import type { ContextColor, ContextEntry } from '../shared/ipc'
import { k8sApi, openCluster } from './api'
import { useK8s } from './store'

export const COLOR_DOT: Record<NonNullable<ContextColor>, string> = {
  red: 'bg-danger-solid',
  orange: 'bg-warning',
  green: 'bg-success',
  blue: 'bg-accent-solid'
}

/** Mục "Kubernetes" ở thanh bên: context trong kubeconfig; bấm đúp để mở. */
export function K8sSection(): React.JSX.Element {
  const { contexts, errors, imported } = useK8s()
  const [open, setOpen] = useState(true)
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<ContextEntry | null>(null)
  const { menu, open: openMenu } = useContextMenu()

  useEffect(() => {
    void useK8s.getState().reload()
  }, [])

  return (
    <div className="mt-2 border-t border-line pt-2" data-testid="k8s-section">
      <div className="flex h-7 items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
        <button
          type="button"
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 hover:text-muted"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronRight
            size={13}
            className={cx('transition-transform duration-150', open && 'rotate-90')}
          />
          <Ship size={12} />
          <span className="flex-1 text-left">Kubernetes</span>
        </button>
        <IconButton
          label="Import a kubeconfig"
          size="sm"
          data-testid="k8s-import"
          onClick={() => {
            setImporting(true)
          }}
        >
          <FileInput size={13} />
        </IconButton>
      </div>
      {open && contexts.length === 0 && (
        <p className="px-2 py-1 text-xs text-faint">
          No contexts in ~/.kube/config. Import a kubeconfig to add clusters.
        </p>
      )}
      {open && errors.length > 0 && (
        <p className="px-2 py-1 text-xs text-danger" title={errors.join('\n')}>
          Could not read {errors.length} kubeconfig{errors.length > 1 ? 's' : ''}
        </p>
      )}
      {open &&
        contexts.map((c) => (
          <div
            key={c.key}
            role="button"
            tabIndex={0}
            data-testid="k8s-context"
            data-name={c.name}
            className="group flex h-8 cursor-default items-center gap-2 rounded-md px-2 hover:bg-hover"
            title={`${c.server}\n${c.sourceLabel}${c.settings.bastionHostId ? '\nThrough an SSH host' : ''}`}
            onDoubleClick={() => openCluster(c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openCluster(c)
            }}
            onContextMenu={(e) => {
              openMenu(e, [
                {
                  id: 'open',
                  label: 'Open',
                  icon: <Ship size={14} />,
                  onSelect: () => openCluster(c)
                },
                {
                  id: 'ro',
                  label: c.settings.readOnly ? 'Turn off read-only mode' : 'Read-only mode',
                  icon: <Eye size={14} />,
                  onSelect: () => void k8sApi.setContext(c.ref, { readOnly: !c.settings.readOnly })
                },
                {
                  id: 'settings',
                  label: 'Context settings…',
                  icon: <Settings2 size={14} />,
                  onSelect: () => {
                    setEditing(c)
                  }
                },
                ...(c.ref.source.startsWith('imported:')
                  ? [
                      'separator' as const,
                      {
                        id: 'remove',
                        label: 'Remove imported kubeconfig',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => {
                          const id = c.ref.source.slice('imported:'.length)
                          const name = imported.find((i) => i.id === id)?.name ?? c.sourceLabel
                          if (
                            window.confirm(
                              `Remove the imported kubeconfig “${name}” and all its contexts?`
                            )
                          )
                            void k8sApi.removeImported(id)
                        }
                      }
                    ]
                  : [])
              ])
            }}
          >
            <span
              className={cx(
                'size-2 shrink-0 rounded-full',
                c.settings.color ? COLOR_DOT[c.settings.color] : 'bg-line-strong'
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{c.name}</span>
            {c.settings.bastionHostId && (
              <span className="rounded bg-subtle px-1 text-[10px] text-muted">SSH</span>
            )}
            {c.settings.readOnly && (
              <span className="rounded bg-subtle px-1 text-[10px] font-medium text-muted">
                read-only
              </span>
            )}
          </div>
        ))}
      {importing && (
        <ImportDialog
          onClose={() => {
            setImporting(false)
          }}
        />
      )}
      {editing && (
        <ContextDialog
          context={editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {menu}
    </div>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [yaml, setYaml] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    const r = await k8sApi.importKubeconfig(name.trim() || 'Imported', yaml)
    if (r.ok) onClose()
    else setError(r.message)
  }
  return (
    <Modal
      title="Import a kubeconfig"
      description="Paste a kubeconfig. It is stored encrypted in your vault; certificates must be embedded (…-data fields)."
      width="max-w-2xl"
      onClose={onClose}
      testId="k8s-import-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="k8s-import-save"
            disabled={!yaml.trim()}
            onClick={() => void submit()}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input
            autoFocus
            placeholder="prod-eks"
            data-testid="k8s-import-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <Field label="Kubeconfig (YAML)">
          <TextArea
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            data-testid="k8s-import-yaml"
            value={yaml}
            onChange={(e) => {
              setYaml(e.target.value)
            }}
          />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}

function ContextDialog({
  context: c,
  onClose
}: {
  context: ContextEntry
  onClose: () => void
}): React.JSX.Element {
  const hosts = useSavedHosts().filter((h) => h.protocol === 'ssh')
  const [bastion, setBastion] = useState(c.settings.bastionHostId ?? '')
  const [namespace, setNamespace] = useState(c.settings.namespace ?? '')
  const [readOnly, setReadOnly] = useState(c.settings.readOnly)
  const [color, setColor] = useState<ContextColor>(c.settings.color)
  const save = (): void => {
    void k8sApi
      .setContext(c.ref, {
        bastionHostId: bastion || null,
        namespace: namespace.trim() || null,
        readOnly,
        color
      })
      .then(onClose)
  }
  return (
    <Modal
      title={`Context ${c.name}`}
      description={`${c.server} · ${c.sourceLabel}`}
      onClose={onClose}
      testId="k8s-context-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="k8s-context-save" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Reach the API server through"
          hint="Pick an SSH host when the cluster is only reachable from inside a network. TLS is still checked against the kubeconfig."
        >
          <Select
            data-testid="k8s-context-bastion"
            value={bastion}
            onChange={(e) => {
              setBastion(e.target.value)
            }}
          >
            <option value="">Direct connection</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label} ({h.address})
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Default namespace"
          hint={`Empty = ${c.namespace ?? 'default'} (from the kubeconfig)`}
        >
          <Input
            mono
            value={namespace}
            data-testid="k8s-context-namespace"
            onChange={(e) => {
              setNamespace(e.target.value)
            }}
          />
        </Field>
        <Field
          label="Color"
          hint="Red marks production: deleting or scaling asks you to type the resource name."
        >
          <div className="flex gap-2">
            {([null, 'red', 'orange', 'green', 'blue'] as const).map((k) => (
              <button
                key={k ?? 'none'}
                type="button"
                aria-label={k ?? 'No color'}
                aria-pressed={color === k}
                data-testid={`k8s-color-${k ?? 'none'}`}
                className={cx(
                  'flex size-7 items-center justify-center rounded-full border',
                  color === k ? 'border-accent ring-2 ring-accent/30' : 'border-line'
                )}
                onClick={() => {
                  setColor(k)
                }}
              >
                <span
                  className={cx('size-3.5 rounded-full', k ? COLOR_DOT[k] : 'bg-line-strong')}
                />
              </button>
            ))}
          </div>
        </Field>
        <Checkbox
          label="Read-only mode"
          description="Hide every action that changes something (delete, scale, restart, edit, apply)."
          checked={readOnly}
          data-testid="k8s-context-read-only"
          onChange={(e) => {
            setReadOnly(e.target.checked)
          }}
        />
      </div>
    </Modal>
  )
}
