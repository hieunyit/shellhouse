import { describe, expect, it } from 'vitest'
import { MAX_FINDINGS, parseTrivyReport } from '../../src/shared/trivy'

const image = {
  SchemaVersion: 2,
  ArtifactName: 'nginx:1.21',
  Metadata: { OS: { Family: 'debian', Name: '11.6' } },
  Results: [
    {
      Target: 'nginx:1.21 (debian 11.6)',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2023-0001',
          PkgName: 'openssl',
          InstalledVersion: '1.1.1n',
          FixedVersion: '1.1.1o',
          Severity: 'HIGH',
          Title: 'openssl: bad thing\nsecond line',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2023-0001'
        },
        { VulnerabilityID: 'CVE-2023-0002', PkgName: 'zlib', Severity: 'CRITICAL', Title: 'zlib' },
        { VulnerabilityID: 'CVE-2023-0003', PkgName: 'curl', Severity: 'weird' },
        { PkgName: 'no-id', Severity: 'LOW' }
      ]
    },
    { Target: 'app/package-lock.json', Vulnerabilities: null }
  ]
}

describe('parseTrivyReport — quét image', () => {
  it('đếm theo mức độ, xếp nặng trước, giữ bản sửa, bỏ mục không có mã', () => {
    const r = parseTrivyReport(JSON.stringify(image), 'x', 1)
    expect(r.target).toBe('nginx:1.21')
    expect(r.os).toBe('debian 11.6')
    expect(r.summary).toEqual({ CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 1 })
    expect(r.findings.map((f) => f.id)).toEqual(['CVE-2023-0002', 'CVE-2023-0001', 'CVE-2023-0003'])
    const high = r.findings.find((f) => f.id === 'CVE-2023-0001')
    expect(high).toMatchObject({
      subject: 'openssl',
      installed: '1.1.1n',
      fixed: '1.1.1o',
      title: 'openssl: bad thing'
    })
    expect(r.fixable).toBe(1)
    expect(r.truncated).toBe(false)
  })

  it('image sạch (không có Results) vẫn là báo cáo hợp lệ', () => {
    const r = parseTrivyReport(JSON.stringify({ ArtifactName: 'alpine:3.20' }), 'x')
    expect(r.findings).toEqual([])
    expect(r.summary.CRITICAL).toBe(0)
  })

  it('cắt khi quá nhiều nhưng số liệu tóm tắt vẫn đủ', () => {
    const many = {
      ArtifactName: 'big',
      Results: [
        {
          Target: 't',
          Vulnerabilities: Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => ({
            VulnerabilityID: `CVE-${String(i)}`,
            PkgName: 'p',
            Severity: 'LOW'
          }))
        }
      ]
    }
    const r = parseTrivyReport(JSON.stringify(many), 'x')
    expect(r.findings).toHaveLength(MAX_FINDINGS)
    expect(r.truncated).toBe(true)
    expect(r.summary.LOW).toBe(MAX_FINDINGS + 5)
  })

  it('không phải JSON → lỗi kèm đoạn Trivy đã nói', () => {
    expect(() => parseTrivyReport('FATAL unable to download db', 'x')).toThrow(
      /did not return a JSON report: FATAL unable to download db/
    )
  })

  it('JSON nhưng không phải báo cáo Trivy → lỗi', () => {
    expect(() => parseTrivyReport('{"hello":1}', 'x')).toThrow(/does not look like a Trivy report/)
    expect(() => parseTrivyReport('[]', 'x')).toThrow(/does not look like a Trivy report/)
  })
})

describe('parseTrivyReport — cấu hình K8s', () => {
  it('chỉ lấy luật FAIL, giữ gợi ý khắc phục và dòng', () => {
    const cfg = {
      ArtifactName: 'deploy.yaml',
      Results: [
        {
          Target: 'deploy.yaml',
          Class: 'config',
          Misconfigurations: [
            {
              ID: 'KSV014',
              AVDID: 'AVD-KSV-0014',
              Title: 'Root file system is not read-only',
              Message: 'Container "web" should set readOnlyRootFilesystem to true',
              Resolution: 'Change readOnlyRootFilesystem to true.',
              Severity: 'HIGH',
              Status: 'FAIL',
              CauseMetadata: { StartLine: 21 }
            },
            { ID: 'KSV001', Title: 'ok', Severity: 'MEDIUM', Status: 'PASS' }
          ]
        }
      ]
    }
    const r = parseTrivyReport(JSON.stringify(cfg), 'x')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({
      kind: 'misconfiguration',
      id: 'AVD-KSV-0014',
      severity: 'HIGH',
      subject: 'Root file system is not read-only',
      line: 21,
      resolution: 'Change readOnlyRootFilesystem to true.'
    })
    expect(r.summary.HIGH).toBe(1)
  })
})
