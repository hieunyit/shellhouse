import { useMemo, useRef, useState } from 'react'
import { Code2, X } from 'lucide-react'
import { stringify } from 'yaml'
import {
  Button,
  Input,
  Notice,
  Select,
  cx,
  useEscapeToClose,
  useFocusTrap
} from '../../../renderer/src/components/ui'
import { confirmAction, t, tn } from '../../registry/renderer-kit'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  KIND_ID,
  type ConfigMapForm,
  type FormKind,
  type HpaForm,
  type IngressForm,
  type NamespaceForm,
  type PvcForm,
  type SecretForm,
  type ServiceForm,
  type WorkloadForm
} from '../shared/forms'
import type { ApplyResult } from '../shared/ops'
import { KindIcon } from './icons'
import { type Request, groups, WORKLOAD_KINDS, type AnyForm, initial, build } from './create/model'
import { lookupCache, useLookups, existingObjects } from './create/useLookups'
import { Section, F, invalid, Grid, KVEditor, NamespaceSelect, NameInput, Pick } from './create/kit'
import { WorkloadEditor } from './create/WorkloadEditor'
import { ServiceEditor } from './create/ServiceEditor'
import { IngressEditor } from './create/IngressEditor'
import { SecretEditor } from './create/SecretEditor'

/**
 * Tạo tài nguyên bằng form (kiểu Rancher / Lens): chọn loại, điền thông tin (ô chọn lấy từ cluster),
 * xem YAML sinh ra trực tiếp; "Edit as YAML" để chỉnh tay trước khi tạo.
 */
