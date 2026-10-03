import { useEffect, useState } from 'react'
import {
  ChevronRight,
  ClipboardPaste,
  Eye,
  EyeOff,
  FileInput,
  FileX,
  RefreshCw,
  Settings2,
  Ship,
  Trash2
} from 'lucide-react'
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
import { confirmAction, t, tn, useSavedHosts } from '../../registry/renderer-kit'
import type { ContextColor, ContextEntry, ImportResult } from '../shared/ipc'
import { k8sApi, openCluster } from './api'
import { useK8s } from './store'

export const COLOR_DOT: Record<NonNullable<ContextColor>, string> = {
  red: 'bg-danger-solid',
  orange: 'bg-warning',
  green: 'bg-success',
  blue: 'bg-accent-solid'
}

/** "Imported 2 files (5 contexts)" + lỗi từng file. */
export function importSummary(r: ImportResult): string | null {
  if (r.imported.length === 0 && r.errors.length === 0) return null
  const contexts = r.imported.reduce((n, i) => n + i.contexts, 0)
  const ok = r.imported.length
    ? t('Imported {files} ({contexts}).', {
        files: tn(r.imported.length, '{n} file', '{n} files'),
        contexts: tn(contexts, '{n} context', '{n} contexts')
      })
    : ''
  return [ok, ...r.errors].filter(Boolean).join(' ')
}

