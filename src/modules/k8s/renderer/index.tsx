import { FileText, Ship } from 'lucide-react'
import { defineTab, type RendererModule } from '../../registry/renderer-types'
import { lazyModuleComponent } from '../../registry/renderer-kit'
import { k8sManifest } from '../manifest'
import { K8sClusterParams, K8sLogsParams } from '../shared/ops'

/** Phần renderer của Kubernetes: thanh bên, tab cluster, tab log pod, cài đặt. */
export const k8sRenderer: RendererModule = {
  manifest: k8sManifest,
  SidebarSection: lazyModuleComponent(() => import('./K8sSection').then((m) => m.K8sSection)),
  tabs: {
    cluster: defineTab({
      component: lazyModuleComponent(() => import('./K8sView').then((m) => m.ClusterTab)),
      params: K8sClusterParams,
      icon: Ship,
      title: (p) => p.label
    }),
    logs: defineTab({
      component: lazyModuleComponent(() => import('./LogsView').then((m) => m.PodLogsTab)),
      params: K8sLogsParams,
      icon: FileText,
      title: (p) => `${p.pod} (logs)`
    })
  },
  commands: () => [
    {
      id: 'import',
      title: 'Import a kubeconfig',
      run: () => {
        document.querySelector<HTMLButtonElement>('[data-testid="k8s-import"]')?.click()
      }
    }
  ],
  SettingsPage: lazyModuleComponent(() => import('./K8sSettings').then((m) => m.K8sSettings))
}
