import { app, BrowserWindow, dialog, shell, type WebContents, type WebPreferences } from 'electron'
import log from 'electron-log/main'
import { isAppUrl, isSafeExternalUrl } from './security-policy'

/** Cấu hình bắt buộc cho mọi BrowserWindow. Không được nới lỏng. */
export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
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
export function installGlobalGuards(devServerUrl: string | undefined): void {
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
      if (!isAppUrl(url, devServerUrl)) {
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
    buttons: ['Cancel', 'Open Link'],
    defaultId: 0,
    cancelId: 0,
    message: 'Open this link in your browser?',
    detail: url.length > 500 ? `${url.slice(0, 500)}…` : url
  }
  const window = BrowserWindow.fromWebContents(contents)
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (response === 1) await shell.openExternal(url)
}
