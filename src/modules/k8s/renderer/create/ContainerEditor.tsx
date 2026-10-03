import { Checkbox, Input, Segmented, Select, cx } from '../../../../renderer/src/components/ui'
import {
  emptyServicePort,
  type ContainerForm,
  type FieldErrors,
  type ProbeForm,
  type ServicePortForm
} from '../../shared/forms'
import type { Lookups } from './useLookups'
import { F, invalid, Grid, RowButton, RemoveButton, Pick } from './kit'
import { t } from '../../../registry/renderer-kit'

export function ProbeEditor({
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
            { value: 'none', label: t('None') },
            { value: 'http', label: 'HTTP' },
            { value: 'tcp', label: 'TCP' },
            { value: 'exec', label: t('Command') }
          ]}
          onChange={(type) => {
            set({ type })
          }}
        />
      </div>
      {value.type !== 'none' && (
        <Grid cols={4}>
          {value.type === 'http' && (
            <F label={t('Path')} error={errors[`${path}.path`]}>
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
            <F label={t('Port')} error={errors[`${path}.port`]} hint={t('Number or port name')}>
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
            <F label={t('Command')} error={errors[`${path}.command`]} className="col-span-2">
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
          <F label={t('Initial delay (s)')}>
            <Input
              mono
              value={value.initialDelay}
              placeholder="0"
              onChange={(e) => {
                set({ initialDelay: e.target.value.replace(/\D/g, '') })
              }}
            />
          </F>
          <F label={t('Every (s)')}>
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

export function ContainerEditor({
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
        <F
          label={t('Image')}
          required
          error={e('image')}
          hint={t('e.g. {examples}', { examples: 'nginx:1.27, ghcr.io/acme/api:1.2' })}
        >
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
          <F label={t('Name')} required error={e('name')}>
            <Input
              mono
              value={value.name}
              className={invalid(e('name'))}
              onChange={(ev) => {
                set({ name: ev.target.value })
              }}
            />
          </F>
          <F label={t('Pull policy')}>
            <Select
              value={value.pullPolicy}
              onChange={(ev) => {
                set({ pullPolicy: ev.target.value as ContainerForm['pullPolicy'] })
              }}
            >
              <option value="">{t('Default')}</option>
              <option value="IfNotPresent">{t('If not present')}</option>
              <option value="Always">{t('Always')}</option>
              <option value="Never">{t('Never')}</option>
            </Select>
          </F>
        </Grid>
      </Grid>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-fg">{t('Ports')}</span>
        {value.ports.map((p, i) => (
          <div key={i} className="flex items-start gap-2">
            <F label={i === 0 ? t('Name') : ''} className="w-40">
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
              label={i === 0 ? t('Container port') : ''}
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
            <F label={i === 0 ? t('Protocol') : ''} className="w-28">
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
          label={t('Add port')}
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
        <span className="text-xs font-semibold text-fg">{t('Environment variables')}</span>
        {value.env.map((env, i) => {
          const setEnv = (patch: Partial<typeof env>): void => {
            set({ env: value.env.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const p = `env.${String(i)}`
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? t('Name') : ''} error={e(`${p}.name`)} className="w-48">
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
              <F label={i === 0 ? t('Source') : ''} className="w-36">
                <Select
                  value={env.source}
                  onChange={(ev) => {
                    setEnv({ source: ev.target.value as typeof env.source, ref: '', key: '' })
                  }}
                >
                  <option value="value">{t('Value')}</option>
                  <option value="configmap">{t('ConfigMap key')}</option>
                  <option value="secret">{t('Secret key')}</option>
                </Select>
              </F>
              {env.source === 'value' ? (
                <F label={i === 0 ? t('Value') : ''} className="flex-1">
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
                      placeholder={t('name')}
                      error={e(`${p}.ref`)}
                      onChange={(v) => {
                        setEnv({ ref: v })
                      }}
                    />
                  </F>
                  <F label={i === 0 ? t('Key') : ''} className="w-36">
                    <Input
                      mono
                      value={env.key}
                      placeholder={t('key')}
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
            <span className="w-48 text-xs text-muted">{t('All keys of')}</span>
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
                placeholder={t('name')}
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
            label={t('Add variable')}
            testId="k8s-form-add-env"
            onClick={() => {
              set({
                env: [...value.env, { name: '', source: 'value', value: '', ref: '', key: '' }]
              })
            }}
          />
          <RowButton
            label={t('Load all keys from a ConfigMap / Secret')}
            onClick={() => {
              set({ envFrom: [...value.envFrom, { kind: 'configmap', name: '' }] })
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-fg">{t('Resources')}</span>
        <Grid cols={4}>
          <F label={t('CPU request')} error={e('cpuRequest')} hint={t('250m = ¼ core')}>
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
          <F label={t('CPU limit')} error={e('cpuLimit')}>
            <Input
              mono
              value={value.cpuLimit}
              placeholder={t('none')}
              className={invalid(e('cpuLimit'))}
              onChange={(ev) => {
                set({ cpuLimit: ev.target.value })
              }}
            />
          </F>
          <F label={t('Memory request')} error={e('memoryRequest')} hint="Mi / Gi">
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
          <F label={t('Memory limit')} error={e('memoryLimit')}>
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
        <span className="text-xs font-semibold text-fg">{t('Health checks')}</span>
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
        <span className="text-xs font-semibold text-fg">{t('Volume mounts')}</span>
        {volumes.length === 0 && (
          <span className="text-xs text-faint">{t('Add a volume below to mount it here.')}</span>
        )}
        {value.mounts.map((m, i) => {
          const setM = (patch: Partial<typeof m>): void => {
            set({ mounts: value.mounts.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const p = `mounts.${String(i)}`
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? t('Volume') : ''} error={e(`${p}.volume`)} className="w-44">
                <Select
                  value={m.volume}
                  className={invalid(e(`${p}.volume`))}
                  onChange={(ev) => {
                    setM({ volume: ev.target.value })
                  }}
                >
                  <option value="">{t('Choose…')}</option>
                  {volumes.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </F>
              <F label={i === 0 ? t('Mount path') : ''} error={e(`${p}.path`)} className="flex-1">
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
              <F label={i === 0 ? t('Sub path') : ''} className="w-36">
                <Input
                  mono
                  value={m.subPath}
                  placeholder={t('optional')}
                  onChange={(ev) => {
                    setM({ subPath: ev.target.value })
                  }}
                />
              </F>
              <div className={cx('flex h-8 items-center', i === 0 && 'mt-5')}>
                <Checkbox
                  label={t('Read-only')}
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
            label={t('Add mount')}
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
        <summary className="cursor-pointer font-semibold text-fg">
          {t('Command and arguments')}
        </summary>
        <div className="mt-2">
          <Grid>
            <F label={t('Command')} hint={t('Overrides the image entrypoint')}>
              <Input
                mono
                value={value.command}
                placeholder={`sh -c "…"`}
                onChange={(ev) => {
                  set({ command: ev.target.value })
                }}
              />
            </F>
            <F label={t('Arguments')}>
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

export function PortsEditor({
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
            <F label={i === 0 ? t('Name') : ''} error={e('name')} className="w-32">
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
            <F label={i === 0 ? t('Port') : ''} error={e('port')} className="w-24">
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
            <F label={i === 0 ? t('Target port') : ''} className="w-32">
              <Input
                mono
                value={p.targetPort}
                placeholder={t('8080 or name')}
                onChange={(ev) => {
                  set(i, { targetPort: ev.target.value })
                }}
              />
            </F>
            {node && (
              <F label={i === 0 ? t('Node port') : ''} error={e('nodePort')} className="w-28">
                <Input
                  mono
                  value={p.nodePort}
                  placeholder={t('auto')}
                  className={invalid(e('nodePort'))}
                  onChange={(ev) => {
                    set(i, { nodePort: ev.target.value.replace(/\D/g, '') })
                  }}
                />
              </F>
            )}
            <F label={i === 0 ? t('Protocol') : ''} className="w-24">
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
        label={t('Add port')}
        onClick={() => {
          onChange([...value, emptyServicePort()])
        }}
      />
    </div>
  )
}
