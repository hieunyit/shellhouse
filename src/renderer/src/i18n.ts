import { setLanguage } from '@shared/i18n'

/**
 * Đặt ngôn ngữ giao diện TRƯỚC mọi module khác của renderer (import đầu tiên trong main.tsx): main
 * truyền ngôn ngữ qua argv, preload phơi ra đồng bộ — không phải chờ IPC.
 */
setLanguage(window.shellhouse.language, window.shellhouse.locale)
document.documentElement.lang = window.shellhouse.language
