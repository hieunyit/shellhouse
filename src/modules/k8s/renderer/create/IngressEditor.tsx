import { Input, Select } from '../../../../renderer/src/components/ui'
import type { FieldErrors, IngressForm } from '../../shared/forms'
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
import { t } from '../../../registry/renderer-kit'

export function IngressEditor({
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
        <F
          label={t('Ingress class')}
          hint={t('Which controller handles it — empty = cluster default')}
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
      <Section title={t('Rules')} description={t('Requests for a host and path go to a service')}>
        {errors['rules'] && <span className="text-[11px] text-danger">{errors['rules']}</span>}
        {f.rules.map((r, i) => {
          const e = (k: string): string | undefined => errors[`rules.${String(i)}.${k}`]
          const setR = (patch: Partial<typeof r>): void => {
            set({ rules: f.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
          }
          const ports = lookups.services.find((s) => s.name === r.service)?.ports ?? []
          return (
            <div key={i} className="flex items-start gap-2">
              <F label={i === 0 ? t('Host') : ''} error={e('host')} className="flex-1">
                <Input
                  mono
                  value={r.host}
                  placeholder={t('shop.example.com (any)')}
                  className={invalid(e('host'))}
                  onChange={(ev) => {
                    setR({ host: ev.target.value.toLowerCase() })
                  }}
                />
              </F>
              <F label={i === 0 ? t('Path') : ''} error={e('path')} className="w-28">
                <Input
                  mono
                  value={r.path}
                  className={invalid(e('path'))}
                  onChange={(ev) => {
                    setR({ path: ev.target.value })
                  }}
                />
              </F>
              <F label={i === 0 ? t('Match') : ''} className="w-28">
                <Select
                  value={r.pathType}
                  onChange={(ev) => {
                    setR({ pathType: ev.target.value as typeof r.pathType })
                  }}
                >
                  <option>Prefix</option>
                  <option>Exact</option>
                  <option value="ImplementationSpecific">{t('Controller')}</option>
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
              <F label={i === 0 ? t('Port') : ''} error={e('port')} className="w-24">
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
          label={t('Add rule')}
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
        description={t('Serve HTTPS with a certificate stored in a Secret')}
        collapsible
        defaultOpen={f.tls.length > 0}
      >
        {f.tls.map((tls, i) => (
          <div key={i} className="flex items-start gap-2">
            <F label={i === 0 ? t('Certificate secret') : ''} className="w-56">
              <Pick
                value={tls.secret}
                options={lookups.secrets}
                placeholder="shop-tls"
                onChange={(secret) => {
                  set({ tls: f.tls.map((x, j) => (j === i ? { ...x, secret } : x)) })
                }}
              />
            </F>
            <F label={i === 0 ? t('Hosts') : ''} className="flex-1" hint={t('Comma separated')}>
              <Input
                mono
                value={tls.hosts}
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
          label={t('Add certificate')}
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
        title={t('Annotations')}
        description={t('Controller options, e.g. {example}', {
          example: 'nginx.ingress.kubernetes.io/rewrite-target'
        })}
        collapsible
        defaultOpen={false}
      >
        <KVEditor
          value={f.annotations}
          errors={errors}
          path="annotations"
          addLabel={t('Add annotation')}
          onChange={(annotations) => {
            set({ annotations })
          }}
        />
      </Section>
    </>
  )
}
