import { describe, expect, it } from 'vitest'
import {
  jsonPathValues,
  parsePath,
  printerCell,
  printerTone,
  usablePrinterColumns,
  type PrinterColumn
} from '../../shared/printer'

const cert = {
  metadata: {
    name: 'web-tls',
    annotations: { 'cert-manager.io/issuer-name': 'letsencrypt', plain: 'x' }
  },
  spec: { size: 3, secretName: 'web-tls', hosts: ['a.example.com', 'b.example.com'] },
  status: {
    sync: { status: 'Synced' },
    conditions: [
      { type: 'Issuing', status: 'False' },
      { type: 'Ready', status: 'True', reason: 'Ready' }
    ],
    notAfter: '2026-01-01T00:00:00Z'
  }
}

describe('JSONPath của cột in CRD', () => {
  it('đường dẫn thường, chỉ số, wildcard', () => {
    expect(jsonPathValues(cert, '.spec.size')).toEqual([3])
    expect(jsonPathValues(cert, '{.spec.secretName}')).toEqual(['web-tls'])
    expect(jsonPathValues(cert, '.spec.hosts[0]')).toEqual(['a.example.com'])
    expect(jsonPathValues(cert, '.spec.hosts[-1]')).toEqual(['b.example.com'])
    expect(jsonPathValues(cert, '.spec.hosts[*]')).toEqual(['a.example.com', 'b.example.com'])
    expect(jsonPathValues(cert, '.status.sync.status')).toEqual(['Synced'])
  })

  it('bộ lọc điều kiện — cert-manager Ready, Argo, khoá có dấu chấm', () => {
    expect(jsonPathValues(cert, '.status.conditions[?(@.type=="Ready")].status')).toEqual(['True'])
    expect(jsonPathValues(cert, ".status.conditions[?(@.type=='Issuing')].status")).toEqual([
      'False'
    ])
    expect(jsonPathValues(cert, '.status.conditions[?(@.status!="False")].type')).toEqual(['Ready'])
    expect(jsonPathValues(cert, ".metadata.annotations['cert-manager.io/issuer-name']")).toEqual([
      'letsencrypt'
    ])
    expect(jsonPathValues(cert, '.metadata.annotations.cert-manager\\.io/issuer-name')).toEqual([
      'letsencrypt'
    ])
  })

  it('thiếu giá trị / cú pháp không hỗ trợ → rỗng, không ném lỗi', () => {
    expect(jsonPathValues(cert, '.status.missing.deep')).toEqual([])
    expect(jsonPathValues(cert, '..size')).toEqual([])
    expect(jsonPathValues(cert, '.spec.hosts[1:2]')).toEqual([])
    expect(jsonPathValues(cert, '.status.conditions[?(@.type > 1)]')).toEqual([])
    expect(parsePath('.a[')).toBeNull()
    expect(jsonPathValues(null, '.a')).toEqual([])
  })
})

describe('ô của cột in', () => {
  const col = (jsonPath: string, type = 'string'): PrinterColumn => ({
    id: 'pc0',
    label: 'X',
    type,
    jsonPath
  })
  it('số, chuỗi, nhiều giá trị nối bằng dấu phẩy, đối tượng thành JSON, thiếu → rỗng', () => {
    expect(printerCell(cert, col('.spec.size', 'integer'))).toBe('3')
    expect(printerCell(cert, col('.spec.hosts[*]'))).toBe('a.example.com,b.example.com')
    expect(printerCell(cert, col('.status.sync'))).toBe('{"status":"Synced"}')
    expect(printerCell(cert, col('.status.nothing'))).toBe('')
  })
  it('kiểu date → tuổi như cột Age', () => {
    const now = Date.parse('2026-01-01T03:00:00Z')
    expect(printerCell(cert, col('.status.notAfter', 'date'), now)).toBe('3h')
    expect(printerCell(cert, col('.status.nope', 'date'), now)).toBe('')
  })
})

describe('chọn cột hiện', () => {
  it('bỏ Name / Age (bảng đã có), cột ưu tiên > 0 và đường dẫn không đọc được; đặt id pc0…', () => {
    const cols = usablePrinterColumns([
      { name: 'Name', type: 'string', jsonPath: '.metadata.name' },
      { name: 'Size', type: 'integer', jsonPath: '.spec.size' },
      { name: 'Wide', type: 'string', jsonPath: '.spec.wide', priority: 1 },
      { name: 'Bad', type: 'string', jsonPath: '..x' },
      { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
      { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
      { type: 'string' }
    ])
    expect(cols.map((c) => [c.id, c.label])).toEqual([
      ['pc0', 'Size'],
      ['pc1', 'Ready']
    ])
  })
  it('tối đa 12 cột', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `C${String(i)}`,
      jsonPath: `.spec.f${String(i)}`
    }))
    expect(usablePrinterColumns(many)).toHaveLength(12)
  })
})

describe('màu ô trạng thái', () => {
  it('chỉ cột tên Status / Ready / Phase… mới tô; giá trị lạ để nguyên', () => {
    expect(printerTone('Ready', 'True')).toBe('ok')
    expect(printerTone('Ready', 'False')).toBe('bad')
    expect(printerTone('Phase', 'Pending')).toBe('warn')
    expect(printerTone('Health', 'Degraded')).toBe('bad')
    expect(printerTone('Status', 'weird-value')).toBeNull()
    expect(printerTone('Size', 'True')).toBeNull()
    expect(printerTone('Ready', '')).toBeNull()
  })
})
