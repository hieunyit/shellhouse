import { useState } from 'react'
import { X } from 'lucide-react'
import { Checkbox, Input, Select, cx } from '../../../../renderer/src/components/ui'
import { emptyContainer, type FieldErrors, type WorkloadForm } from '../../shared/forms'
import type { Lookups } from './useLookups'
import {
  Section,
  F,
  invalid,
  Grid,
  RowButton,
  RemoveButton,
  KVEditor,
  NamespaceSelect,
  NameInput,
  Pick
} from './kit'
import { ContainerEditor, PortsEditor } from './ContainerEditor'
import { t } from '../../../registry/renderer-kit'
import { tk } from '../i18n'

export function WorkloadEditor({
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
      <Section title={t('General')}>
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
            <F label={t('Replicas')} required error={errors['replicas']}>
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
          label={t('Labels')}
          hint={t('Also used to select the pods — defaults to app={name}', {
            name: f.name || '<name>'
          })}
        >
          <KVEditor
            value={f.labels}
            errors={errors}
            path="labels"
            addLabel={t('Add label')}
            onChange={(labels) => {
              set({ labels })
            }}
          />
        </F>
      </Section>

      {f.kind === 'CronJob' && (
        <Section
          title={t('Schedule')}
          description={t('When the job runs (cluster time zone, usually UTC)')}
        >
          <Grid>
            <F
              label={t('Cron schedule')}
              required
              error={errors['schedule']}
              hint={t('minute hour day month weekday')}
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
            <F label={t('If the previous run is still going')}>
              <Select
                value={f.concurrencyPolicy}
                onChange={(e) => {
                  set({ concurrencyPolicy: e.target.value as WorkloadForm['concurrencyPolicy'] })
                }}
              >
                <option value="Forbid">{t('Skip the new run')}</option>
                <option value="Replace">{t('Replace it')}</option>
                <option value="Allow">{t('Run both')}</option>
              </Select>
            </F>
          </Grid>
          <div className="flex flex-wrap gap-1">
            {[
              [t('Every 5 min'), '*/5 * * * *'],
              [t('Hourly'), '0 * * * *'],
              [t('Daily 02:00'), '0 2 * * *'],
              [t('Weekly (Mon)'), '0 3 * * 1'],
              [t('Monthly'), '0 4 1 * *']
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

      <Section title={t('Containers')} description={t('The image to run and how')}>
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
                  aria-label={t('Remove container')}
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
            label={t('Sidecar')}
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
        title={t('Volumes')}
        description={t('Config, secrets and storage the containers can mount')}
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
              <F label={i === 0 ? t('Name') : ''} error={errors[`${p}.name`]} className="w-40">
                <Input
                  mono
                  value={v.name}
                  className={invalid(errors[`${p}.name`])}
                  onChange={(e) => {
                    setV({ name: e.target.value })
                  }}
                />
              </F>
              <F label={i === 0 ? t('Type') : ''} className="w-44">
                <Select
                  value={v.type}
                  onChange={(e) => {
                    setV({ type: e.target.value as typeof v.type, source: '' })
                  }}
                >
                  <option value="configmap">ConfigMap</option>
                  <option value="secret">Secret</option>
                  <option value="pvc">{t('Persistent volume claim')}</option>
                  <option value="emptydir">{t('Empty directory')}</option>
                </Select>
              </F>
              {v.type !== 'emptydir' && (
                <F
                  label={i === 0 ? t('Source') : ''}
                  error={errors[`${p}.source`]}
                  className="flex-1"
                >
                  <Pick
                    value={v.source}
                    options={options}
                    placeholder={t('name')}
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
          label={t('Add volume')}
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
        <Section title={t('Update strategy')} collapsible defaultOpen={false}>
          <Grid cols={3}>
            <F label={t('Strategy')}>
              <Select
                value={f.strategy}
                onChange={(e) => {
                  set({ strategy: e.target.value as WorkloadForm['strategy'] })
                }}
              >
                <option value="RollingUpdate">{t('Rolling update')}</option>
                <option value="Recreate">{t('Recreate (downtime)')}</option>
              </Select>
            </F>
            {f.strategy === 'RollingUpdate' && (
              <>
                <F label={t('Max surge')} hint={t('Extra pods during an update')}>
                  <Input
                    mono
                    value={f.maxSurge}
                    onChange={(e) => {
                      set({ maxSurge: e.target.value })
                    }}
                  />
                </F>
                <F label={t('Max unavailable')}>
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
            <F label={t('On failure')}>
              <Select
                value={f.restartPolicy}
                onChange={(e) => {
                  set({ restartPolicy: e.target.value as WorkloadForm['restartPolicy'] })
                }}
              >
                <option value="OnFailure">{t('Restart the container')}</option>
                <option value="Never">{t('New pod')}</option>
              </Select>
            </F>
            <F label={t('Retries')} error={errors['backoffLimit']}>
              <Input
                mono
                value={f.backoffLimit}
                onChange={(e) => {
                  set({ backoffLimit: e.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
            <F label={tk('Completions')}>
              <Input
                mono
                value={f.completions}
                onChange={(e) => {
                  set({ completions: e.target.value.replace(/\D/g, '') })
                }}
              />
            </F>
            <F label={t('Parallelism')}>
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
          title={t('Networking')}
          description={t('Give the pods a stable address inside the cluster')}
          testId="k8s-form-networking"
        >
          <Checkbox
            label={
              f.kind === 'StatefulSet'
                ? t('Also create a Service (headless service for the pods)')
                : t('Also create a Service')
            }
            description={t('Other workloads reach it at <name>.<namespace>.svc')}
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
              <F label={t('Service type')} className="w-60">
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
                  <option value="ClusterIP">{t('ClusterIP — inside the cluster')}</option>
                  <option value="NodePort">{t('NodePort — on every node')}</option>
                  <option value="LoadBalancer">{t('LoadBalancer — external IP')}</option>
                  <option value="Headless">{t('Headless — pod DNS names')}</option>
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

      <Section title={t('Advanced')} collapsible defaultOpen={false}>
        <Grid>
          <F label={t('Service account')} hint={t('Identity of the pods (RBAC)')}>
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
            <F
              label={t('Governing service')}
              hint={t('Headless service name (defaults to the name)')}
            >
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
        <F label={t('Node selector')} hint={t('Only schedule on nodes with these labels')}>
          <KVEditor
            value={f.nodeSelector}
            errors={errors}
            path="nodeSelector"
            addLabel={t('Add node label')}
            onChange={(nodeSelector) => {
              set({ nodeSelector })
            }}
          />
        </F>
        <F label={t('Annotations')}>
          <KVEditor
            value={f.annotations}
            errors={errors}
            path="annotations"
            addLabel={t('Add annotation')}
            onChange={(annotations) => {
              set({ annotations })
            }}
          />
        </F>
      </Section>
    </>
  )
}
