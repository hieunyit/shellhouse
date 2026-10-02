import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, Code2, Plus, Trash2, X } from 'lucide-react'
import { stringify } from 'yaml'
import {
  Button,
  Checkbox,
  Input,
  Notice,
  Segmented,
  Select,
  TextArea,
  cx,
  useEscapeToClose
} from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  KIND_ID,
  configMapManifest,
  emptyContainer,
  emptyServicePort,
  emptyWorkload,
  hpaManifest,
  ingressManifest,
  namespaceManifest,
  pvcManifest,
  secretManifest,
  serviceManifest,
  validateConfigMap,
  validateHpa,
  validateIngress,
  validateNamespace,
  validatePvc,
  validateSecret,
  validateService,
  validateWorkload,
  workloadManifests,
  type ConfigMapForm,
  type ContainerForm,
  type FieldErrors,
  type FormKind,
  type HpaForm,
  type IngressForm,
  type KV,
  type NamespaceForm,
  type ProbeForm,
  type PvcForm,
  type SecretForm,
  type ServiceForm,
  type ServicePortForm,
  type WorkloadForm,
  type WorkloadKind
} from '../shared/forms'
import type { ApplyResult, K8sOp } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import { KindIcon } from './icons'

type Request = <T>(op: K8sOp) => Promise<T>

const GROUPS: { title: string; kinds: { kind: FormKind; label: string; hint: string }[] }[] = [
  {
    title: 'Workloads',
    kinds: [
      { kind: 'Deployment', label: 'Deployment', hint: 'Stateless app with rolling updates' },
      { kind: 'StatefulSet', label: 'StatefulSet', hint: 'Stable names and storage per pod' },
      { kind: 'DaemonSet', label: 'DaemonSet', hint: 'One pod on every node' },
      { kind: 'Job', label: 'Job', hint: 'Run to completion once' },
      { kind: 'CronJob', label: 'CronJob', hint: 'Run on a schedule' }
    ]
  },
  {
    title: 'Networking',
    kinds: [
      { kind: 'Service', label: 'Service', hint: 'Stable address for pods' },
      { kind: 'Ingress', label: 'Ingress', hint: 'HTTP(S) routes from outside' }
    ]
  },
  {
    title: 'Config & storage',
    kinds: [
      { kind: 'ConfigMap', label: 'ConfigMap', hint: 'Settings and config files' },
      { kind: 'Secret', label: 'Secret', hint: 'Passwords, keys, registry login' },
      { kind: 'PersistentVolumeClaim', label: 'Volume claim', hint: 'Persistent storage' }
    ]
  },
  {
    title: 'Cluster',
    kinds: [
      { kind: 'HorizontalPodAutoscaler', label: 'Autoscaler', hint: 'Scale on CPU / memory' },
      { kind: 'Namespace', label: 'Namespace', hint: 'Group of resources' }
    ]
  }
]

const WORKLOAD_KINDS: readonly string[] = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob'
]

interface Lookups {
  configMaps: string[]
  secrets: string[]
  pvcs: string[]
  services: { name: string; ports: string[] }[]
  deployments: string[]
  statefulSets: string[]
  storageClasses: string[]
  ingressClasses: string[]
}

const NO_LOOKUPS: Lookups = {
  configMaps: [],
  secrets: [],
  pvcs: [],
  services: [],
  deployments: [],
  statefulSets: [],
  storageClasses: [],
  ingressClasses: []
}

