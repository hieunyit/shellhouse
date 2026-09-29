import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * Menu chuột phải chuẩn cho ô nhập và chữ đang chọn (Electron không tự có như trình duyệt).
 * Terminal có menu riêng ở renderer — nó gọi preventDefault nên sự kiện không tới đây.
 * Ô mật khẩu: Chromium tự tắt Cut/Copy (editFlags).
 */
export function installEditContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const flags = params.editFlags
    let template: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      template = [
        { role: 'undo', label: 'Undo', enabled: flags.canUndo },
        { role: 'redo', label: 'Redo', enabled: flags.canRedo },
        { type: 'separator' },
        { role: 'cut', label: 'Cut', enabled: flags.canCut },
        { role: 'copy', label: 'Copy', enabled: flags.canCopy },
        { role: 'paste', label: 'Paste', enabled: flags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: 'Select All', enabled: flags.canSelectAll }
      ]
    } else if (params.selectionText.trim()) {
      template = [{ role: 'copy', label: 'Copy', enabled: flags.canCopy }]
    }
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window })
  })
}
