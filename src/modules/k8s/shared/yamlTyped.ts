import { tn } from '@shared/i18n'
import { parseAllDocuments } from 'yaml'

/**
 * Chuỗi phải gõ lại trước khi ghi YAML lên cluster production: tên đối tượng nếu chỉ có một, không
 * thì số đối tượng ("3 objects"). Lấy từ chính YAML sắp ghi — không phụ thuộc cách mở trình sửa.
 */
export function yamlTypedName(text: string): string {
  const names: string[] = []
  for (const doc of parseAllDocuments(text)) {
    const json = doc.toJSON() as { metadata?: { name?: unknown } } | null
    if (json === null || typeof json !== 'object') continue
    const name = json.metadata?.name
    names.push(typeof name === 'string' && name ? name : '')
  }
  const only = names.length === 1 ? names[0] : undefined
  return only || tn(Math.max(1, names.length), '{n} object', '{n} objects')
}
