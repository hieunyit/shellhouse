import { Cloud } from 'lucide-react'
import { defineTab, type RendererModule } from '../../registry/renderer-types'
import { lazyModuleComponent } from '../../registry/renderer-kit'
import { s3Manifest } from '../manifest'
import { S3BrowserParams } from '../shared/ipc'
import { s3LocationTitle } from './api'
import { useS3 } from './store'

/** Phần renderer của S3: mục thanh bên, tab trình quản lý, trang cài đặt. */
export const s3Renderer: RendererModule = {
  manifest: s3Manifest,
  SidebarSection: lazyModuleComponent(() => import('./S3Section').then((m) => m.S3Section)),
  tabs: {
    browser: defineTab({
      component: lazyModuleComponent(() => import('./S3View').then((m) => m.S3Tab)),
      params: S3BrowserParams,
      icon: Cloud,
      title: (p) =>
        p.bucket
          ? s3LocationTitle(p.bucket, p.prefix ?? '')
          : (useS3.getState().accounts.find((a) => a.id === p.accountId)?.name ?? 'S3')
    })
  },
  SettingsPage: lazyModuleComponent(() => import('./S3Settings').then((m) => m.S3Settings))
}