/** Tên đối tượng trong namespace (cho ô chọn) — lỗi / không có quyền → rỗng. */
function useLookups(request: Request, namespace: string): Lookups {
  const [data, setData] = useState<Lookups>(NO_LOOKUPS)
  useEffect(() => {
    let cancelled = false
    const list = (kind: string, ns?: string): Promise<K8sObject[]> =>
      request<{ items: K8sObject[] }>({
        op: 'list',
        kind,
        ...(ns ? { namespace: ns } : {}),
        limit: 500
      }).then(
        (r) => r.items,
        () => []
      )
    const names = (items: K8sObject[]): string[] => items.map((x) => x.metadata.name).sort()
    void Promise.all([
      namespace ? list('configmaps', namespace) : [],
      namespace ? list('secrets', namespace) : [],
      namespace ? list('persistentvolumeclaims', namespace) : [],
      namespace ? list('services', namespace) : [],
      namespace ? list('deployments.apps', namespace) : [],
      namespace ? list('statefulsets.apps', namespace) : [],
      list('storageclasses.storage.k8s.io'),
      list('ingressclasses.networking.k8s.io')
    ]).then(([cm, sec, pvc, svc, dep, sts, sc, ic]) => {
      if (cancelled) return
      setData({
        configMaps: names(cm).filter((n) => n !== 'kube-root-ca.crt'),
        secrets: names(sec),
        pvcs: names(pvc),
        services: svc
          .map((s) => ({
            name: s.metadata.name,
            ports: (
              (s.spec?.['ports'] as { port?: number; name?: string }[] | undefined) ?? []
            ).map((p) => String(p.port ?? p.name ?? ''))
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        deployments: names(dep),
        statefulSets: names(sts),
        storageClasses: names(sc),
        ingressClasses: names(ic)
      })
    })
    return () => {
      cancelled = true
    }
  }, [request, namespace])
  return data
}

// ——— Khối giao diện dùng chung ———

function Section({
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = true,
  testId
}: {
  title: string
  description?: string
  children: React.ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  testId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-lg border border-line bg-surface" data-testid={testId}>
      <button
        type="button"
        disabled={!collapsible}
        className="flex w-full items-start gap-2 px-4 py-3 text-left"
        onClick={() => {
          setOpen((o) => !o)
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">{title}</div>
          {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
        </div>
        {collapsible && (
          <ChevronDown
            size={15}
            className={cx('mt-0.5 text-faint transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      {open && <div className="flex flex-col gap-3 border-t border-line px-4 py-3">{children}</div>}
    </section>
  )
}

function F({
  label,
  hint,
  error,
  required,
  className,
  children
}: {
  label: string
  hint?: React.ReactNode
  error?: string | undefined
  required?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-xs font-medium text-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {error ? (
        <span className="text-[11px] text-danger" data-testid="k8s-form-error">
          {error}
        </span>
      ) : (
        hint && <span className="text-[11px] text-faint">{hint}</span>
      )}
    </label>
  )
}

const invalid = (e: string | undefined): string | undefined =>
  e ? 'border-danger focus:border-danger focus:ring-danger/20' : undefined

function Grid({
  cols = 2,
  children
}: {
  cols?: 2 | 3 | 4
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'grid gap-3',
        cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-4'
      )}
    >
      {children}
    </div>
  )
}

function RowButton({
  label,
  onClick,
  testId
}: {
  label: string
  onClick: () => void
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
      onClick={onClick}
    >
      <Plus size={13} /> {label}
    </button>
  )
}

function RemoveButton({
  onClick,
  label = 'Remove'
}: {
  onClick: () => void
  label?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"
      onClick={onClick}
    >
      <Trash2 size={14} />
    </button>
  )
}

/** Danh sách key = value (nhãn, annotation, dữ liệu ConfigMap…). */
function KVEditor({
  value,
  onChange,
  errors,
  path,
  keyLabel = 'Key',
  valueLabel = 'Value',
  addLabel = 'Add',
  multiline = false,
  secret = false,
  testId
}: {
  value: KV[]
  onChange: (v: KV[]) => void
  errors: FieldErrors
  path: string
  keyLabel?: string
  valueLabel?: string
  addLabel?: string
  multiline?: boolean
  secret?: boolean
  testId?: string
}): React.JSX.Element {
  const set = (i: number, patch: Partial<KV>): void => {
    onChange(value.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)))
  }
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {value.map((kv, i) => (
        <div key={i} className={cx('flex gap-2', multiline ? 'items-start' : 'items-start')}>
          <F
            label={i === 0 ? keyLabel : ''}
            error={errors[`${path}.${String(i)}.key`]}
            className="w-2/5"
          >
            <Input
              mono
              value={kv.key}
              placeholder={keyLabel.toLowerCase()}
              className={invalid(errors[`${path}.${String(i)}.key`])}
              onChange={(e) => {
                set(i, { key: e.target.value })
              }}
            />
          </F>
          <F
            label={i === 0 ? valueLabel : ''}
            error={errors[`${path}.${String(i)}.value`]}
            className="flex-1"
          >
            {multiline ? (
              <TextArea
                rows={Math.min(8, Math.max(1, kv.value.split('\n').length))}
                value={kv.value}
                placeholder="value"
                onChange={(e) => {
                  set(i, { value: e.target.value })
                }}
              />
            ) : (
              <Input
                mono
                type={secret ? 'password' : 'text'}
                value={kv.value}
                placeholder="value"
                className={invalid(errors[`${path}.${String(i)}.value`])}
                onChange={(e) => {
                  set(i, { value: e.target.value })
                }}
              />
            )}
          </F>
          <div className={i === 0 ? 'pt-5' : ''}>
            <RemoveButton
              onClick={() => {
                onChange(value.filter((_, j) => j !== i))
              }}
            />
          </div>
        </div>
      ))}
      <RowButton
        label={addLabel}
        onClick={() => {
          onChange([...value, { key: '', value: '' }])
        }}
      />
    </div>
  )
}

function NamespaceSelect({
  value,
  namespaces,
  onChange,
  error
}: {
  value: string
  namespaces: readonly string[]
  onChange: (v: string) => void
  error: string | undefined
}): React.JSX.Element {
  return (
    <F label="Namespace" required error={error}>
      <Select
        value={value}
        data-testid="k8s-form-namespace"
        className={invalid(error)}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      >
        <option value="">Choose…</option>
        {namespaces.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </F>
  )
}

function NameInput({
  value,
  onChange,
  error,
  placeholder = 'my-app'
}: {
  value: string
  onChange: (v: string) => void
  error: string | undefined
  placeholder?: string
}): React.JSX.Element {
  return (
    <F label="Name" required error={error} hint="Lowercase letters, digits and “-”">
      <Input
        mono
        autoFocus
        value={value}
        placeholder={placeholder}
        data-testid="k8s-form-name"
        className={invalid(error)}
        onChange={(e) => {
          onChange(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, '-'))
        }}
      />
    </F>
  )
}

/** Chọn một tên trong danh sách cluster, vẫn cho gõ tay (chưa tạo / không có quyền list). */
function Pick({
  value,
  options,
  onChange,
  placeholder,
  error,
  testId
}: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  placeholder: string
  error?: string | undefined
  testId?: string
}): React.JSX.Element {
  const id = `pick-${useId().replace(/:/g, '')}`
  return (
    <>
      <Input
        mono
        list={id}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        className={invalid(error)}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  )
}

// ——— Form workload ———

function ProbeEditor({
  title,
  value,
  onChange,
  errors,
  path
}: {
  title: string
  value: ProbeForm
  onChange: (v: ProbeForm) => void
  errors: FieldErrors
  path: string
}): React.JSX.Element {
  const set = (patch: Partial<ProbeForm>): void => {
    onChange({ ...value, ...patch })
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="w-20 text-xs font-medium text-muted">{title}</span>
        <Segmented
          value={value.type}
          options={[
            { value: 'none', label: 'None' },
            { value: 'http', label: 'HTTP' },
            { value: 'tcp', label: 'TCP' },
            { value: 'exec', label: 'Command' }
          ]}
          onChange={(type) => {
            set({ type })
          }}
        />
      </div>
      {value.type !== 'none' && (
        <Grid cols={4}>
          {value.type === 'http' && (
            <F label="Path" error={errors[`${path}.path`]}>
              <Input
                mono
                value={value.path}
                onChange={(e) => {
                  set({ path: e.target.value })
                }}
              />
            </F>
          )}
          {(value.type === 'http' || value.type === 'tcp') && (
            <F label="Port" error={errors[`${path}.port`]} hint="Number or port name">
              <Input
                mono
                value={value.port}
                placeholder="8080"
                className={invalid(errors[`${path}.port`])}
                onChange={(e) => {
                  set({ port: e.target.value })
                }}
              />
            </F>
          )}
          {value.type === 'exec' && (
            <F label="Command" error={errors[`${path}.command`]} className="col-span-2">
              <Input
                mono
                value={value.command}
                placeholder="cat /tmp/healthy"
                onChange={(e) => {
                  set({ command: e.target.value })
                }}
              />
            </F>
          )}
          <F label="Initial delay (s)">
            <Input
              mono
              value={value.initialDelay}
              placeholder="0"
              onChange={(e) => {
                set({ initialDelay: e.target.value.replace(/\D/g, '') })
              }}
            />
          </F>
          <F label="Every (s)">
            <Input
              mono
              value={value.period}
              placeholder="10"
              onChange={(e) => {
                set({ period: e.target.value.replace(/\D/g, '') })
              }}
            />
          </F>
        </Grid>
      )}
    </div>
  )
}

function ContainerEditor({
  value,
  onChange,
  errors,
  path,
  lookups,
  volumes
}: {
  value: ContainerForm
  onChange: (v: ContainerForm) => void
  errors: FieldErrors
  path: string
  lookups: Lookups
  volumes: string[]
}): React.JSX.Element {
  const set = (patch: Partial<ContainerForm>): void => {
    onChange({ ...value, ...patch })
  }
  const e = (k: string): string | undefined => errors[`${path}.${k}`]
  return (
    <div className="flex flex-col gap-4">
      <Grid>
        <F label="Image" required error={e('image')} hint="e.g. nginx:1.27, ghcr.io/acme/api:1.2">
          <Input
            mono
            value={value.image}
            placeholder="registry/image:tag"
            data-testid="k8s-form-image"
            className={invalid(e('image'))}
            onChange={(ev) => {
              set({ image: ev.target.value })
            }}
          />
        </F>
        <Grid>
          <F label="Name" required error={e('name')}>
            <Input
              mono
              value={value.name}
              className={invalid(e('name'))}
              onChange={(ev) => {
                set({ name: ev.target.value })
              }}
            />
          </F>
          <F label="Pull policy">
            <Select
              value={value.pullPolicy}
              onChange={(ev) => {
                set({ pullPolicy: ev.target.value as ContainerForm['pullPolicy'] })
              }}
            >
              <option value="">Default</option>
              <option value="IfNotPresent">If not present</option>
              <option value="Always">Always</option>
              <option value="Never">Never</option>
            </Select>
          </F>
        </Grid>
      </Grid>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-fg">Ports</span>
        {value.ports.map((p, i) => (
          <div key={i} className="flex items-start gap-2">
            <F label={i === 0 ? 'Name' : ''} className="w-40">
              <Input
                mono
                value={p.name}
                placeholder="http"
                onChange={(ev) => {
                  set({
                    ports: value.ports.map((x, j) =>
                      j === i ? { ...x, name: ev.target.value } : x
                    )
                  })
                }}
              />
            </F>
            <F
              label={i === 0 ? 'Container port' : ''}
              error={e(`ports.${String(i)}.port`)}
              className="w-36"
            >
              <Input
                mono
                value={p.port}
                placeholder="8080"
                data-testid="k8s-form-port"
                className={invalid(e(`ports.${String(i)}.port`))}
                onChange={(ev) => {
                  set({
                    ports: value.ports.map((x, j) =>
                      j === i ? { ...x, port: ev.target.value.replace(/\D/g, '') } : x
                    )
                  })
                }}
              />
            </F>
            <F label={i === 0 ? 'Protocol' : ''} className="w-28">
              <Select
                value={p.protocol}
                onChange={(ev) => {
                  set({
                    ports: value.ports.map((x, j) =>
                      j === i ? { ...x, protocol: ev.target.value as 'TCP' | 'UDP' } : x
                    )
                  })
                }}
              >
                <option>TCP</option>
                <option>UDP</option>
              </Select>
            </F>
            <div className={i === 0 ? 'pt-5' : ''}>
              <RemoveButton
                onClick={() => {
                  set({ ports: value.ports.filter((_, j) => j !== i) })
                }}
              />
            </div>
          </div>
        ))}
        <RowButton
          label="Add port"
          testId="k8s-form-add-port"
          onClick={() => {
            set({
              ports: [
                ...value.ports,
                { name: value.ports.length ? '' : 'http', port: '', protocol: 'TCP' }
              ]
            })
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-fg">Environment variables</span>
        {value.env.map((env, i) => {
          const setEnv = (patch: Partial<typeof env>): void => {
            set({ env: value.env.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const p = `env.${String(i)}`
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? 'Name' : ''} error={e(`${p}.name`)} className="w-48">
                <Input
                  mono
                  value={env.name}
                  placeholder="NAME"
                  className={invalid(e(`${p}.name`))}
                  onChange={(ev) => {
                    setEnv({ name: ev.target.value })
                  }}
                />
              </F>
              <F label={i === 0 ? 'Source' : ''} className="w-36">
                <Select
                  value={env.source}
                  onChange={(ev) => {
                    setEnv({ source: ev.target.value as typeof env.source, ref: '', key: '' })
                  }}
                >
                  <option value="value">Value</option>
                  <option value="configmap">ConfigMap key</option>
                  <option value="secret">Secret key</option>
                </Select>
              </F>
              {env.source === 'value' ? (
                <F label={i === 0 ? 'Value' : ''} className="flex-1">
                  <Input
                    mono
                    value={env.value}
                    onChange={(ev) => {
                      setEnv({ value: ev.target.value })
                    }}
                  />
                </F>
              ) : (
                <>
                  <F
                    label={i === 0 ? (env.source === 'secret' ? 'Secret' : 'ConfigMap') : ''}
                    error={e(`${p}.ref`)}
                    className="flex-1"
                  >
                    <Pick
                      value={env.ref}
                      options={env.source === 'secret' ? lookups.secrets : lookups.configMaps}
                      placeholder="name"
                      error={e(`${p}.ref`)}
                      onChange={(v) => {
                        setEnv({ ref: v })
                      }}
                    />
                  </F>
                  <F label={i === 0 ? 'Key' : ''} className="w-36">
                    <Input
                      mono
                      value={env.key}
                      placeholder="key"
                      onChange={(ev) => {
                        setEnv({ key: ev.target.value })
                      }}
                    />
                  </F>
                </>
              )}
              <div className={i === 0 ? 'pt-5' : ''}>
                <RemoveButton
                  onClick={() => {
                    set({ env: value.env.filter((_, j) => j !== i) })
                  }}
                />
              </div>
            </div>
          )
        })}
        {value.envFrom.map((ef, i) => (
          <div key={`from-${String(i)}`} className="flex items-center gap-2">
            <span className="w-48 text-xs text-muted">All keys of</span>
            <Select
              className="w-36"
              value={ef.kind}
              onChange={(ev) => {
                set({
                  envFrom: value.envFrom.map((x, j) =>
                    j === i
                      ? { ...x, kind: ev.target.value as 'configmap' | 'secret', name: '' }
                      : x
                  )
                })
              }}
            >
              <option value="configmap">ConfigMap</option>
              <option value="secret">Secret</option>
            </Select>
            <div className="flex-1">
              <Pick
                value={ef.name}
                options={ef.kind === 'secret' ? lookups.secrets : lookups.configMaps}
                placeholder="name"
                onChange={(v) => {
                  set({ envFrom: value.envFrom.map((x, j) => (j === i ? { ...x, name: v } : x)) })
                }}
              />
            </div>
            <RemoveButton
              onClick={() => {
                set({ envFrom: value.envFrom.filter((_, j) => j !== i) })
              }}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <RowButton
            label="Add variable"
            testId="k8s-form-add-env"
            onClick={() => {
              set({
                env: [...value.env, { name: '', source: 'value', value: '', ref: '', key: '' }]
              })
            }}
          />
          <RowButton
            label="Load all keys from a ConfigMap / Secret"
            onClick={() => {
              set({ envFrom: [...value.envFrom, { kind: 'configmap', name: '' }] })
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-fg">Resources</span>
        <Grid cols={4}>
          <F label="CPU request" error={e('cpuRequest')} hint="250m = ¼ core">
            <Input
              mono
              value={value.cpuRequest}
              placeholder="100m"
              className={invalid(e('cpuRequest'))}
              onChange={(ev) => {
                set({ cpuRequest: ev.target.value })
              }}
            />
          </F>
          <F label="CPU limit" error={e('cpuLimit')}>
            <Input
              mono
              value={value.cpuLimit}
              placeholder="none"
              className={invalid(e('cpuLimit'))}
              onChange={(ev) => {
                set({ cpuLimit: ev.target.value })
              }}
            />
          </F>
          <F label="Memory request" error={e('memoryRequest')} hint="Mi / Gi">
            <Input
              mono
              value={value.memoryRequest}
              placeholder="128Mi"
              className={invalid(e('memoryRequest'))}
              onChange={(ev) => {
                set({ memoryRequest: ev.target.value })
              }}
            />
          </F>
          <F label="Memory limit" error={e('memoryLimit')}>
            <Input
              mono
              value={value.memoryLimit}
              placeholder="256Mi"
              className={invalid(e('memoryLimit'))}
              onChange={(ev) => {
                set({ memoryLimit: ev.target.value })
              }}
            />
          </F>
        </Grid>
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-xs font-semibold text-fg">Health checks</span>
        <ProbeEditor
          title="Readiness"
          value={value.readiness}
          errors={errors}
          path={`${path}.readiness`}
          onChange={(readiness) => {
            set({ readiness })
          }}
        />
        <ProbeEditor
          title="Liveness"
          value={value.liveness}
          errors={errors}
          path={`${path}.liveness`}
          onChange={(liveness) => {
            set({ liveness })
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-fg">Volume mounts</span>
        {volumes.length === 0 && (
          <span className="text-xs text-faint">Add a volume below to mount it here.</span>
        )}
        {value.mounts.map((m, i) => {
          const setM = (patch: Partial<typeof m>): void => {
            set({ mounts: value.mounts.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const p = `mounts.${String(i)}`
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? 'Volume' : ''} error={e(`${p}.volume`)} className="w-44">
                <Select
                  value={m.volume}
                  className={invalid(e(`${p}.volume`))}
                  onChange={(ev) => {
                    setM({ volume: ev.target.value })
                  }}
                >
                  <option value="">Choose…</option>
                  {volumes.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </F>
              <F label={i === 0 ? 'Mount path' : ''} error={e(`${p}.path`)} className="flex-1">
                <Input
                  mono
                  value={m.path}
                  placeholder="/data"
                  className={invalid(e(`${p}.path`))}
                  onChange={(ev) => {
                    setM({ path: ev.target.value })
                  }}
                />
              </F>
              <F label={i === 0 ? 'Sub path' : ''} className="w-36">
                <Input
                  mono
                  value={m.subPath}
                  placeholder="optional"
                  onChange={(ev) => {
                    setM({ subPath: ev.target.value })
                  }}
                />
              </F>
              <div className={cx('flex h-8 items-center', i === 0 && 'mt-5')}>
                <Checkbox
                  label="Read-only"
                  checked={m.readOnly}
                  onChange={(ev) => {
                    setM({ readOnly: ev.target.checked })
                  }}
                />
              </div>
              <div className={i === 0 ? 'pt-5' : ''}>
                <RemoveButton
                  onClick={() => {
                    set({ mounts: value.mounts.filter((_, j) => j !== i) })
                  }}
                />
              </div>
            </div>
          )
        })}
        {volumes.length > 0 && (
          <RowButton
            label="Add mount"
            onClick={() => {
              set({
                mounts: [
                  ...value.mounts,
                  { volume: volumes[0] ?? '', path: '', readOnly: false, subPath: '' }
                ]
              })
            }}
          />
        )}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer font-semibold text-fg">Command and arguments</summary>
        <div className="mt-2">
          <Grid>
            <F label="Command" hint="Overrides the image entrypoint">
              <Input
                mono
                value={value.command}
                placeholder={`sh -c "…"`}
                onChange={(ev) => {
                  set({ command: ev.target.value })
                }}
              />
            </F>
            <F label="Arguments">
              <Input
                mono
                value={value.args}
                placeholder="--port 8080"
                onChange={(ev) => {
                  set({ args: ev.target.value })
                }}
              />
            </F>
          </Grid>
        </div>
      </details>
    </div>
  )
}

function PortsEditor({
  value,
  onChange,
  errors,
  path,
  type
}: {
  value: ServicePortForm[]
  onChange: (v: ServicePortForm[]) => void
  errors: FieldErrors
  path: string
  type: string
}): React.JSX.Element {
  const set = (i: number, patch: Partial<ServicePortForm>): void => {
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  }
  const node = type === 'NodePort' || type === 'LoadBalancer'
  return (
    <div className="flex flex-col gap-2">
      {errors[path] && <span className="text-[11px] text-danger">{errors[path]}</span>}
      {value.map((p, i) => {
        const e = (k: string): string | undefined => errors[`${path}.${String(i)}.${k}`]
        return (
          <div key={i} className="flex items-start gap-2">
            <F label={i === 0 ? 'Name' : ''} error={e('name')} className="w-32">
              <Input
                mono
                value={p.name}
                placeholder="http"
                className={invalid(e('name'))}
                onChange={(ev) => {
                  set(i, { name: ev.target.value })
                }}
              />
            </F>
            <F label={i === 0 ? 'Port' : ''} error={e('port')} className="w-24">
              <Input
                mono
                value={p.port}
                placeholder="80"
                data-testid="k8s-form-service-port"
                className={invalid(e('port'))}
                onChange={(ev) => {
                  set(i, { port: ev.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
            <F label={i === 0 ? 'Target port' : ''} className="w-32">
              <Input
                mono
                value={p.targetPort}
                placeholder="8080 or name"
                onChange={(ev) => {
                  set(i, { targetPort: ev.target.value })
                }}
              />
            </F>
            {node && (
              <F label={i === 0 ? 'Node port' : ''} error={e('nodePort')} className="w-28">
                <Input
                  mono
                  value={p.nodePort}
                  placeholder="auto"
                  className={invalid(e('nodePort'))}
                  onChange={(ev) => {
                    set(i, { nodePort: ev.target.value.replace(/\D/g, '') })
                  }}
                />
              </F>
            )}
            <F label={i === 0 ? 'Protocol' : ''} className="w-24">
              <Select
                value={p.protocol}
                onChange={(ev) => {
                  set(i, { protocol: ev.target.value as 'TCP' | 'UDP' })
                }}
              >
                <option>TCP</option>
                <option>UDP</option>
              </Select>
            </F>
            <div className={i === 0 ? 'pt-5' : ''}>
              <RemoveButton
                onClick={() => {
                  onChange(value.filter((_, j) => j !== i))
                }}
              />
            </div>
          </div>
        )
      })}
      <RowButton
        label="Add port"
        onClick={() => {
          onChange([...value, emptyServicePort()])
        }}
      />
    </div>
  )
}

function WorkloadEditor({
  f,
  set,
  errors,
  namespaces,
  lookups
}: {
  f: WorkloadForm
  set: (patch: Partial<WorkloadForm>) => void
  errors: FieldErrors
  namespaces: readonly string[]
  lookups: Lookups
}): React.JSX.Element {
  const [active, setActive] = useState(0)
  const idx = Math.min(active, f.containers.length - 1)
  const c = f.containers[idx] ?? emptyContainer()
  const job = f.kind === 'Job' || f.kind === 'CronJob'
  const containerPorts = f.containers.flatMap((x) => x.ports.filter((p) => p.port))
  return (
    <>
      <Section title="General">
        <Grid>
          <NameInput
            value={f.name}
            error={errors['name']}
            onChange={(name) => {
              set({ name })
            }}
          />
          <NamespaceSelect
            value={f.namespace}
            namespaces={namespaces}
            error={errors['namespace']}
            onChange={(namespace) => {
              set({ namespace })
            }}
          />
        </Grid>
        {(f.kind === 'Deployment' || f.kind === 'StatefulSet') && (
          <Grid cols={4}>
            <F label="Replicas" required error={errors['replicas']}>
              <Input
                mono
                value={f.replicas}
                className={invalid(errors['replicas'])}
                data-testid="k8s-form-replicas"
                onChange={(e) => {
                  set({ replicas: e.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
          </Grid>
        )}
        <F
          label="Labels"
          hint={`Also used to select the pods — defaults to app=${f.name || '<name>'}`}
        >
          <KVEditor
            value={f.labels}
            errors={errors}
            path="labels"
            addLabel="Add label"
            onChange={(labels) => {
              set({ labels })
            }}
          />
        </F>
      </Section>

      {f.kind === 'CronJob' && (
        <Section title="Schedule" description="When the job runs (cluster time zone, usually UTC)">
          <Grid>
            <F
              label="Cron schedule"
              required
              error={errors['schedule']}
              hint="minute hour day month weekday"
            >
              <Input
                mono
                value={f.schedule}
                className={invalid(errors['schedule'])}
                onChange={(e) => {
                  set({ schedule: e.target.value })
                }}
              />
            </F>
            <F label="If the previous run is still going">
              <Select
                value={f.concurrencyPolicy}
                onChange={(e) => {
                  set({ concurrencyPolicy: e.target.value as WorkloadForm['concurrencyPolicy'] })
                }}
              >
                <option value="Forbid">Skip the new run</option>
                <option value="Replace">Replace it</option>
                <option value="Allow">Run both</option>
              </Select>
            </F>
          </Grid>
          <div className="flex flex-wrap gap-1">
            {[
              ['Every 5 min', '*/5 * * * *'],
              ['Hourly', '0 * * * *'],
              ['Daily 02:00', '0 2 * * *'],
              ['Weekly (Mon)', '0 3 * * 1'],
              ['Monthly', '0 4 1 * *']
            ].map(([label, cron]) => (
              <button
                key={cron}
                type="button"
                className={cx(
                  'rounded-full border px-2 py-0.5 text-[11px]',
                  f.schedule === cron
                    ? 'border-accent bg-accent-soft text-fg'
                    : 'border-line text-muted hover:text-fg'
                )}
                onClick={() => {
                  set({ schedule: cron ?? '' })
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Containers" description="The image to run and how">
        <div className="flex flex-wrap items-center gap-1">
          {f.containers.map((x, i) => (
            <span
              key={i}
              className={cx(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                i === idx ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted'
              )}
            >
              <button
                type="button"
                className="font-mono"
                onClick={() => {
                  setActive(i)
                }}
              >
                {x.name || `container-${String(i + 1)}`}
              </button>
              {f.containers.length > 1 && (
                <button
                  type="button"
                  aria-label="Remove container"
                  className="text-faint hover:text-danger"
                  onClick={() => {
                    set({ containers: f.containers.filter((_, j) => j !== i) })
                    setActive(0)
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          <RowButton
            label="Sidecar"
            onClick={() => {
              set({
                containers: [
                  ...f.containers,
                  emptyContainer(`sidecar-${String(f.containers.length)}`)
                ]
              })
              setActive(f.containers.length)
            }}
          />
        </div>
        <ContainerEditor
          value={c}
          errors={errors}
          path={`containers.${String(idx)}`}
          lookups={lookups}
          volumes={f.volumes.map((v) => v.name).filter(Boolean)}
          onChange={(next) => {
            set({ containers: f.containers.map((x, j) => (j === idx ? next : x)) })
          }}
        />
      </Section>

      <Section
        title="Volumes"
        description="Config, secrets and storage the containers can mount"
        collapsible
        defaultOpen={f.volumes.length > 0}
      >
        {f.volumes.map((v, i) => {
          const p = `volumes.${String(i)}`
          const setV = (patch: Partial<typeof v>): void => {
            set({ volumes: f.volumes.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const options =
            v.type === 'configmap'
              ? lookups.configMaps
              : v.type === 'secret'
                ? lookups.secrets
                : lookups.pvcs
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? 'Name' : ''} error={errors[`${p}.name`]} className="w-40">
                <Input
                  mono
                  value={v.name}
                  className={invalid(errors[`${p}.name`])}
                  onChange={(e) => {
                    setV({ name: e.target.value })
                  }}
                />
              </F>
              <F label={i === 0 ? 'Type' : ''} className="w-44">
                <Select
                  value={v.type}
                  onChange={(e) => {
                    setV({ type: e.target.value as typeof v.type, source: '' })
                  }}
                >
                  <option value="configmap">ConfigMap</option>
                  <option value="secret">Secret</option>
                  <option value="pvc">Persistent volume claim</option>
                  <option value="emptydir">Empty directory</option>
                </Select>
              </F>
              {v.type !== 'emptydir' && (
                <F label={i === 0 ? 'Source' : ''} error={errors[`${p}.source`]} className="flex-1">
                  <Pick
                    value={v.source}
                    options={options}
                    placeholder="name"
                    error={errors[`${p}.source`]}
                    onChange={(source) => {
                      setV({ source })
                    }}
                  />
                </F>
              )}
              <div className={i === 0 ? 'pt-5' : ''}>
                <RemoveButton
                  onClick={() => {
                    set({ volumes: f.volumes.filter((_, j) => j !== i) })
                  }}
                />
              </div>
            </div>
          )
        })}
        <RowButton
          label="Add volume"
          onClick={() => {
            set({
              volumes: [
                ...f.volumes,
                { name: `vol-${String(f.volumes.length + 1)}`, type: 'configmap', source: '' }
              ]
            })
          }}
        />
      </Section>

      {f.kind === 'Deployment' && (
        <Section title="Update strategy" collapsible defaultOpen={false}>
          <Grid cols={3}>
            <F label="Strategy">
              <Select
                value={f.strategy}
                onChange={(e) => {
                  set({ strategy: e.target.value as WorkloadForm['strategy'] })
                }}
              >
                <option value="RollingUpdate">Rolling update</option>
                <option value="Recreate">Recreate (downtime)</option>
              </Select>
            </F>
            {f.strategy === 'RollingUpdate' && (
              <>
                <F label="Max surge" hint="Extra pods during an update">
                  <Input
                    mono
                    value={f.maxSurge}
                    onChange={(e) => {
                      set({ maxSurge: e.target.value })
                    }}
                  />
                </F>
                <F label="Max unavailable">
                  <Input
                    mono
                    value={f.maxUnavailable}
                    onChange={(e) => {
                      set({ maxUnavailable: e.target.value })
                    }}
                  />
                </F>
              </>
            )}
          </Grid>
        </Section>
      )}

      {job && (
        <Section title="Job" collapsible defaultOpen={false}>
          <Grid cols={4}>
            <F label="On failure">
              <Select
                value={f.restartPolicy}
                onChange={(e) => {
                  set({ restartPolicy: e.target.value as WorkloadForm['restartPolicy'] })
                }}
              >
                <option value="OnFailure">Restart the container</option>
                <option value="Never">New pod</option>
              </Select>
            </F>
            <F label="Retries" error={errors['backoffLimit']}>
              <Input
                mono
                value={f.backoffLimit}
                onChange={(e) => {
                  set({ backoffLimit: e.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
            <F label="Completions">
              <Input
                mono
                value={f.completions}
                onChange={(e) => {
                  set({ completions: e.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
            <F label="Parallelism">
              <Input
                mono
                value={f.parallelism}
                onChange={(e) => {
                  set({ parallelism: e.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
          </Grid>
        </Section>
      )}

      {!job && (
        <Section
          title="Networking"
          description="Give the pods a stable address inside the cluster"
          testId="k8s-form-networking"
        >
          <Checkbox
            label={`Also create a Service${f.kind === 'StatefulSet' ? ' (headless service for the pods)' : ''}`}
            description="Other workloads reach it at <name>.<namespace>.svc"
            checked={f.expose}
            data-testid="k8s-form-expose"
            onChange={(e) => {
              const on = e.target.checked
              set({
                expose: on,
                service: {
                  type: f.kind === 'StatefulSet' ? 'Headless' : f.service.type,
                  ports: f.service.ports.length
                    ? f.service.ports
                    : containerPorts.map((p) => ({
                        name: p.name,
                        port: p.port,
                        targetPort: p.name || p.port,
                        nodePort: '',
                        protocol: p.protocol
                      }))
                }
              })
            }}
          />
          {f.expose && (
            <>
              <F label="Service type" className="w-60">
                <Select
                  value={f.service.type}
                  onChange={(e) => {
                    set({
                      service: {
                        ...f.service,
                        type: e.target.value as WorkloadForm['service']['type']
                      }
                    })
                  }}
                >
                  <option value="ClusterIP">ClusterIP — inside the cluster</option>
                  <option value="NodePort">NodePort — on every node</option>
                  <option value="LoadBalancer">LoadBalancer — external IP</option>
                  <option value="Headless">Headless — pod DNS names</option>
                </Select>
              </F>
              <PortsEditor
                value={f.service.ports}
                errors={errors}
                path="service.ports"
                type={f.service.type}
                onChange={(ports) => {
                  set({ service: { ...f.service, ports } })
                }}
              />
            </>
          )}
        </Section>
      )}

      <Section title="Advanced" collapsible defaultOpen={false}>
        <Grid>
          <F label="Service account" hint="Identity of the pods (RBAC)">
            <Input
              mono
              value={f.serviceAccount}
              placeholder="default"
              onChange={(e) => {
                set({ serviceAccount: e.target.value })
              }}
            />
          </F>
          {f.kind === 'StatefulSet' && (
            <F label="Governing service" hint="Headless service name (defaults to the name)">
              <Input
                mono
                value={f.serviceName}
                placeholder={f.name || 'my-app'}
                onChange={(e) => {
                  set({ serviceName: e.target.value })
                }}
              />
            </F>
          )}
        </Grid>
        <F label="Node selector" hint="Only schedule on nodes with these labels">
          <KVEditor
            value={f.nodeSelector}
            errors={errors}
            path="nodeSelector"
            addLabel="Add node label"
            onChange={(nodeSelector) => {
              set({ nodeSelector })
            }}
          />
        </F>
        <F label="Annotations">
          <KVEditor
            value={f.annotations}
            errors={errors}
            path="annotations"
            addLabel="Add annotation"
            onChange={(annotations) => {
              set({ annotations })
            }}
          />
        </F>
      </Section>
    </>
  )
}

// ——— Hộp thoại ———

type AnyForm =
  | { kind: WorkloadKind; f: WorkloadForm }
  | { kind: 'Service'; f: ServiceForm }
  | { kind: 'Ingress'; f: IngressForm }
  | { kind: 'ConfigMap'; f: ConfigMapForm }
  | { kind: 'Secret'; f: SecretForm }
  | { kind: 'PersistentVolumeClaim'; f: PvcForm }
  | { kind: 'HorizontalPodAutoscaler'; f: HpaForm }
  | { kind: 'Namespace'; f: NamespaceForm }

function initial(kind: FormKind, ns: string): AnyForm {
  switch (kind) {
    case 'Service':
      return {
        kind,
        f: {
          name: '',
          namespace: ns,
          labels: [],
          type: 'ClusterIP',
          selector: [{ key: 'app', value: '' }],
          ports: [{ ...emptyServicePort(), port: '80', targetPort: '8080' }]
        }
      }
    case 'Ingress':
      return {
        kind,
        f: {
          name: '',
          namespace: ns,
          labels: [],
          annotations: [],
          className: '',
          rules: [{ host: '', path: '/', pathType: 'Prefix', service: '', port: '' }],
          tls: []
        }
      }
    case 'ConfigMap':
      return { kind, f: { name: '', namespace: ns, labels: [], data: [{ key: '', value: '' }] } }
    case 'Secret':
      return {
        kind,
        f: {
          name: '',
          namespace: ns,
          labels: [],
          type: 'Opaque',
          data: [{ key: '', value: '' }],
          tlsCert: '',
          tlsKey: '',
          registry: { server: '', username: '', password: '', email: '' },
          basic: { username: '', password: '' }
        }
      }
    case 'PersistentVolumeClaim':
      return {
        kind,
        f: {
          name: '',
          namespace: ns,
          labels: [],
          storageClass: '',
          size: '10Gi',
          accessMode: 'ReadWriteOnce',
          volumeMode: 'Filesystem'
        }
      }
    case 'HorizontalPodAutoscaler':
      return {
        kind,
        f: {
          name: '',
          namespace: ns,
          targetKind: 'Deployment',
          target: '',
          min: '2',
          max: '5',
          cpu: '70',
          memory: ''
        }
      }
    case 'Namespace':
      return { kind, f: { name: '', labels: [] } }
    default:
      return { kind, f: emptyWorkload(kind, ns) }
  }
}

function build(form: AnyForm): {
  docs: Record<string, unknown>[]
  errors: FieldErrors
  namespace?: string
} {
  switch (form.kind) {
    case 'Service':
      return {
        docs: [serviceManifest(form.f)],
        errors: validateService(form.f),
        namespace: form.f.namespace
      }
    case 'Ingress':
      return {
        docs: [ingressManifest(form.f)],
        errors: validateIngress(form.f),
        namespace: form.f.namespace
      }
    case 'ConfigMap':
      return {
        docs: [configMapManifest(form.f)],
        errors: validateConfigMap(form.f),
        namespace: form.f.namespace
      }
    case 'Secret':
      return {
        docs: [secretManifest(form.f)],
        errors: validateSecret(form.f),
        namespace: form.f.namespace
      }
    case 'PersistentVolumeClaim':
      return {
        docs: [pvcManifest(form.f)],
        errors: validatePvc(form.f),
        namespace: form.f.namespace
      }
    case 'HorizontalPodAutoscaler':
      return {
        docs: [hpaManifest(form.f)],
        errors: validateHpa(form.f),
        namespace: form.f.namespace
      }
    case 'Namespace':
      return { docs: [namespaceManifest(form.f)], errors: validateNamespace(form.f) }
    default:
      return {
        docs: workloadManifests(form.f),
        errors: validateWorkload(form.f),
        namespace: form.f.namespace
      }
  }
}

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
  useEscapeToClose(onClose)
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
  const errorCount = Object.keys(errors).length

  const pick = (kind: FormKind): void => {
    // Giữ tên / namespace khi đổi loại.
    const next = initial(kind, ns || defaultNamespace)
    if ('name' in form.f && form.f.name) (next.f as { name: string }).name = form.f.name
    setForm(next)
    setShowErrors(false)
    setFailure(null)
  }

  const create = (): void => {
    if (errorCount) {
      setShowErrors(true)
      return
    }
    setBusy(true)
    setFailure(null)
    request<ApplyResult[]>({ op: 'serverApply', yaml, ...(ns ? { namespace: ns } : {}) }).then(
      (results) => {
        setBusy(false)
        const bad = results.filter((r) => r.action === 'error')
        if (bad.length) {
          setFailure(bad.map((r) => `${r.object}: ${r.error ?? 'failed'}`).join('\n'))
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
        role="dialog"
        aria-modal="true"
        aria-label="Create a resource"
        data-testid="k8s-create-dialog"
        className="shadow-elevated animate-dialog-in flex h-full max-h-[52rem] w-full max-w-[90rem] flex-col overflow-hidden rounded-xl border border-line bg-elevated"
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <KindIcon kind={KIND_ID[form.kind]} size={26} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">
              Create {GROUPS.flatMap((g) => g.kinds).find((k) => k.kind === form.kind)?.label}
            </h2>
            <p className="text-xs text-muted">
              Fill in the form — the YAML on the right updates as you type.
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
            {showYaml ? 'Hide YAML' : 'Show YAML'}
          </Button>
          <button
            type="button"
            aria-label="Close"
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav
            className="w-56 shrink-0 overflow-auto border-r border-line bg-subtle/50 p-2"
            aria-label="Resource type"
          >
            {GROUPS.map((g) => (
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
                <Section title="General">
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
                  title="Data"
                  description="Each key becomes an environment variable or a file when mounted"
                >
                  <KVEditor
                    value={form.f.data}
                    errors={shown}
                    path="data"
                    multiline
                    addLabel="Add key"
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
              <Section title="Volume claim" description="Storage that survives pod restarts">
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
                  <F label="Size" required error={shown['size']} hint="e.g. 10Gi">
                    <Input
                      mono
                      value={form.f.size}
                      className={invalid(shown['size'])}
                      onChange={(e) => {
                        setF<PvcForm>({ size: e.target.value })
                      }}
                    />
                  </F>
                  <F label="Storage class" hint="Empty = cluster default">
                    <Pick
                      value={form.f.storageClass}
                      options={lookups.storageClasses}
                      placeholder="default"
                      onChange={(storageClass) => {
                        setF<PvcForm>({ storageClass })
                      }}
                    />
                  </F>
                  <F label="Access mode">
                    <Select
                      value={form.f.accessMode}
                      onChange={(e) => {
                        setF<PvcForm>({ accessMode: e.target.value as PvcForm['accessMode'] })
                      }}
                    >
                      <option value="ReadWriteOnce">Read-write, one node</option>
                      <option value="ReadWriteOncePod">Read-write, one pod</option>
                      <option value="ReadOnlyMany">Read-only, many nodes</option>
                      <option value="ReadWriteMany">Read-write, many nodes</option>
                    </Select>
                  </F>
                </Grid>
              </Section>
            )}
            {form.kind === 'HorizontalPodAutoscaler' && (
              <Section
                title="Autoscaler"
                description="Add or remove pods to keep usage near the target"
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
                  <F label="Workload kind">
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
                  <F label="Workload" required error={shown['target']}>
                    <Pick
                      value={form.f.target}
                      options={
                        form.f.targetKind === 'Deployment'
                          ? lookups.deployments
                          : lookups.statefulSets
                      }
                      placeholder="name"
                      error={shown['target']}
                      onChange={(target) => {
                        setF<HpaForm>({ target, ...(form.f.name ? {} : { name: target }) })
                      }}
                    />
                  </F>
                </Grid>
                <Grid cols={4}>
                  <F label="Min pods" error={shown['min']}>
                    <Input
                      mono
                      value={form.f.min}
                      onChange={(e) => {
                        setF<HpaForm>({ min: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                  <F label="Max pods" error={shown['max']}>
                    <Input
                      mono
                      value={form.f.max}
                      onChange={(e) => {
                        setF<HpaForm>({ max: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                  <F label="CPU target %" error={shown['cpu']} hint="of requests">
                    <Input
                      mono
                      value={form.f.cpu}
                      onChange={(e) => {
                        setF<HpaForm>({ cpu: e.target.value.replace(/\D/g, '') })
                      }}
                    />
                  </F>
                  <F label="Memory target %" error={shown['memory']}>
                    <Input
                      mono
                      value={form.f.memory}
                      placeholder="off"
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
                <F label="Labels">
                  <KVEditor
                    value={form.f.labels}
                    errors={shown}
                    path="labels"
                    addLabel="Add label"
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
                <span className="font-semibold text-fg">YAML preview</span>
                <span className="text-faint">
                  {docs.length} object{docs.length === 1 ? '' : 's'}
                </span>
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
                  Edit as YAML
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
              Fix {errorCount} field{errorCount === 1 ? '' : 's'} highlighted in red.
            </span>
          ) : (
            <span className="text-xs text-faint">
              Created with server-side apply — running it again updates the same objects.
            </span>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            data-testid="k8s-create-submit"
            onClick={create}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function ServiceEditor({
  f,
  set,
  errors,
  namespaces
}: {
  f: ServiceForm
  set: (patch: Partial<ServiceForm>) => void
  errors: FieldErrors
  namespaces: readonly string[]
}): React.JSX.Element {
  return (
    <>
      <Section title="General">
        <Grid>
          <NameInput
            value={f.name}
            error={errors['name']}
            onChange={(name) => {
              // Selector mặc định app=<tên> theo tên service khi chưa ai sửa.
              const auto =
                f.selector.length === 1 &&
                f.selector[0]?.key === 'app' &&
                (f.selector[0].value === '' || f.selector[0].value === f.name)
              set({ name, ...(auto ? { selector: [{ key: 'app', value: name }] } : {}) })
            }}
          />
          <NamespaceSelect
            value={f.namespace}
            namespaces={namespaces}
            error={errors['namespace']}
            onChange={(namespace) => {
              set({ namespace })
            }}
          />
        </Grid>
        <F label="Type" className="w-72">
          <Select
            value={f.type}
            onChange={(e) => {
              set({ type: e.target.value as ServiceForm['type'] })
            }}
          >
            <option value="ClusterIP">ClusterIP — inside the cluster</option>
            <option value="NodePort">NodePort — on every node</option>
            <option value="LoadBalancer">LoadBalancer — external IP</option>
            <option value="Headless">Headless — pod DNS names</option>
          </Select>
        </F>
      </Section>
      <Section title="Selector" description="Traffic goes to pods that have all these labels">
        <KVEditor
          value={f.selector}
          errors={errors}
          path="selector"
          keyLabel="Label"
          addLabel="Add label"
          onChange={(selector) => {
            set({ selector })
          }}
        />
      </Section>
      <Section title="Ports">
        <PortsEditor
          value={f.ports}
          errors={errors}
          path="ports"
          type={f.type}
          onChange={(ports) => {
            set({ ports })
          }}
        />
      </Section>
    </>
  )
}

function IngressEditor({
  f,
  set,
  errors,
  namespaces,
  lookups
}: {
  f: IngressForm
  set: (patch: Partial<IngressForm>) => void
  errors: FieldErrors
  namespaces: readonly string[]
  lookups: Lookups
}): React.JSX.Element {
  return (
    <>
      <Section title="General">
        <Grid>
          <NameInput
            value={f.name}
            error={errors['name']}
            onChange={(name) => {
              set({ name })
            }}
          />
          <NamespaceSelect
            value={f.namespace}
            namespaces={namespaces}
            error={errors['namespace']}
            onChange={(namespace) => {
              set({ namespace })
            }}
          />
        </Grid>
        <F
          label="Ingress class"
          hint="Which controller handles it — empty = cluster default"
          className="w-72"
        >
          <Pick
            value={f.className}
            options={lookups.ingressClasses}
            placeholder="nginx"
            onChange={(className) => {
              set({ className })
            }}
          />
        </F>
      </Section>
      <Section title="Rules" description="Requests for a host and path go to a service">
        {errors['rules'] && <span className="text-[11px] text-danger">{errors['rules']}</span>}
        {f.rules.map((r, i) => {
          const e = (k: string): string | undefined => errors[`rules.${String(i)}.${k}`]
          const setR = (patch: Partial<typeof r>): void => {
            set({ rules: f.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const ports = lookups.services.find((s) => s.name === r.service)?.ports ?? []
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? 'Host' : ''} error={e('host')} className="flex-1">
                <Input
                  mono
                  value={r.host}
                  placeholder="shop.example.com (any)"
                  className={invalid(e('host'))}
                  onChange={(ev) => {
                    setR({ host: ev.target.value.toLowerCase() })
                  }}
                />
              </F>
              <F label={i === 0 ? 'Path' : ''} error={e('path')} className="w-28">
                <Input
                  mono
                  value={r.path}
                  className={invalid(e('path'))}
                  onChange={(ev) => {
                    setR({ path: ev.target.value })
                  }}
                />
              </F>
              <F label={i === 0 ? 'Match' : ''} className="w-28">
                <Select
                  value={r.pathType}
                  onChange={(ev) => {
                    setR({ pathType: ev.target.value as typeof r.pathType })
                  }}
                >
                  <option>Prefix</option>
                  <option>Exact</option>
                  <option value="ImplementationSpecific">Controller</option>
                </Select>
              </F>
              <F label={i === 0 ? 'Service' : ''} error={e('service')} className="w-44">
                <Pick
                  value={r.service}
                  options={lookups.services.map((s) => s.name)}
                  placeholder="service"
                  error={e('service')}
                  onChange={(service) => {
                    setR({
                      service,
                      port: lookups.services.find((s) => s.name === service)?.ports[0] ?? r.port
                    })
                  }}
                />
              </F>
              <F label={i === 0 ? 'Port' : ''} error={e('port')} className="w-24">
                <Pick
                  value={r.port}
                  options={ports}
                  placeholder="80"
                  error={e('port')}
                  onChange={(port) => {
                    setR({ port })
                  }}
                />
              </F>
              <div className={i === 0 ? 'pt-5' : ''}>
                <RemoveButton
                  onClick={() => {
                    set({ rules: f.rules.filter((_, j) => j !== i) })
                  }}
                />
              </div>
            </div>
          )
        })}
        <RowButton
          label="Add rule"
          onClick={() => {
            set({
              rules: [
                ...f.rules,
                {
                  host: f.rules.at(-1)?.host ?? '',
                  path: '/',
                  pathType: 'Prefix',
                  service: '',
                  port: ''
                }
              ]
            })
          }}
        />
      </Section>
      <Section
        title="TLS"
        description="Serve HTTPS with a certificate stored in a Secret"
        collapsible
        defaultOpen={f.tls.length > 0}
      >
        {f.tls.map((t, i) => (
          <div key={i} className="flex items-start gap-2">
            <F label={i === 0 ? 'Certificate secret' : ''} className="w-56">
              <Pick
                value={t.secret}
                options={lookups.secrets}
                placeholder="shop-tls"
                onChange={(secret) => {
                  set({ tls: f.tls.map((x, j) => (j === i ? { ...x, secret } : x)) })
                }}
              />
            </F>
            <F label={i === 0 ? 'Hosts' : ''} className="flex-1" hint="Comma separated">
              <Input
                mono
                value={t.hosts}
                placeholder={f.rules
                  .map((r) => r.host)
                  .filter(Boolean)
                  .join(', ')}
                onChange={(ev) => {
                  set({
                    tls: f.tls.map((x, j) => (j === i ? { ...x, hosts: ev.target.value } : x))
                  })
                }}
              />
            </F>
            <div className={i === 0 ? 'pt-5' : ''}>
              <RemoveButton
                onClick={() => {
                  set({ tls: f.tls.filter((_, j) => j !== i) })
                }}
              />
            </div>
          </div>
        ))}
        <RowButton
          label="Add certificate"
          onClick={() => {
            set({
              tls: [
                ...f.tls,
                {
                  secret: '',
                  hosts: [...new Set(f.rules.map((r) => r.host).filter(Boolean))].join(', ')
                }
              ]
            })
          }}
        />
      </Section>
      <Section
        title="Annotations"
        description="Controller options, e.g. nginx.ingress.kubernetes.io/rewrite-target"
        collapsible
        defaultOpen={false}
      >
        <KVEditor
          value={f.annotations}
          errors={errors}
          path="annotations"
          addLabel="Add annotation"
          onChange={(annotations) => {
            set({ annotations })
          }}
        />
      </Section>
    </>
  )
}

function SecretEditor({
  f,
  set,
  errors,
  namespaces
}: {
  f: SecretForm
  set: (patch: Partial<SecretForm>) => void
  errors: FieldErrors
  namespaces: readonly string[]
}): React.JSX.Element {
  return (
    <>
      <Section title="General">
        <Grid>
          <NameInput
            value={f.name}
            error={errors['name']}
            placeholder="db-credentials"
            onChange={(name) => {
              set({ name })
            }}
          />
          <NamespaceSelect
            value={f.namespace}
            namespaces={namespaces}
            error={errors['namespace']}
            onChange={(namespace) => {
              set({ namespace })
            }}
          />
        </Grid>
        <F label="Type">
          <Segmented
            value={f.type}
            options={[
              { value: 'Opaque', label: 'Key / value' },
              { value: 'kubernetes.io/dockerconfigjson', label: 'Registry login' },
              { value: 'kubernetes.io/tls', label: 'TLS certificate' },
              { value: 'kubernetes.io/basic-auth', label: 'Username / password' }
            ]}
            onChange={(type) => {
              set({ type })
            }}
          />
        </F>
      </Section>
      <Section
        title="Data"
        description="Values are sent to the cluster over TLS and stored by Kubernetes; Shellhouse does not keep them"
      >
        {f.type === 'Opaque' && (
          <KVEditor
            value={f.data}
            errors={errors}
            path="data"
            secret
            addLabel="Add key"
            onChange={(data) => {
              set({ data })
            }}
          />
        )}
        {f.type === 'kubernetes.io/dockerconfigjson' && (
          <Grid>
            <F
              label="Registry"
              required
              error={errors['registry.server']}
              hint="e.g. ghcr.io, registry.gitlab.com"
            >
              <Input
                mono
                value={f.registry.server}
                onChange={(e) => {
                  set({ registry: { ...f.registry, server: e.target.value } })
                }}
              />
            </F>
            <F label="Email">
              <Input
                mono
                value={f.registry.email}
                onChange={(e) => {
                  set({ registry: { ...f.registry, email: e.target.value } })
                }}
              />
            </F>
            <F label="Username" required error={errors['registry.username']}>
              <Input
                mono
                value={f.registry.username}
                onChange={(e) => {
                  set({ registry: { ...f.registry, username: e.target.value } })
                }}
              />
            </F>
            <F label="Password or token" required error={errors['registry.password']}>
              <Input
                mono
                type="password"
                value={f.registry.password}
                onChange={(e) => {
                  set({ registry: { ...f.registry, password: e.target.value } })
                }}
              />
            </F>
          </Grid>
        )}
        {f.type === 'kubernetes.io/tls' && (
          <Grid>
            <F label="Certificate (PEM)" required error={errors['tlsCert']}>
              <TextArea
                rows={8}
                value={f.tlsCert}
                placeholder="-----BEGIN CERTIFICATE-----"
                onChange={(e) => {
                  set({ tlsCert: e.target.value })
                }}
              />
            </F>
            <F label="Private key (PEM)" required error={errors['tlsKey']}>
              <TextArea
                rows={8}
                value={f.tlsKey}
                placeholder="-----BEGIN PRIVATE KEY-----"
                onChange={(e) => {
                  set({ tlsKey: e.target.value })
                }}
              />
            </F>
          </Grid>
        )}
        {f.type === 'kubernetes.io/basic-auth' && (
          <Grid>
            <F label="Username" required error={errors['basic.username']}>
              <Input
                mono
                value={f.basic.username}
                onChange={(e) => {
                  set({ basic: { ...f.basic, username: e.target.value } })
                }}
              />
            </F>
            <F label="Password">
              <Input
                mono
                type="password"
                value={f.basic.password}
                onChange={(e) => {
                  set({ basic: { ...f.basic, password: e.target.value } })
                }}
              />
            </F>
          </Grid>
        )}
      </Section>
    </>
  )
}
