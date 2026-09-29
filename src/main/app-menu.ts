import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * Thanh menu của app. Mặc định Electron có File / Edit / View / Window / Help với Reload, Developer
 * Tools, Zoom… — không cần cho người dùng (lệnh của app có trên thanh tab, bảng lệnh, phím tắt).
 * - Windows / Linux: không có thanh menu.
 * - macOS: menu là bắt buộc (Quit, Hide, và ⌘C/⌘V trong ô nhập đi qua menu Edit) → chỉ giữ
 *   những mục đó.
 * Developer Tools chỉ có ở bản dev (F12).
 */
export function installAppMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Bản dev: F12 mở Developer Tools (bản phát hành không có). */
export function installDevToolsShortcut(window: BrowserWindow): void {
  if (app.isPackaged) return
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault()
      window.webContents.toggleDevTools()
    }
  })
}
