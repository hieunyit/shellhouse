import { Container, FileText } from 'lucide-react'
import { defineTab, type RendererModule } from '../../registry/renderer-types'
import { lazyModuleComponent } from '../../registry/renderer-kit'
import { dockerManifest } from '../manifest'
import { DockerEngineParams, DockerLogsParams } from '../shared/ops'
import { openDocker } from './api'

/** Phần renderer của Docker: thanh bên, tab Docker, tab log, menu host, lệnh, cài đặt. */
export const dockerRenderer: RendererModule = {
  manifest: dockerManifest,
  SidebarSection: lazyModuleComponent(() => import('./DockerSection').then((m) => m.DockerSection)),
  tabs: {
    engine: defineTab({
      component: lazyModuleComponent(() => import('./DockerView').then((m) => m.DockerTab)),
      params: DockerEngineParams,
      icon: Container,
      title: (p) => `Docker · ${p.label}`
    }),
    logs: defineTab({
      component: lazyModuleComponent(() => import('./LogsView').then((m) => m.LogsTab)),
      params: DockerLogsParams,
      icon: FileText,
      title: (p) => `${p.name} (logs)`
    })
  },
  hostActions: (host) =>
    host.protocol === 'ssh'
      ? [
          {
            id: 'open',
            label: 'Docker…',
            icon: <Container size={14} />,
            onSelect: () => {
              openDocker(host.hostId)
            }
          }
        ]
      : [],
  commands: () => [
    {
      id: 'open-local',
      title: 'Open Docker on this computer',
      run: () => {
        openDocker(null)
      }
    }
  ],
  SettingsPage: lazyModuleComponent(() => import('./DockerSettings').then((m) => m.DockerSettings))
}
