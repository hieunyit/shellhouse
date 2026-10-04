import { t } from './i18n'
import type { RdpFileOnlyOption } from './rdp'

/** Tên tuỳ chọn (theo ngôn ngữ giao diện) — gọi lúc hiển thị, không ở cấp module. */
function optionLabel(option: RdpFileOnlyOption): string {
  switch (option) {
    case 'clipboard':
      return t('Clipboard off')
    case 'drives':
      return t('Local drives')
    case 'audio':
      return t('Audio off')
    case 'printers':
      return t('Printers')
    case 'gateway':
      return t('RD Gateway')
    case 'scale':
      return t('Custom scale')
    case 'smartSizing':
      return t('Fixed resolution')
  }
}

/**
 * mstsc phải mở bằng file .rdp tạm (chưa ký) cho các tuỳ chọn này → Windows hiện cảnh báo
 * "Unknown publisher". null = mở bằng tham số dòng lệnh, không có cảnh báo.
 */
export function unsignedRdpNotice(options: readonly RdpFileOnlyOption[]): string | null {
  if (options.length === 0) return null
  return t(
    "Windows will show an “Unknown publisher” warning for these options because the connection file isn't signed: {options}",
    { options: options.map(optionLabel).join(', ') }
  )
}
