import type { K8sOp } from '../../shared/ops'
import {
  configMapManifest,
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
  type FieldErrors,
  type FormKind,
  type HpaForm,
  type IngressForm,
  type NamespaceForm,
  type PvcForm,
  type SecretForm,
  type ServiceForm,
  type WorkloadForm,
  type WorkloadKind
} from '../../shared/forms'
import { t } from '../../../registry/renderer-kit'

export type Request = <T>(op: K8sOp) => Promise<T>

export const groups = (): {
  title: string
  kinds: { kind: FormKind; label: string; hint: string }[]
}[] => [
  {
    title: t('Workloads'),
    kinds: [
      { kind: 'Deployment', label: 'Deployment', hint: t('Stateless app with rolling updates') },
      { kind: 'StatefulSet', label: 'StatefulSet', hint: t('Stable names and storage per pod') },
      { kind: 'DaemonSet', label: 'DaemonSet', hint: t('One pod on every node') },
      { kind: 'Job', label: 'Job', hint: t('Run to completion once') },
      { kind: 'CronJob', label: 'CronJob', hint: t('Run on a schedule') }
    ]
  },
  {
    title: t('Networking'),
    kinds: [
      { kind: 'Service', label: 'Service', hint: t('Stable address for pods') },
      { kind: 'Ingress', label: 'Ingress', hint: t('HTTP(S) routes from outside') }
    ]
  },
  {
    title: t('Config & storage'),
    kinds: [
      { kind: 'ConfigMap', label: 'ConfigMap', hint: t('Settings and config files') },
      { kind: 'Secret', label: 'Secret', hint: t('Passwords, keys, registry login') },
      { kind: 'PersistentVolumeClaim', label: t('Volume claim'), hint: t('Persistent storage') }
    ]
  },
  {
    title: t('Cluster'),
    kinds: [
      { kind: 'HorizontalPodAutoscaler', label: t('Autoscaler'), hint: t('Scale on CPU / memory') },
      { kind: 'Namespace', label: 'Namespace', hint: t('Group of resources') }
    ]
  }
]

export const WORKLOAD_KINDS: readonly string[] = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob'
]

export type AnyForm =
  | { kind: WorkloadKind; f: WorkloadForm }
  | { kind: 'Service'; f: ServiceForm }
  | { kind: 'Ingress'; f: IngressForm }
  | { kind: 'ConfigMap'; f: ConfigMapForm }
  | { kind: 'Secret'; f: SecretForm }
  | { kind: 'PersistentVolumeClaim'; f: PvcForm }
  | { kind: 'HorizontalPodAutoscaler'; f: HpaForm }
  | { kind: 'Namespace'; f: NamespaceForm }

export function initial(kind: FormKind, ns: string): AnyForm {
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

export function build(form: AnyForm): {
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
