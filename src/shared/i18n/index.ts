import { vi } from './vi'

/**
 * Đa ngôn ngữ (dùng chung main + renderer + module). Chuỗi tiếng Anh trong code CHÍNH LÀ khoá:
 *
 *   t('Delete host')                       → "Xoá host" (vi) / "Delete host" (en)
 *   t('Delete “{name}”?', { name })        → tham số trong {ngoặc nhọn}
 *   tn(count, '{n} file', '{n} files')     → số ít / số nhiều ({n} đã định dạng theo locale)
 *
 * Thiếu bản dịch → hiện tiếng Anh (không bao giờ hiện khoá rỗng). `test/unit/i18n.test.ts` quét mã
 * nguồn và báo mọi chuỗi `t('…')` chưa có trong từ điển tiếng Việt.
 *
 * Quy ước:
 * - Khoá phải là chuỗi literal ('…' hoặc "…"), không ghép chuỗi / template literal — để quét được.
 * - Gọi `t()` lúc render (trong component / hàm), không ở hằng cấp module: ngôn ngữ được đặt trước
 *   lần vẽ đầu nhưng chuỗi tính ở cấp module của file nạp sớm có thể vẫn là tiếng Anh.
 * - Không dịch: tên riêng (Docker, Kubernetes, Pod, Deployment…), lệnh, đường dẫn, dữ liệu từ server.
 */

export type Language = 'en' | 'vi'
export type LanguageSetting = 'system' | Language

/** Danh sách cho ô chọn ngôn ngữ — tên ngôn ngữ luôn viết bằng chính ngôn ngữ đó. */
export const LANGUAGES: readonly { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'vi', label: 'Tiếng Việt' }
]

const CATALOGS: Record<Language, Readonly<Record<string, string>> | null> = { en: null, vi }

let current: Language = 'en'
let currentLocale = 'en-US'

/** Ngôn ngữ thực dùng: cài đặt cố định, hoặc theo danh sách ngôn ngữ ưa thích của hệ điều hành. */
export function resolveLanguage(
  setting: LanguageSetting | undefined,
  systemLanguages: readonly string[]
): Language {
  if (setting === 'en' || setting === 'vi') return setting
  for (const tag of systemLanguages) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    if (base === 'vi') return 'vi'
    if (base === 'en') return 'en'
  }
  return 'en'
}

/**
 * Locale cho định dạng ngày / số: theo ngôn ngữ giao diện, nhưng giữ vùng của hệ thống nếu cùng
 * ngôn ngữ (en-GB vẫn ra 17/08/2026). Ngôn ngữ giao diện khác hệ thống → locale chuẩn của ngôn ngữ đó.
 */
export function resolveLocale(language: Language, systemLanguages: readonly string[]): string {
  const same = systemLanguages.find((tag) => tag.toLowerCase().split(/[-_]/)[0] === language)
  if (same) {
    try {
      return Intl.getCanonicalLocales(same.replace('_', '-'))[0] ?? fallbackLocale(language)
    } catch {
      return fallbackLocale(language)
    }
  }
  return fallbackLocale(language)
}

function fallbackLocale(language: Language): string {
  return language === 'vi' ? 'vi-VN' : 'en-US'
}

export function setLanguage(language: Language, locale?: string): void {
  current = language
  currentLocale = locale ?? fallbackLocale(language)
}

export function language(): Language {
  return current
}

export function locale(): string {
  return currentLocale
}

export type Params = Readonly<Record<string, string | number>>

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  )
}

/** Dịch một chuỗi (chuỗi tiếng Anh là khoá). */
export function t(text: string, params?: Params): string {
  return interpolate(CATALOGS[current]?.[text] ?? text, params)
}

/** Formatter số theo locale, tạo một lần (tạo Intl.NumberFormat mỗi lần gọi rất đắt — ~0.1 ms). */
let countFormat: { locale: string; format: Intl.NumberFormat } | null = null

/** Số ít / số nhiều: `{n}` là số đã định dạng theo locale. */
export function tn(count: number, one: string, other: string, params?: Params): string {
  if (countFormat?.locale !== currentLocale)
    countFormat = { locale: currentLocale, format: new Intl.NumberFormat(currentLocale) }
  return t(count === 1 ? one : other, {
    n: countFormat.format.format(count),
    ...params
  })
}
