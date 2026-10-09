import { describe, expect, it } from 'vitest'
import { yamlTypedName } from '../../shared/yamlTyped'

describe('yamlTypedName — chuỗi gõ lại trước khi ghi YAML lên production', () => {
  it('một đối tượng → tên của nó', () => {
    expect(yamlTypedName('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-cfg\n')).toBe(
      'app-cfg'
    )
  })
  it('nhiều tài liệu → số đối tượng', () => {
    const yaml = 'kind: A\nmetadata:\n  name: a\n---\nkind: B\nmetadata:\n  name: b\n'
    expect(yamlTypedName(yaml)).toBe('2 objects')
  })
  it('tài liệu rỗng giữa các dấu --- không tính; một đối tượng vẫn gõ tên', () => {
    expect(yamlTypedName('---\nkind: A\nmetadata:\n  name: a\n---\n')).toBe('a')
  })
  it('không đọc được tên → "1 object" (vẫn phải gõ gì đó)', () => {
    expect(yamlTypedName('kind: A\n')).toBe('1 object')
  })
})
