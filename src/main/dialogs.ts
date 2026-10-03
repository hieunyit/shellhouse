import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue
} from 'electron'

// Hộp thoại hệ thống gắn với cửa sổ (modal) nếu còn cửa sổ, không thì đứng riêng.

export function showOpenDialog(
  window: BrowserWindow | null,
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  return window && !window.isDestroyed()
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options)
}

export function showSaveDialog(
  window: BrowserWindow | null,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue> {
  return window && !window.isDestroyed()
    ? dialog.showSaveDialog(window, options)
    : dialog.showSaveDialog(options)
}

export function showMessageBox(
  window: BrowserWindow | null,
  options: MessageBoxOptions
): Promise<MessageBoxReturnValue> {
  return window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options)
}
