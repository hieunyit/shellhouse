import { Select } from '../../../../renderer/src/components/ui'
import type { FieldErrors, ServiceForm } from '../../shared/forms'
import { Section, F, Grid, KVEditor, NamespaceSelect, NameInput } from './kit'
import { PortsEditor } from './ContainerEditor'
import { t } from '../../../registry/renderer-kit'
import { tk } from '../i18n'

export function ServiceEditor({
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
      <Section title={t('General')}>
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
        <F label={t('Type')} className="w-72">
          <Select
            value={f.type}
            onChange={(e) => {
              set({ type: e.target.value as ServiceForm['type'] })
            }}
          >
            <option value="ClusterIP">{t('ClusterIP — inside the cluster')}</option>
            <option value="NodePort">{t('NodePort — on every node')}</option>
            <option value="LoadBalancer">{t('LoadBalancer — external IP')}</option>
            <option value="Headless">{t('Headless — pod DNS names')}</option>
          </Select>
        </F>
      </Section>
      <Section
        title={t('Selector')}
        description={t('Traffic goes to pods that have all these labels')}
      >
        <KVEditor
          value={f.selector}
          errors={errors}
          path="selector"
          keyLabel={tk('Label')}
          addLabel={t('Add label')}
          onChange={(selector) => {
            set({ selector })
          }}
        />
      </Section>
      <Section title={t('Ports')}>
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
