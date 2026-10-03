import { Input, Segmented, TextArea } from '../../../../renderer/src/components/ui'
import type { FieldErrors, SecretForm } from '../../shared/forms'
import { Section, F, Grid, KVEditor, NamespaceSelect, NameInput } from './kit'
import { t } from '../../../registry/renderer-kit'

export function SecretEditor({
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
      <Section title={t('General')}>
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
        <F label={t('Type')}>
          <Segmented
            value={f.type}
            options={[
              { value: 'Opaque', label: t('Key / value') },
              { value: 'kubernetes.io/dockerconfigjson', label: t('Registry login') },
              { value: 'kubernetes.io/tls', label: t('TLS certificate') },
              { value: 'kubernetes.io/basic-auth', label: t('Username / password') }
            ]}
            onChange={(type) => {
              set({ type })
            }}
          />
        </F>
      </Section>
      <Section
        title={t('Data')}
        description={t(
          'Values are sent to the cluster over TLS and stored by Kubernetes; Shellhouse does not keep them'
        )}
      >
        {f.type === 'Opaque' && (
          <KVEditor
            value={f.data}
            errors={errors}
            path="data"
            secret
            addLabel={t('Add key')}
            onChange={(data) => {
              set({ data })
            }}
          />
        )}
        {f.type === 'kubernetes.io/dockerconfigjson' && (
          <Grid>
            <F
              label={t('Registry')}
              required
              error={errors['registry.server']}
              hint={t('e.g. {examples}', { examples: 'ghcr.io, registry.gitlab.com' })}
            >
              <Input
                mono
                value={f.registry.server}
                onChange={(e) => {
                  set({ registry: { ...f.registry, server: e.target.value } })
                }}
              />
            </F>
            <F label={t('Email')}>
              <Input
                mono
                value={f.registry.email}
                onChange={(e) => {
                  set({ registry: { ...f.registry, email: e.target.value } })
                }}
              />
            </F>
            <F label={t('Username')} required error={errors['registry.username']}>
              <Input
                mono
                value={f.registry.username}
                onChange={(e) => {
                  set({ registry: { ...f.registry, username: e.target.value } })
                }}
              />
            </F>
            <F label={t('Password or token')} required error={errors['registry.password']}>
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
            <F label={t('Certificate (PEM)')} required error={errors['tlsCert']}>
              <TextArea
                rows={8}
                value={f.tlsCert}
                placeholder="-----BEGIN CERTIFICATE-----"
                onChange={(e) => {
                  set({ tlsCert: e.target.value })
                }}
              />
            </F>
            <F label={t('Private key (PEM)')} required error={errors['tlsKey']}>
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
            <F label={t('Username')} required error={errors['basic.username']}>
              <Input
                mono
                value={f.basic.username}
                onChange={(e) => {
                  set({ basic: { ...f.basic, username: e.target.value } })
                }}
              />
            </F>
            <F label={t('Password')}>
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
