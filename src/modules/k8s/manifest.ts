import type { ModuleManifest } from '../registry/types'

export const k8sManifest: ModuleManifest = {
  id: 'k8s',
  name: 'Kubernetes',
  summary: 'Pods, logs, shells and port-forwards next to your terminal, even via SSH',
  description:
    'Work with Kubernetes clusters from your kubeconfig: switch context and namespace, watch pods, ' +
    'deployments, services and every other resource live, follow logs, open a shell in a pod as a ' +
    'terminal tab, forward ports, scale and restart workloads, and edit YAML in your own editor ' +
    '(changes are applied only if nobody else changed the object meanwhile).\n\n' +
    'Clusters whose API server is only reachable from inside a network can go through one of your ' +
    'SSH hosts. Mark production contexts read-only, or require typing the resource name before ' +
    'anything destructive.',
  category: 'containers',
  keywords: [
    'kubernetes',
    'k8s',
    'kube',
    'kubectl',
    'pod',
    'helm',
    'cluster',
    'eks',
    'gke',
    'aks',
    'openshift'
  ],
  source: 'builtin',
  since: '1.2.0',
  permissions: [
    { kind: 'read-file', path: '~/.kube/**' },
    { kind: 'read-file', path: '$KUBECONFIG' },
    { kind: 'write-file', path: '~/.kube/**' },
    { kind: 'write-file', path: '$KUBECONFIG' },
    { kind: 'read-file', path: '~/.minikube/**' },
    {
      kind: 'pick-file',
      detail: 'Reads kubeconfig files you choose to import (and the certificates they point to)'
    },
    { kind: 'network', hosts: 'The API servers in your kubeconfig' },
    { kind: 'run-program', binary: 'aws' },
    { kind: 'run-program', binary: 'gcloud' },
    { kind: 'run-program', binary: 'gke-gcloud-auth-plugin' },
    { kind: 'run-program', binary: 'kubelogin' },
    { kind: 'ssh-tunnel' },
    { kind: 'secrets', detail: 'Stores kubeconfigs you import encrypted in the vault' }
  ],
  // Thư mục ~/.kube (file có thể không tên "config" — vd. kubeconfig tải từ Rancher / cloud).
  detect: [{ on: 'startup', probe: 'local-file', path: '~/.kube' }],
  version: 1,
  icon: 'kubernetes',
  enabledByDefault: false,
  binaries: ['aws', 'gcloud', 'gke-gcloud-auth-plugin', 'kubelogin'],
  contributes: {
    sidebarSection: true,
    tabKinds: ['cluster', 'logs'],
    commands: [{ id: 'import', title: 'Import kubeconfig files' }],
    settings: true,
    sessionKinds: ['cluster', 'terminal'],
    attachToSsh: true,
    syncRecordTypes: ['k8s_context']
  }
}
