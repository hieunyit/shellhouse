import { registerCatalog, setLanguage } from '@shared/i18n'

/**
 * Đặt ngôn ngữ giao diện TRƯỚC mọi module khác của renderer (import đầu tiên trong main.tsx): main
 * truyền ngôn ngữ qua argv, preload phơi ra đồng bộ — không phải chờ IPC.
 */
setLanguage(window.shellhouse.language, window.shellhouse.locale)
document.documentElement.lang = window.shellhouse.language

/**
 * Từ điển của ngôn ngữ giao diện — chỉ tải khi cần (từ điển tiếng Việt ~290 KB, không nằm trong
 * chunk khởi động của người dùng tiếng Anh). Gọi xong rồi mới nạp phần còn lại của app (boot.tsx):
 * chuỗi tính lúc nạp module cũng phải được dịch.
 */
export async function loadCatalog(): Promise<void> {
  if (window.shellhouse.language !== 'vi') return
  const { vi } = await import('@shared/i18n/vi')
  registerCatalog('vi', vi)
}
