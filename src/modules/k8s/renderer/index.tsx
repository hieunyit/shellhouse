import { FileText, Ship } from 'lucide-react'
import { defineTab, type RendererModule } from '../../registry/renderer-types'
import { lazyModuleComponent, t } from '../../registry/renderer-kit'
import { k8sManifest } from '../manifest'
import { K8sClusterParams, K8sLogsParams } from '../shared/ops'
import { k8sApi } from './api'

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
      title: (p) => t('{name} (logs)', { name: p.pod ?? p.title ?? 'pods' })
    })
  },
  commands: () => [
    {
      id: 'import',
      title: t('Import kubeconfig files'),
      run: () => {
        k8sApi.importFiles().then(
          (r) => {
            if (r.errors.length) window.alert(r.errors.join('\n'))
          },
          (e: unknown) => {
            window.alert(e instanceof Error ? e.message : String(e))
          }
        )
      }
    }
  ],
  SettingsPage: lazyModuleComponent(() => import('./K8sSettings').then((m) => m.K8sSettings)),
  // Theo dõi nền cho Home (chunk riêng — chỉ nạp khi module bật).
  background: () => {
    let stop: (() => void) | null = null
    let dead = false
    void import('./fleet').then((m) => {
      if (!dead) stop = m.startK8sFleet()
    })
    return () => {
      dead = true
      stop?.()
    }
  }
}