export function CreateResourceDialog({
  request,
  namespaces,
  defaultNamespace,
  initialKind = 'Deployment',
  onClose,
  onCreated,
  onEditYaml
}: {
  request: Request
  namespaces: readonly string[]
  defaultNamespace: string
  initialKind?: FormKind
  onClose: () => void
  /** Đã tạo: mở đối tượng chính. */
  onCreated: (kindId: string, namespace: string | undefined, name: string, summary: string) => void
  /** Chuyển sang trình sửa YAML với nội dung đã sinh. */
  onEditYaml: (yaml: string) => void
}): React.JSX.Element {
  const [form, setForm] = useState<AnyForm>(() => initial(initialKind, defaultNamespace))
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [showYaml, setShowYaml] = useState(true)
  const ns = 'namespace' in form.f ? form.f.namespace : ''
  const lookups = useLookups(request, ns)
  const { docs, errors } = useMemo(() => build(form), [form])
  const yaml = useMemo(
    () =>
      docs.map((d) => stringify(d, { lineWidth: 0, aliasDuplicateObjects: false })).join('---\n'),
    [docs]
  )
  const shown = showErrors ? errors : {}
  const kindGroups = groups()
  const errorCount = Object.keys(errors).length
  // Đã điền gì chưa: so với form trống của cùng loại (đổi loại mà chưa điền gì → vẫn "sạch").
  const pristine = useMemo(() => {
    const blank = build(initial(form.kind, defaultNamespace)).docs
    return blank
      .map((d) => stringify(d, { lineWidth: 0, aliasDuplicateObjects: false }))
      .join('---\n')
  }, [form.kind, defaultNamespace])
  const dirty = yaml !== pristine
  const requestClose = (): void => {
    if (!dirty) {
      onClose()
      return
    }
    void confirmAction({
      title: t('Discard this form?'),
      message: t('What you filled in has not been created.'),
      confirmLabel: t('Discard'),
      danger: true,
      testId: 'k8s-create-discard'
    }).then((ok) => {
      if (ok) onClose()
    })
  }
  useEscapeToClose(requestClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)

  const pick = (kind: FormKind): void => {
    // Giữ tên / namespace khi đổi loại.
    const next = initial(kind, ns || defaultNamespace)
    if ('name' in form.f && form.f.name) (next.f as { name: string }).name = form.f.name
    setForm(next)
    setShowErrors(false)
    setFailure(null)
  }

  const create = async (): Promise<void> => {
    if (busy) return
    if (errorCount) {
      setShowErrors(true)
      return
    }
    setBusy(true)
    setFailure(null)
    // Server-side apply sửa đè đối tượng cùng tên → hỏi trước khi "tạo" mà thật ra là cập nhật.
    const existing = await existingObjects(request, docs, ns || defaultNamespace)
    if (existing.length) {
      const ok = await confirmAction({
        title: tn(existing.length, 'Already exists', '{n} objects already exist'),
        message: tn(
          existing.length,
          '{objects} is already in the cluster. Continuing updates it with this form — fields you did not fill in may be reset.',
          '{objects} are already in the cluster. Continuing updates them with this form — fields you did not fill in may be reset.',
          { objects: existing.join(', ') }
        ),
        confirmLabel: t('Update existing'),
        danger: true,
        testId: 'k8s-create-exists'
      })
      if (!ok) {
        setBusy(false)
        return
      }
    }
    request<ApplyResult[]>({ op: 'serverApply', yaml, ...(ns ? { namespace: ns } : {}) }).then(
      (results) => {
        setBusy(false)
        lookupCache.get(request)?.delete(ns)
        const bad = results.filter((r) => r.action === 'error')
        if (bad.length) {
          setFailure(bad.map((r) => `${r.object}: ${r.error ?? t('failed')}`).join('\n'))
          return
        }
        const main = docs[0] as { kind?: string; metadata?: { name?: string; namespace?: string } }
        const name = main.metadata?.name ?? ''
        onCreated(
          KIND_ID[form.kind],
          main.metadata?.namespace,
          name,
          results.map((r) => r.object).join(', ')
        )
        onClose()
      },
      (e: unknown) => {
        setBusy(false)
        setFailure(cleanError(e))
      }
    )
  }

  const setW = (patch: Partial<WorkloadForm>): void => {
    setForm((cur) =>
      WORKLOAD_KINDS.includes(cur.kind)
        ? ({ ...cur, f: { ...(cur.f as WorkloadForm), ...patch } } as AnyForm)
        : cur
    )
  }
  const setF = <T,>(patch: Partial<T>): void => {
    setForm((cur) => ({ ...cur, f: { ...cur.f, ...patch } }) as AnyForm)
  }

  return (
    <div className="bg-overlay animate-fade-in fixed inset-0 z-40 flex items-center justify-center p-6 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('Create a resource')}
        data-testid="k8s-create-dialog"
        className="shadow-elevated animate-dialog-in flex h-full max-h-[52rem] w-full max-w-[90rem] flex-col overflow-hidden rounded-xl border border-line bg-elevated"
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <KindIcon kind={KIND_ID[form.kind]} size={26} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">
              {t('Create {kind}', {
                kind:
                  kindGroups.flatMap((g) => g.kinds).find((k) => k.kind === form.kind)?.label ?? ''
              })}
            </h2>
            <p className="text-xs text-muted">
              {t('Fill in the form — the YAML on the right updates as you type.')}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Code2 size={14} />}
            onClick={() => {
              setShowYaml((s) => !s)
            }}
          >
            {showYaml ? t('Hide YAML') : t('Show YAML')}
          </Button>
          <button
            type="button"
            aria-label={t('Close')}
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav
            className="w-56 shrink-0 overflow-auto border-r border-line bg-subtle/50 p-2"
            aria-label={t('Resource type')}
          >
            {kindGroups.map((g) => (
              <div key={g.title} className="mb-3">
                <div className="px-2 pb-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase">
                  {g.title}
                </div>
                {g.kinds.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    data-testid={`k8s-create-kind-${k.kind}`}
                    aria-current={form.kind === k.kind}
                    className={cx(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                      form.kind === k.kind
                        ? 'bg-surface shadow-xs ring-1 ring-line'
                        : 'hover:bg-hover'
                    )}
                    onClick={() => {
                      pick(k.kind)
                    }}
                  >
                    <KindIcon kind={KIND_ID[k.kind]} size={20} />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-fg">{k.label}</span>
                      <span className="block truncate text-[10.5px] text-faint">{k.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div
            className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto bg-canvas p-4"
            data-testid="k8s-create-form"
          >
            {WORKLOAD_KINDS.includes(form.kind) && (
              <WorkloadEditor
                f={form.f as WorkloadForm}
                set={setW}
                errors={shown}
                namespaces={namespaces}
                lookups={lookups}
              />
            )}
            {form.kind === 'Service' && (
              <ServiceEditor
                f={form.f}
                set={setF<ServiceForm>}
                errors={shown}
                namespaces={namespaces}
              />
            )}
            {form.kind === 'Ingress' && (
              <IngressEditor
                f={form.f}
                set={setF<IngressForm>}
                errors={shown}
                namespaces={namespaces}
                lookups={lookups}
              />
            )}
            {form.kind === 'ConfigMap' && (
              <>
                <Section title={t('General')}>
                  <Grid>
                    <NameInput
                      value={form.f.name}
                      error={shown['name']}
                      placeholder="app-config"
                      onChange={(name) => {
                        setF<ConfigMapForm>({ name })
                      }}
                    />
                    <NamespaceSelect
                      value={form.f.namespace}
                      namespaces={namespaces}
                      error={shown['namespace']}
                      onChange={(namespace) => {
                        setF<ConfigMapForm>({ namespace })
                      }}
                    />
                  </Grid>
                </Section>
                <Section
                  title={t('Data')}
                  description={t('Each key becomes an environment variable or a file when mounted')}
                >
                  <KVEditor
                    value={form.f.data}
                    errors={shown}
                    path="data"
                    multiline
                    addLabel={t('Add key')}
                    testId="k8s-form-data"
                    onChange={(data) => {
                      setF<ConfigMapForm>({ data })
                    }}
                  />
                </Section>
              </>
            )}
            {form.kind === 'Secret' && (
              <SecretEditor
                f={form.f}
                set={setF<SecretForm>}
                errors={shown}
                namespaces={namespaces}
              />
            )}
            {form.kind === 'PersistentVolumeClaim' && (
              <Section
                title={t('Volume claim')}
                description={t('Storage that survives pod restarts')}
              >
                <Grid>
                  <NameInput
                    value={form.f.name}
                    error={shown['name']}
                    placeholder="data"
                    onChange={(name) => {
                      setF<PvcForm>({ name })
                    }}
                  />
                  <NamespaceSelect
                    value={form.f.namespace}
                    namespaces={namespaces}
                    error={shown['namespace']}
                    onChange={(namespace) => {
                      setF<PvcForm>({ namespace })
                    }}
                  />
                </Grid>
                <Grid cols={3}>
                  <F
                    label={t('Size')}
                    required
                    error={shown['size']}
                    hint={t('e.g. {examples}', { examples: '10Gi' })}
                  >
                    <Input
                      mono
                      value={form.f.size}
                      className={invalid(shown['size'])}
                      onChange={(e) => {
                        setF<PvcForm>({ size: e.target.value })
                      }}
                    />
                  </F>
                  <F label={t('Storage class')} hint={t('Empty = cluster default')}>
                    <Pick
                      value={form.f.storageClass}
                      options={lookups.storageClasses}
                      placeholder={t('default')}
                      onChange={(storageClass) => {
                        setF<PvcForm>({ storageClass })
                      }}
                    />
                  </F>
                  <F label={t('Access mode')}>
                    <Select
                      value={form.f.accessMode}
                      onChange={(e) => {
                        setF<PvcForm>({ accessMode: e.target.value as PvcForm['accessMode'] })
                      }}
                    >
                      <option value="ReadWriteOnce">{t('Read-write, one node')}</option>
                      <option value="ReadWriteOncePod">{t('Read-write, one pod')}</option>
                      <option value="ReadOnlyMany">{t('Read-only, many nodes')}</option>
                      <option value="ReadWriteMany">{t('Read-write, many nodes')}</option>
                    </Select>
                  </F>
                </Grid>
              </Section>
            )}
            {form.kind === 'HorizontalPodAutoscaler' && (
              <Section
                title={t('Autoscaler')}
                description={t('Add or remove pods to keep usage near the target')}
              >
                <Grid>
                  <NameInput
                    value={form.f.name}
                    error={shown['name']}
                    onChange={(name) => {
                      setF<HpaForm>({ name })
                    }}
                  />
                  <NamespaceSelect
                    value={form.f.namespace}
                    namespaces={namespaces}
                    error={shown['namespace']}
                    onChange={(namespace) => {
                      setF<HpaForm>({ namespace })
                    }}
                  />
                </Grid>
                <Grid>
                  <F label={t('Workload kind')}>
                    <Select
                      value={form.f.targetKind}
                      onChange={(e) => {
                        setF<HpaForm>({
                          targetKind: e.target.value as HpaForm['targetKind'],
                          target: ''
                        })
                      }}
                    >
                      <option>Deployment</option>
                      <option>StatefulSet</option>
                    </Select>
                  </F>
                  <F label={t('Workload')} required error={shown['target']}>
                    <Pick
                      value={form.f.target}
                      options={
                        form.f.targetKind === 'Deployment'
                          ? lookups.deployments
                          : lookups.statefulSets
                      }
                      placeholder={t('name')}
                      error={shown['target']}
                      onChange={(target) => {
                        setF<HpaForm>({ target, ...(form.f.name ? {} : { name: target }) })
                      }}
                    />
                  </F>
                </Grid>
                <Grid cols={4}>
                  <F label={t('Min pods')} error={shown['min']}>
                    <Input
                      mono
                      value={form.f.min}
                      onChange={(e) => {
                        setF<HpaForm>({ min: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                  <F label={t('Max pods')} error={shown['max']}>
                    <Input
                      mono
                      value={form.f.max}
                      onChange={(e) => {
                        setF<HpaForm>({ max: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                  <F label={t('CPU target %')} error={shown['cpu']} hint={t('of requests')}>
                    <Input
                      mono
                      value={form.f.cpu}
                      onChange={(e) => {
                        setF<HpaForm>({ cpu: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                  <F label={t('Memory target %')} error={shown['memory']}>
                    <Input
                      mono
                      value={form.f.memory}
                      placeholder={t('off')}
                      onChange={(e) => {
                        setF<HpaForm>({ memory: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                </Grid>
              </Section>
            )}
            {form.kind === 'Namespace' && (
              <Section title="Namespace">
                <NameInput
                  value={form.f.name}
                  error={shown['name']}
                  placeholder="team-a"
                  onChange={(name) => {
                    setF<NamespaceForm>({ name })
                  }}
                />
                <F label={t('Labels')}>
                  <KVEditor
                    value={form.f.labels}
                    errors={shown}
                    path="labels"
                    addLabel={t('Add label')}
                    onChange={(labels) => {
                      setF<NamespaceForm>({ labels })
                    }}
                  />
                </F>
              </Section>
            )}
          </div>
          {showYaml && (
            <aside className="flex w-[26rem] shrink-0 flex-col border-l border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
                <span className="font-semibold text-fg">{t('YAML preview')}</span>
                <span className="text-faint">{tn(docs.length, '{n} object', '{n} objects')}</span>
                <button
                  type="button"
                  className="ml-auto text-accent hover:underline"
                  data-testid="k8s-create-edit-yaml"
                  onClick={() => {
                    // Chuyển sang trình sửa YAML (thay hộp thoại này) — không gọi onClose: nó đóng
                    // luôn hộp thoại YAML vừa mở.
                    onEditYaml(yaml)
                  }}
                >
                  {t('Edit as YAML')}
                </button>
              </div>
              <pre
                className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-fg select-text"
                data-testid="k8s-create-yaml"
              >
                {yaml}
              </pre>
            </aside>
          )}
        </div>
        {failure && (
          <div className="border-t border-line px-5 py-2">
            <Notice tone="danger" testId="k8s-create-error">
              <span className="whitespace-pre-wrap">{failure}</span>
            </Notice>
          </div>
        )}
        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          {showErrors && errorCount > 0 ? (
            <span className="text-xs text-danger" data-testid="k8s-create-invalid">
              {tn(
                errorCount,
                'Fix {n} field highlighted in red.',
                'Fix {n} fields highlighted in red.'
              )}
            </span>
          ) : (
            <span className="text-xs text-faint">
              {t('Created with server-side apply — running it again updates the same objects.')}
            </span>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={requestClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="k8s-create-submit"
            onClick={() => void create()}
          >
            {busy ? t('Creating…') : t('Create')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
