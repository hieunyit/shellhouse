import { ListChecks } from 'lucide-react'
import { defineTab, type RendererModule } from '../../registry/renderer-types'
import { lazyModuleComponent, t } from '../../registry/renderer-kit'
import { runbookManifest } from '../manifest'
import { RunbookTabParams } from '../shared/runbook'
import { useRunbooks } from './store'

/** Phần renderer của Runbook: mục thanh bên (danh sách) và tab soạn / chạy một runbook. */
export const runbookRenderer: RendererModule = {
  manifest: runbookManifest,
  SidebarSection: lazyModuleComponent(() =>
    import('./RunbookSection').then((m) => m.RunbookSection)
  ),
  tabs: {
    runbook: defineTab({
      component: lazyModuleComponent(() => import('./RunbookView').then((m) => m.RunbookTab)),
      params: RunbookTabParams,
      icon: ListChecks,
      title: (p) =>
        (p.id ? useRunbooks.getState().runbooks.find((r) => r.id === p.id)?.name : undefined) ??
        t('New runbook')
    })
  },
  commands: () => [
    {
      id: 'new',
      title: t('New runbook'),
      run: () => {
        void import('./actions').then((m) => {
          m.openRunbook()
        })
      }
    },
    {
      id: 'import',
      title: t('Import runbooks…'),
      run: () => {
        void import('./actions').then((m) => m.importFromFile())
      }
    }
  ]
}
