import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import {
  environmentId,
  PRODUCTION_ID,
  suggestShort,
  type ConfirmLevel,
  type EnvironmentDef
} from '@shared/environments'
import { EnvLabel } from '../../ds'
import { useHosts } from '../../stores/hosts'
import { groupOwnEnvironment, useEnvironments } from '../../stores/environments'
import { useSettings } from '../../stores/settings'
import { toast } from '../../stores/toasts'
import { useContextMenu } from '../ContextMenu'
import { Button, cx, Field, IconButton, Input, Modal, Notice, Segmented, Switch } from '../ui'

export function confirmLabel(level: ConfirmLevel): string {
  return level === 'type' ? t('Type name') : level === 'confirm' ? t('Confirm') : t('Undo toast')
}

/** Môi trường đang dùng ở đâu: số nhóm (tự đặt) và số nguồn (cluster / endpoint / tài khoản). */
function useUsage(): (id: string) => { groups: number; sources: number } {
  const groups = useHosts((s) => s.tree.groups)
  const sources = useSettings((s) => s.settings.sourceEnvironments)
  return useMemo(() => {
    const byGroup = new Map<string, number>()
    for (const g of groups) {
      const env = groupOwnEnvironment(g.defaults)
      if (env) byGroup.set(env, (byGroup.get(env) ?? 0) + 1)
    }
    const bySource = new Map<string, number>()
    for (const env of Object.values(sources)) bySource.set(env, (bySource.get(env) ?? 0) + 1)
    return (id) => ({ groups: byGroup.get(id) ?? 0, sources: bySource.get(id) ?? 0 })
  }, [groups, sources])
}

function save(list: EnvironmentDef[]): Promise<void> {
  return useSettings.getState().update({ environments: list })
}

