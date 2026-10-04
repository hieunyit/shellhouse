import { join } from 'node:path'

/** Tên file của tiến trình phụ (native/rdp-host-win). */
export const HELPER_EXE = 'shellhouse-rdp-host.exe'

/**
 * Đường dẫn tiến trình phụ: bản cài → resources/rdp-host/ (electron-builder extraResources, chỉ
 * Windows); bản dev → kết quả build của native/rdp-host-win (`pnpm build:rdp-host`). E2E được trỏ
 * sang file khác bằng biến môi trường (chỉ khi chưa đóng gói).
 */
export function helperCandidates(input: {
  packaged: boolean
  resourcesPath: string
  appPath: string
  override: string | undefined
}): string[] {
  if (input.packaged) return [join(input.resourcesPath, 'rdp-host', HELPER_EXE)]
  return [
    ...(input.override ? [input.override] : []),
    join(input.appPath, 'native', 'rdp-host-win', 'bin', HELPER_EXE)
  ]
}

/** HWND (Buffer của getNativeWindowHandle) → số thập phân cho --parent. */
export function hwndOf(buffer: Buffer): string {
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0).toString() : String(buffer.readUInt32LE(0))
}