/** Mục "Kubernetes" ở thanh bên: context trong kubeconfig; bấm đúp để mở. */
export function K8sSection(): React.JSX.Element {
  const { contexts: all, errors, imported } = useK8s()
  const contexts = all.filter((c) => !c.settings.hidden)
  const hidden = all.length - contexts.length
  const [importNote, setImportNote] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<ContextEntry | null>(null)
  const [deleting, setDeleting] = useState<ContextEntry | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const { menu, open: openMenu } = useContextMenu()

  // Đọc lại ~/.kube khi mở và mỗi lần quay lại cửa sổ (kubeconfig mới tải về / kubectl vừa sửa).
  useEffect(() => {
    const reload = (): void => {
      void useK8s.getState().reload()
    }
    reload()
    window.addEventListener('focus', reload)
    return () => {
      window.removeEventListener('focus', reload)
    }
  }, [])
  const refresh = (): void => {
    setRefreshing(true)
    void useK8s
      .getState()
      .reload()
      .finally(() => {
        setRefreshing(false)
      })
  }

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
          label={t('Refresh (read ~/.kube again)')}
          size="sm"
          data-testid="k8s-refresh"
          onClick={refresh}
        >
          <RefreshCw size={12} className={cx(refreshing && 'animate-spin')} />
        </IconButton>
        <IconButton
          label={t('Add clusters')}
          size="sm"
          data-testid="k8s-import"
          onClick={(e) => {
            openMenu(e, [
              {
                id: 'k8s-import-files',
                label: t('Import kubeconfig files…'),
                icon: <FileInput size={14} />,
                onSelect: () => {
                  setImportNote(null)
                  k8sApi.importFiles().then(
                    (r) => {
                      setImportNote(importSummary(r))
                    },
                    (err: unknown) => {
                      setImportNote(err instanceof Error ? err.message : String(err))
                    }
                  )
                }
              },
              {
                id: 'k8s-import-paste',
                label: t('Paste a kubeconfig…'),
                icon: <ClipboardPaste size={14} />,
                onSelect: () => {
                  setImporting(true)
                }
              }
            ])
          }}
        >
          <FileInput size={13} />
        </IconButton>
      </div>
      {open && importNote && (
        <p
          className="flex items-start gap-1 px-2 py-1 text-xs text-muted"
          data-testid="k8s-import-note"
        >
          <span className="flex-1">{importNote}</span>
          <button
            type="button"
            aria-label={t('Dismiss')}
            className="text-faint hover:text-fg"
            onClick={() => {
              setImportNote(null)
            }}
          >
            ×
          </button>
        </p>
      )}
      {open && contexts.length === 0 && (
        <p className="px-2 py-1 text-xs text-faint">
          {hidden
            ? t('All contexts are hidden.')
            : t('No contexts in ~/.kube. Use + to import kubeconfig files.')}
        </p>
      )}
      {open && errors.length > 0 && (
        <p className="px-2 py-1 text-xs text-danger" title={errors.join('\n')}>
          {tn(errors.length, 'Could not read {n} kubeconfig', 'Could not read {n} kubeconfigs')}
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
            title={`${c.server}\n${c.sourceLabel}${c.settings.bastionHostId ? `\n${t('Through an SSH host')}` : ''}`}
            onDoubleClick={() => openCluster(c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openCluster(c)
            }}
            onContextMenu={(e) => {
              openMenu(e, [
                {
                  id: 'open',
                  label: t('Open'),
                  icon: <Ship size={14} />,
                  onSelect: () => openCluster(c)
                },
                {
                  id: 'ro',
                  label: c.settings.readOnly ? t('Turn off read-only mode') : t('Read-only mode'),
                  icon: <Eye size={14} />,
                  onSelect: () => void k8sApi.setContext(c.ref, { readOnly: !c.settings.readOnly })
                },
                {
                  id: 'hide',
                  label: t('Hide from sidebar'),
                  icon: <EyeOff size={14} />,
                  onSelect: () => void k8sApi.setContext(c.ref, { hidden: true })
                },
                {
                  id: 'settings',
                  label: t('Context settings…'),
                  icon: <Settings2 size={14} />,
                  onSelect: () => {
                    setEditing(c)
                  }
                },
                'separator',
                {
                  id: 'delete',
                  label: t('Delete context…'),
                  icon: <FileX size={14} />,
                  danger: true,
                  onSelect: () => {
                    setDeleting(c)
                  }
                },
                ...(c.ref.source.startsWith('imported:')
                  ? [
                      {
                        id: 'remove',
                        label: t('Remove imported kubeconfig'),
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onSelect: () => {
                          const id = c.ref.source.slice('imported:'.length)
                          const name = imported.find((i) => i.id === id)?.name ?? c.sourceLabel
                          void confirmAction({
                            title: t('Remove “{name}”?', { name }),
                            message: t(
                              'The imported kubeconfig and all its contexts are removed from Shellhouse.'
                            ),
                            confirmLabel: t('Remove'),
                            danger: true
                          }).then((ok) => {
                            if (ok) void k8sApi.removeImported(id)
                          })
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
                {t('read-only')}
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
      {deleting && (
        <DeleteContextDialog
          context={deleting}
          onClose={() => {
            setDeleting(null)
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
    const r = await k8sApi.importKubeconfig(name.trim() || t('Imported'), yaml)
    if (r.ok) onClose()
    else setError(r.message)
  }
  return (
    <Modal
      title={t('Import a kubeconfig')}
      description={t(
        'Paste a kubeconfig. It is stored encrypted in your vault; certificates must be embedded (…-data fields).'
      )}
      width="max-w-2xl"
      onClose={onClose}
      testId="k8s-import-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="k8s-import-save"
            disabled={!yaml.trim()}
            onClick={() => void submit()}
          >
            {t('Import')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('Name')}>
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
      title={t('Context {name}', { name: c.name })}
      description={`${c.server} · ${c.sourceLabel}`}
      onClose={onClose}
      testId="k8s-context-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" data-testid="k8s-context-save" onClick={save}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t('Reach the API server through')}
          hint={t(
            'Pick an SSH host when the cluster is only reachable from inside a network. TLS is still checked against the kubeconfig.'
          )}
        >
          <Select
            data-testid="k8s-context-bastion"
            value={bastion}
            onChange={(e) => {
              setBastion(e.target.value)
            }}
          >
            <option value="">{t('Direct connection')}</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label} ({h.address})
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('Default namespace')}
          hint={t('Empty = {namespace} (from the kubeconfig)', {
            namespace: c.namespace ?? 'default'
          })}
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
          label={t('Color')}
          hint={t('Red marks production: deleting or scaling asks you to type the resource name.')}
        >
          <div className="flex gap-2">
            {([null, 'red', 'orange', 'green', 'blue'] as const).map((k) => (
              <button
                key={k ?? 'none'}
                type="button"
                aria-label={k ? t(k) : t('No color')}
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
          label={t('Read-only mode')}
          description={t(
            'Hide every action that changes something (delete, scale, restart, edit, apply).'
          )}
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

/**
 * Xoá một context không dùng nữa: bản import → khỏi vault; file kubeconfig → sửa file như
 * `kubectl config delete-context` (giữ bản .bak). Cluster thật không bị đụng tới.
 */
function DeleteContextDialog({
  context,
  onClose
}: {
  context: ContextEntry
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imported = context.ref.source.startsWith('imported:')
  const file = imported ? null : context.ref.source.slice('file:'.length)
  const submit = (): void => {
    setBusy(true)
    setError(null)
    k8sApi.deleteContext(context.ref).then(
      (r) => {
        setBusy(false)
        if (r.ok) onClose()
        else setError(r.message)
      },
      (e: unknown) => {
        setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    )
  }
  return (
    <Modal
      title={t('Delete context “{name}”?', { name: context.name })}
      onClose={onClose}
      width="max-w-md"
      testId="k8s-delete-context"
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="danger"
            disabled={busy}
            data-testid="k8s-delete-context-confirm"
            onClick={submit}
          >
            {busy ? t('Deleting…') : t('Delete')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px]">
        {imported ? (
          <p>
            {t('Removes it from')} <strong>{context.sourceLabel}</strong>{' '}
            {t(
              '(stored in your vault). Its cluster and user entries go too if nothing else uses them.'
            )}
          </p>
        ) : (
          <>
            <p>
              {t('Removes it from')} <span className="font-mono text-xs break-all">{file}</span>
              {t(', like')} <code className="text-xs">kubectl config delete-context</code>
              {t('. Its cluster and user entries go too if no other context uses them.')}
            </p>
            <p className="text-xs text-muted">
              {t('The file before the change is saved next to it as')}{' '}
              <span className="font-mono">.bak</span> {t('(when it lives in ~/.kube).')}
            </p>
          </>
        )}
        <p className="text-xs text-muted">
          {t('Nothing changes on the cluster itself — only this computer forgets how to reach it.')}
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}