/** Hộp thoại thêm / sửa một môi trường. */
function EnvironmentDialog({
  initial,
  taken,
  onSave,
  onClose
}: {
  initial: EnvironmentDef | null
  taken: ReadonlySet<string>
  onSave: (env: EnvironmentDef) => void
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [short, setShort] = useState(initial?.short ?? '')
  const [shortTouched, setShortTouched] = useState(initial !== null)
  const [description, setDescription] = useState(initial?.description ?? '')
  const [highlight, setHighlight] = useState(initial?.highlight ?? false)
  const [topLine, setTopLine] = useState(initial?.topLine ?? false)
  const [confirm, setConfirm] = useState<ConfirmLevel>(initial?.confirm ?? 'confirm')
  const [readOnly, setReadOnly] = useState(initial?.readOnly ?? false)
  const label = (shortTouched ? short : suggestShort(name)).trim()
  const problem = !name.trim()
    ? t('Enter a name')
    : !label
      ? t('Enter a short label')
      : label.length > 4
        ? t('The short label has at most 4 characters')
        : null
  const submit = (): void => {
    if (problem) return
    onSave({
      id: initial?.id ?? environmentId(name, taken),
      name: name.trim(),
      short: label,
      description: description.trim(),
      highlight,
      topLine,
      confirm,
      readOnly
    })
    onClose()
  }
  return (
    <Modal
      title={initial ? t('Edit environment') : t('New environment')}
      onClose={onClose}
      testId="environment-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={problem !== null}
            data-testid="environment-save"
            onClick={submit}
          >
            {t('Save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label={t('Name')}>
            <Input
              autoFocus
              value={name}
              data-testid="environment-name"
              onChange={(e) => {
                setName(e.target.value)
              }}
            />
          </Field>
          <Field label={t('Short label')}>
            <Input
              value={label}
              maxLength={4}
              data-testid="environment-short"
              onChange={(e) => {
                setShort(e.target.value)
                setShortTouched(true)
              }}
            />
          </Field>
        </div>
        <Field label={t('Description')}>
          <Input
            value={description}
            data-testid="environment-description"
            onChange={(e) => {
              setDescription(e.target.value)
            }}
          />
        </Field>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-muted">{t('Preview')}</span>
          <EnvLabel env={{ name: name || t('New environment'), short: label || '—', highlight }} />
        </div>
        <div className="flex flex-col gap-3">
          <Row
            title={t('Style')}
            description={t('Highlighted uses its own color; keep it for production only.')}
          >
            <Segmented
              value={highlight ? 'highlight' : 'neutral'}
              testIdPrefix="environment-style"
              options={[
                { value: 'neutral', label: t('Neutral') },
                { value: 'highlight', label: t('Highlighted') }
              ]}
              onChange={(v) => {
                setHighlight(v === 'highlight')
              }}
            />
          </Row>
          <Row
            title={t('Line at the top')}
            description={t('A thin line across the top of the content while you work here.')}
          >
            <Switch
              label={t('Line at the top')}
              checked={topLine}
              data-testid="environment-top-line"
              onChange={(e) => {
                setTopLine(e.target.checked)
              }}
            />
          </Row>
          <Row
            title={t('Before deleting')}
            description={t(
              'Type name: type the resource name. Confirm: a dialog. Undo toast: do it now, undo for 5 seconds.'
            )}
          >
            <Segmented
              value={confirm}
              testIdPrefix="environment-confirm"
              options={(['type', 'confirm', 'undo'] as const).map((v) => ({
                value: v,
                label: confirmLabel(v)
              }))}
              onChange={setConfirm}
            />
          </Row>
          <Row
            title={t('Read-only by default')}
            description={t(
              'Clusters, endpoints and accounts here hide actions that change things.'
            )}
          >
            <Switch
              label={t('Read-only by default')}
              checked={readOnly}
              data-testid="environment-read-only"
              onChange={(e) => {
                setReadOnly(e.target.checked)
              }}
            />
          </Row>
        </div>
        {problem && name && <Notice tone="warning">{problem}</Notice>}
      </form>
    </Modal>
  )
}

function Row({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        <div className="text-xs text-muted">{description}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Xoá môi trường đang được dùng: chọn môi trường thay thế cho các nhóm / nguồn đang dùng nó. */
function DeleteDialog({
  env,
  others,
  usage,
  onClose
}: {
  env: EnvironmentDef
  others: EnvironmentDef[]
  usage: { groups: number; sources: number }
  onClose: () => void
}): React.JSX.Element {
  const [replacement, setReplacement] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    setBusy(true)
    const next = replacement || null
    // Nhóm đang dùng (tự đặt, kể cả nhóm cũ chỉ có màu) → môi trường thay thế.
    for (const g of useHosts.getState().tree.groups) {
      if (groupOwnEnvironment(g.defaults) !== env.id) continue
      // Bỏ cả môi trường lẫn màu cũ (màu cũng là cách đặt môi trường trước đây).
      const rest = Object.fromEntries(
        Object.entries(g.defaults).filter(([k]) => k !== 'color' && k !== 'environment')
      )
      await window.shellhouse.saveGroup({
        id: g.id,
        name: g.name,
        parentId: g.parentId,
        defaults: next ? { ...rest, environment: next } : rest
      })
    }
    const settings = useSettings.getState().settings
    const sources = Object.fromEntries(
      Object.entries(settings.sourceEnvironments)
        .filter(([, v]) => v === env.id)
        .map(([k]) => [k, next])
    )
    await useSettings.getState().update({
      environments: settings.environments.filter((e) => e.id !== env.id),
      sourceEnvironments: sources
    })
    toast.success(t('Deleted {name}', { name: env.name }))
    onClose()
  }
  return (
    <Modal
      title={t('Delete “{name}”?', { name: env.name })}
      onClose={onClose}
      width="max-w-md"
      testId="environment-delete"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            data-testid="environment-delete-confirm"
            onClick={() => void run()}
          >
            {t('Delete')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted">
          {[
            usage.groups > 0 && tn(usage.groups, '{n} group uses it', '{n} groups use it'),
            usage.sources > 0 &&
              tn(
                usage.sources,
                '{n} cluster, endpoint or account uses it',
                '{n} clusters, endpoints or accounts use it'
              )
          ]
            .filter(Boolean)
            .join(' · ')}
          . {t('Move them to:')}
        </p>
        <div role="radiogroup" className="flex flex-wrap gap-1.5">
          {[null, ...others].map((o) => (
            <button
              key={o?.id ?? 'none'}
              type="button"
              role="radio"
              aria-checked={(o?.id ?? '') === replacement}
              data-testid={`environment-replace-${o?.id ?? 'none'}`}
              className={cx(
                'h-7 rounded-ds-md px-2.5 text-xs',
                (o?.id ?? '') === replacement
                  ? 'bg-ds-surface-2 text-fg shadow-[inset_0_0_0_1.5px_var(--ds-accent)]'
                  : 'text-muted shadow-[inset_0_0_0_1px_var(--ds-border)] hover:text-fg'
              )}
              onClick={() => {
                setReplacement(o?.id ?? '')
              }}
            >
              {o ? o.name : t('No environment')}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Settings › Workspace › Environments (thiết kế v0.6): môi trường dùng cho nhóm host, cluster,
 * Docker endpoint, tài khoản S3 — nhãn, vạch trên cùng, mức xác nhận khi xoá, chỉ đọc.
 */
export function EnvironmentsSection(): React.JSX.Element {
  const environments = useEnvironments()
  const usage = useUsage()
  const [editing, setEditing] = useState<EnvironmentDef | 'new' | null>(null)
  const [deleting, setDeleting] = useState<EnvironmentDef | null>(null)
  const { menu, open } = useContextMenu()
  const taken = new Set(environments.map((e) => e.id))
  const move = (index: number, delta: -1 | 1): void => {
    const list = [...environments]
    const [item] = list.splice(index, 1)
    if (!item) return
    list.splice(index + delta, 0, item)
    void save(list)
  }
  const remove = (env: EnvironmentDef): void => {
    const used = usage(env.id)
    if (used.groups + used.sources > 0) {
      setDeleting(env)
      return
    }
    void save(environments.filter((e) => e.id !== env.id)).then(() => {
      toast.success(t('Deleted {name}', { name: env.name }))
    })
  }
  return (
    <div data-testid="settings-environments">
      <div className="mb-4 flex items-start gap-4">
        <p className="flex-1 text-[13px] text-muted">
          {t(
            'Set an environment on a host group, cluster, Docker endpoint or S3 account. Everything inside inherits its label, the line at the top and how deleting is confirmed.'
          )}
        </p>
        <Button
          variant="primary"
          icon={<Plus size={14} />}
          data-testid="environment-new"
          onClick={() => {
            setEditing('new')
          }}
        >
          {t('New environment')}
        </Button>
      </div>
      <div
        role="table"
        aria-label={t('Environments')}
        className="divide-y divide-ds-border-subtle border-y border-ds-border-subtle"
      >
        <div
          role="row"
          className="grid h-8 grid-cols-[minmax(0,1fr)_6.5rem_5rem_6.5rem_6rem_2rem] items-center gap-3 px-1 text-xs font-medium text-faint"
        >
          <span role="columnheader">{t('Name')}</span>
          <span role="columnheader">{t('Style')}</span>
          <span role="columnheader">{t('Top line')}</span>
          <span role="columnheader">{t('Before deleting')}</span>
          <span role="columnheader">{t('Used by')}</span>
          <span role="columnheader" className="sr-only">
            {t('Actions')}
          </span>
        </div>
        {environments.map((env, i) => {
          const used = usage(env.id)
          const builtin = env.id === PRODUCTION_ID
          return (
            <div
              key={env.id}
              role="row"
              data-testid="environment-row"
              data-id={env.id}
              className="grid min-h-12 grid-cols-[minmax(0,1fr)_6.5rem_5rem_6.5rem_6rem_2rem] items-center gap-3 px-1 py-2 text-[13px]"
              onDoubleClick={() => {
                setEditing(env)
              }}
            >
              <div role="cell" className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-fg">{env.name}</span>
                  <EnvLabel env={env} />
                  {env.readOnly && <span className="text-xs text-faint">{t('Read-only')}</span>}
                </div>
                {env.description && (
                  <div className="truncate text-xs text-muted">{env.description}</div>
                )}
              </div>
              <span role="cell" className="text-muted">
                {env.highlight ? t('Highlighted') : t('Neutral')}
              </span>
              <span role="cell" className="text-muted">
                {env.topLine ? t('Yes') : t('No')}
              </span>
              <span role="cell" className="text-muted">
                {confirmLabel(env.confirm)}
              </span>
              <span role="cell" className="text-xs text-muted" data-testid="environment-used-by">
                {used.groups + used.sources === 0
                  ? '—'
                  : [
                      used.groups > 0 && tn(used.groups, '{n} group', '{n} groups'),
                      used.sources > 0 && tn(used.sources, '{n} source', '{n} sources')
                    ]
                      .filter(Boolean)
                      .join(', ')}
              </span>
              <span role="cell">
                <IconButton
                  label={t('Actions for {name}', { name: env.name })}
                  size="sm"
                  data-testid="environment-menu"
                  onClick={(e) => {
                    open(e, [
                      {
                        id: 'env-edit',
                        label: t('Edit…'),
                        icon: <Pencil size={14} />,
                        onSelect: () => {
                          setEditing(env)
                        }
                      },
                      {
                        id: 'env-duplicate',
                        label: t('Duplicate'),
                        icon: <Copy size={14} />,
                        onSelect: () => {
                          const copy = {
                            ...env,
                            id: environmentId(`${env.name} copy`, taken),
                            name: t('{name} copy', { name: env.name })
                          }
                          const list = [...environments]
                          list.splice(i + 1, 0, copy)
                          void save(list)
                        }
                      },
                      {
                        id: 'env-up',
                        label: t('Move up'),
                        icon: <ArrowUp size={14} />,
                        disabled: i === 0,
                        onSelect: () => {
                          move(i, -1)
                        }
                      },
                      {
                        id: 'env-down',
                        label: t('Move down'),
                        icon: <ArrowDown size={14} />,
                        disabled: i === environments.length - 1,
                        onSelect: () => {
                          move(i, 1)
                        }
                      },
                      'separator',
                      {
                        id: 'env-delete',
                        label: builtin ? t('Built-in, can’t be deleted') : t('Delete…'),
                        icon: <Trash2 size={14} />,
                        danger: !builtin,
                        disabled: builtin,
                        onSelect: () => {
                          remove(env)
                        }
                      }
                    ])
                  }}
                >
                  <MoreHorizontal size={15} />
                </IconButton>
              </span>
            </div>
          )
        })}
      </div>
      {menu}
      {editing && (
        <EnvironmentDialog
          initial={editing === 'new' ? null : editing}
          taken={taken}
          onClose={() => {
            setEditing(null)
          }}
          onSave={(env) => {
            const exists = environments.some((e) => e.id === env.id)
            void save(
              exists ? environments.map((e) => (e.id === env.id ? env : e)) : [...environments, env]
            )
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          env={deleting}
          others={environments.filter((e) => e.id !== deleting.id)}
          usage={usage(deleting.id)}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
