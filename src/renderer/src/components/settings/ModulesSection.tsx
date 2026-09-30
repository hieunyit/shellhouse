import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, Search, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import { MANIFESTS, manifestOf } from '../../../../modules/registry/manifests'
import { ModuleIcon, rendererModule, useModules } from '../../../../modules/registry/renderer-kit'
import { searchModules } from '../../../../modules/registry/search'
import {
  describePermission,
  MODULE_CATEGORIES,
  type ModuleCategory,
  type ModuleManifest
} from '../../../../modules/registry/types'
import { appRelease } from '../../lib/platform'
import { requestDisableModule, requestEnableModule, useModuleUi } from '../../stores/module-ui'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, cx, IconButton, Notice, Segmented, SectionTitle } from '../ui'

const DISCUSSIONS = 'https://github.com/hieunyit/shellhouse/discussions'

type StatusFilter = 'all' | 'enabled' | 'off'

/** Nhãn NEW: module có từ bản đang chạy và người dùng chưa mở thẻ. */
function isNew(m: ModuleManifest, seen: boolean): boolean {
  return !seen && m.since === appRelease()
}

/** "Adds a Docker section to the sidebar, a Docker tab and …" (3.12.1). */
export function describeContributions(m: ModuleManifest): string {
  const c = m.contributes
  const parts: string[] = []
  if (c.sidebarSection) parts.push(`a ${m.name} section to the sidebar`)
  if (c.hostActions?.length) parts.push(`a “${m.name}…” item to host menus`)
  if (c.tabKinds?.length) parts.push(c.tabKinds.length > 1 ? `${m.name} tabs` : `a ${m.name} tab`)
  if (c.commands?.length) parts.push('commands to the command palette')
  if (c.settings) parts.push('a settings page here')
  if (parts.length === 0) return ''
  const last = parts.pop()
  return `Adds ${parts.length ? `${parts.join(', ')} and ${last ?? ''}` : (last ?? '')}.`
}

/** Câu quyền hiển thị cho người dùng (3.12.3). */
export function permissionLines(m: ModuleManifest): string[] {
  const lines = m.permissions.map(describePermission)
  if (m.contributes.attachToSsh)
    lines.push('Never sees your SSH passwords or keys — it uses the connection Shellhouse opens')
  return lines
}

