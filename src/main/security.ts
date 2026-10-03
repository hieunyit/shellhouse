import { app, BrowserWindow, shell, type WebContents, type WebPreferences } from 'electron'
import log from 'electron-log/main'
import { showMessageBox } from './dialogs'
import { isAppUrl, isSafeExternalUrl } from './security-policy'
import { t } from '@shared/i18n'

/** Cấu hình bắt buộc cho mọi BrowserWindow. Không được nới lỏng. */
export function secureWebPreferences(
  preload: string,
  additionalArguments: string[] = []
): WebPreferences {
  return {
    preload,
    // Đọc đồng bộ ở preload (process.argv) — ví dụ ngôn ngữ giao diện.
    additionalArguments,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    // Bản phát hành không có Developer Tools (không ai mở được để đọc dữ liệu trong cửa sổ).
    devTools: !app.isPackaged
  }
}

/** Áp các chặn toàn cục: không mở cửa sổ mới, không điều hướng, không cấp quyền. */
export function installGlobalGuards(devServerUrl: string | undefined, appIndexHtml: string): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        void confirmOpenExternal(contents, url)
      } else {
        log.warn(`Blocked window open: ${url}`)
      }
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url, devServerUrl, appIndexHtml)) {
        log.warn(`Blocked navigation: ${url}`)
        event.preventDefault()
      }
    })

    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      // Clipboard do main xử lý qua IPC; renderer không cần quyền nào.
      log.warn(`Denied permission: ${permission}`)
      callback(false)
    })
    contents.session.setPermissionCheckHandler(() => false)
  })
}

/**
 * Link có thể đến từ output của server (không tin cậy) — luôn hỏi trước khi mở, hiện URL đầy đủ
 * để người dùng thấy được domain thật. Mặc định là Cancel.
 */
async function confirmOpenExternal(contents: WebContents, url: string): Promise<void> {
  const options = {
    type: 'question' as const,
    buttons: [t('Cancel'), t('Open Link')],
    defaultId: 0,
    cancelId: 0,
    message: t('Open this link in your browser?'),
    detail: url.length > 500 ? `${url.slice(0, 500)}…` : url
  }
  const { response } = await showMessageBox(BrowserWindow.fromWebContents(contents), options)
  if (response === 1) await shell.openExternal(url)
}