/** Settings → Modules: tìm, lọc, bật / tắt, trang chi tiết của từng module. */
export function ModulesSection(): React.JSX.Element {
  const states = useModules((s) => s.states)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ModuleCategory | 'all'>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [detail, setDetail] = useState<string | null>(
    () => useModuleUi.getState().browse?.module ?? null
  )
  const suggest = useSettings((s) => s.settings.moduleOptions.suggest)
  const update = useSettings((s) => s.update)

  // Trang đang mở mà có yêu cầu xem một module khác (gợi ý, bảng lệnh).
  useEffect(
    () =>
      useModuleUi.subscribe((st, prev) => {
        if (st.browse?.module && st.browse !== prev.browse) setDetail(st.browse.module)
      }),
    []
  )

  const items = useMemo(
    () =>
      MANIFESTS.map((manifest) => ({
        manifest,
        enabled: states[manifest.id]?.enabled === true,
        seen: states[manifest.id]?.seen === true
      })),
    [states]
  )
  const shown = useMemo(
    () =>
      searchModules(items, query).filter(
        (i) =>
          (category === 'all' || i.manifest.category === category) &&
          (status === 'all' || (status === 'enabled') === i.enabled)
      ),
    [items, query, category, status]
  )
  // Chỉ hiện chip của nhóm đang có module (và "All").
  const categories = MODULE_CATEGORIES.filter((c) => MANIFESTS.some((m) => m.category === c.id))

  const openDetail = (id: string): void => {
    setDetail(id)
    if (states[id]?.seen !== true) void update({ modules: { [id]: { seen: true } } })
  }

  const current = detail ? manifestOf(detail) : undefined
  if (current)
    return (
      <ModuleDetail
        manifest={current}
        enabled={states[current.id]?.enabled === true}
        onBack={() => {
          setDetail(null)
        }}
      />
    )

  return (
    <div className="flex flex-col gap-4" data-testid="settings-modules">
      <SectionTitle description="Modules add tools to Shellhouse. They ship with the app and are reviewed like the rest of it; turn on the ones you need.">
        Modules
      </SectionTitle>
      <div className="flex flex-col gap-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20">
          <Search size={14} className="text-faint" />
          <input
            type="search"
            autoFocus
            spellCheck={false}
            placeholder="Search modules…"
            data-testid="module-search"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Category">
            {[{ id: 'all' as const, title: 'All' }, ...categories].map((c) => (
              <button
                key={c.id}
                type="button"
                data-testid={`module-category-${c.id}`}
                aria-pressed={category === c.id}
                className={cx(
                  'h-7 rounded-full border px-3 text-xs font-medium transition-colors',
                  category === c.id
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-muted hover:bg-hover hover:text-fg'
                )}
                onClick={() => {
                  setCategory(c.id)
                }}
              >
                {c.title}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <Segmented
            value={status}
            onChange={setStatus}
            testIdPrefix="module-status"
            options={[
              { value: 'all', label: 'All' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'off', label: 'Off' }
            ]}
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-center text-[13px] text-muted">
          {query.trim() ? `No module matches “${query.trim()}”.` : 'No modules in this view.'}{' '}
          <a
            href={DISCUSSIONS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            Tell us what you need <ExternalLink size={12} />
          </a>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {shown.map(({ manifest: m, enabled, seen }) => {
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                data-testid="module-card"
                data-id={m.id}
                data-enabled={enabled}
                className="flex cursor-pointer flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-left shadow-xs transition-colors hover:border-line-strong"
                onClick={() => {
                  openDetail(m.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openDetail(m.id)
                }}
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <ModuleIcon name={m.icon} size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold text-fg">{m.name}</span>
                      {isNew(m, seen) && (
                        <span
                          className="rounded bg-accent-solid px-1 py-px text-[10px] font-semibold text-accent-fg"
                          data-testid="module-new"
                        >
                          NEW
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-faint">
                      {MODULE_CATEGORIES.find((c) => c.id === m.category)?.title} ·{' '}
                      {enabled ? 'Enabled' : 'Off'}
                    </div>
                  </div>
                  {enabled && rendererModule(m.id)?.SettingsPage && (
                    <IconButton
                      label={`${m.name} settings`}
                      size="sm"
                      data-testid={`module-settings-${m.id}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        openDetail(m.id)
                      }}
                    >
                      <Settings2 size={14} />
                    </IconButton>
                  )}
                  <ModuleSwitch id={m.id} name={m.name} enabled={enabled} />
                </div>
                <p className="text-xs text-muted">{m.summary}</p>
              </div>
            )
          })}
        </div>
      )}

      <Checkbox
        label="Suggest modules"
        description="When Shellhouse sees Docker on a server or a Kubernetes config on this computer, show a one-line suggestion. Nothing is sent anywhere."
        checked={suggest}
        data-testid="module-suggest"
        onChange={(e) => void update({ moduleOptions: { suggest: e.target.checked } })}
      />
    </div>
  )
}

/** Công tắc bật / tắt trên thẻ và trang chi tiết. */
function ModuleSwitch({
  id,
  name,
  enabled
}: {
  id: string
  name: string
  enabled: boolean
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  return (
    <span
      className="flex shrink-0 flex-col items-end"
      onClick={(e) => {
        e.stopPropagation()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? 'Turn off' : 'Enable'} ${name}`}
        data-testid={`module-toggle-${id}`}
        className={cx(
          'relative h-5 w-9 rounded-full transition-colors',
          enabled ? 'bg-accent-solid' : 'bg-line-strong'
        )}
        onClick={() => {
          setError(null)
          const action = enabled ? requestDisableModule(id) : requestEnableModule(id)
          action.catch((e: unknown) => {
            setError(
              e instanceof Error
                ? e.message.replace(/^Error invoking[^:]*: (Error: )?/, '')
                : String(e)
            )
          })
        }}
      >
        <span
          className={cx(
            'absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]',
            enabled ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
      {error && <span className="mt-1 max-w-40 text-right text-[11px] text-danger">{error}</span>}
    </span>
  )
}

function ModuleDetail({
  manifest: m,
  enabled,
  onBack
}: {
  manifest: ModuleManifest
  enabled: boolean
  onBack: () => void
}): React.JSX.Element {
  const SettingsPage = rendererModule(m.id)?.SettingsPage
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const contributes = describeContributions(m)
  return (
    <div className="flex flex-col gap-4" data-testid={`module-detail-${m.id}`}>
      <div>
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={onBack}>
          All modules
        </Button>
      </div>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <ModuleIcon name={m.icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{m.name}</h3>
          <p className="text-xs text-faint">
            {MODULE_CATEGORIES.find((c) => c.id === m.category)?.title} · Official · since
            Shellhouse {m.since} · data format v{m.version}
          </p>
        </div>
        <ModuleSwitch id={m.id} name={m.name} enabled={enabled} />
      </div>
      <div className="flex flex-col gap-2 text-[13px] text-muted">
        {m.description.split(/\n\s*\n/).map((p) => (
          <p key={p.slice(0, 40)}>{p}</p>
        ))}
        {contributes && <p>{contributes}</p>}
      </div>

      <div>
        <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wider text-faint uppercase">
          <ShieldCheck size={13} /> Permissions
        </h4>
        <ul className="flex flex-col gap-1 text-[13px] text-fg" data-testid="module-permissions">
          {permissionLines(m).map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-faint">•</span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      {enabled && SettingsPage && (
        <div className="border-t border-line pt-4">
          <SettingsPage />
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h4 className="text-xs font-semibold tracking-wider text-faint uppercase">Data</h4>
        {removed ? (
          <Notice tone="success">All {m.name} data was removed.</Notice>
        ) : (
          <>
            <p className="text-xs text-muted">
              Turning a module off keeps its data. Remove data deletes everything it saved on this
              computer (accounts, keys, settings for its connections).
              {enabled && ' Turn the module off first.'}
            </p>
            <div className="flex gap-2">
              <Button
                variant={confirmRemove ? 'danger' : 'danger-ghost'}
                size="sm"
                icon={<Trash2 size={13} />}
                disabled={enabled}
                data-testid="module-remove-data"
                onClick={() => {
                  if (!confirmRemove) {
                    setConfirmRemove(true)
                    return
                  }
                  setError(null)
                  window.shellhouse.removeModuleData(m.id).then(
                    () => {
                      setRemoved(true)
                      setConfirmRemove(false)
                    },
                    (e: unknown) => {
                      setError(e instanceof Error ? e.message : String(e))
                    }
                  )
                }}
              >
                {confirmRemove ? `Yes, remove all ${m.name} data` : 'Remove data…'}
              </Button>
              {confirmRemove && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmRemove(false)
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
          </>
        )}
      </div>
    </div>
  )
}
