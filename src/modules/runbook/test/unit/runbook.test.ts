import { describe, expect, it } from 'vitest'
import {
  CommandParams,
  HttpParams,
  RunbookInput,
  builtinSummary,
  evalCommand,
  evalHttp,
  defaultHttp,
  exportRunbooks,
  maskSecrets,
  remapHosts,
  RunbookFile,
  stripSecretRefs,
  uniqueName,
  newStepId,
  renderParams,
  runbookVariables,
  tailOutput,
  type RunbookStep
} from '../../shared/runbook'

const step = (id: string, type: string, params: unknown): RunbookStep => ({
  id,
  name: '',
  type,
  params,
  timeoutSec: 30,
  continueOnFail: false
})

describe('evalHttp', () => {
  const p: HttpParams = {
    ...defaultHttp(),
    url: 'https://x/health',
    expectStatus: [200, 204]
  }
  it('đạt khi mã nằm trong danh sách', () => {
    expect(evalHttp(p, { status: 204, body: '' })).toEqual({ ok: true, detail: 'HTTP 204' })
  })
  it('sai mã → lỗi nêu mã nhận được và mã mong đợi, kèm thân phản hồi', () => {
    const r = evalHttp(p, { status: 503, body: 'upstream down' })
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('HTTP 503 (expected 200 / 204)')
    expect(r.output).toBe('upstream down')
  })
  it('đúng mã nhưng thiếu chuỗi cần có → lỗi', () => {
    const r = evalHttp({ ...p, contains: '"ok":true' }, { status: 200, body: '{"ok":false}' })
    expect(r).toMatchObject({ ok: false })
    expect(r.detail).toContain('does not contain')
    expect(evalHttp({ ...p, contains: 'ok' }, { status: 200, body: 'all ok' }).ok).toBe(true)
  })
  it('lỗi mạng → lỗi kèm nguyên văn', () => {
    expect(evalHttp(p, { status: null, body: '', error: 'ECONNREFUSED' })).toEqual({
      ok: false,
      detail: 'ECONNREFUSED'
    })
  })
})

describe('evalCommand', () => {
  const p: CommandParams = { hostId: 'h', command: 'systemctl is-active app', contains: '' }
  it('mã thoát 0 → đạt, giữ đầu ra', () => {
    expect(
      evalCommand(p, { code: 0, stdout: 'active\n', stderr: '', timedOut: false }, 30)
    ).toEqual({ ok: true, detail: 'Exit code 0', output: 'active' })
  })
  it('mã khác 0 → lỗi kèm đầu ra; hết giờ → lỗi riêng', () => {
    const failed = evalCommand(p, { code: 3, stdout: '', stderr: 'inactive', timedOut: false }, 30)
    expect(failed).toMatchObject({ ok: false, detail: 'Exit code 3', output: 'inactive' })
    const slow = evalCommand(p, { code: null, stdout: '', stderr: '', timedOut: true }, 10)
    expect(slow.detail).toBe('Did not finish within 10 s')
  })
  it('đầu ra phải chứa chuỗi — chỉ xét stdout, không xét stderr', () => {
    const c = { ...p, contains: 'active' }
    expect(
      evalCommand(c, { code: 0, stdout: 'inactive?', stderr: '', timedOut: false }, 5).ok
    ).toBe(true)
    expect(evalCommand(c, { code: 0, stdout: '', stderr: 'active', timedOut: false }, 5).ok).toBe(
      false
    )
  })
})

describe('maskSecrets / tailOutput', () => {
  it('che giá trị sau tên kiểu bí mật và mật khẩu trong chuỗi kết nối', () => {
    expect(maskSecrets('DB_PASSWORD=hunter2 user=bob')).toBe('DB_PASSWORD=•••• user=bob')
    expect(maskSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: ••••')
    expect(maskSecrets('token: s3cr3t')).toBe('token: ••••')
    expect(maskSecrets('API_KEY_ID=AKIA123')).toBe('API_KEY_ID=••••')
    expect(maskSecrets('curl -H "Authorization: Bearer abc" x')).toBe(
      'curl -H "Authorization: ••••'
    )
    expect(maskSecrets('pass 3 tests, secret store ready')).toBe('pass 3 tests, secret store ready')
    // JSON / YAML trả về từ health endpoint, `kubectl -o json`…
    expect(maskSecrets('{"status":"down","password":"hunter2","user":"a"}')).toBe(
      '{"status":"down","password":"••••","user":"a"}'
    )
    expect(maskSecrets('{"access_token": "eyJabc.def", "expires_in": 60}')).toBe(
      '{"access_token": "••••", "expires_in": 60}'
    )
    expect(maskSecrets("{'client_secret': 'abc'}")).toBe("{'client_secret': '••••'}")
    expect(maskSecrets('postgres://app:S3cret!@db:5432/shop')).toBe(
      'postgres://app:••••@db:5432/shop'
    )
    // Chữ thường gặp không bị che.
    expect(maskSecrets('listening on port 8080, status ok')).toBe(
      'listening on port 8080, status ok'
    )
  })
  it('chỉ giữ 20 dòng cuối và bỏ CR', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${String(i)}`).join('\r\n')
    const out = tailOutput(text).split('\n')
    expect(out).toHaveLength(20)
    expect(out[0]).toBe('line 30')
    expect(out.at(-1)).toBe('line 49')
  })
  it('đầu ra có bí mật vẫn bị che khi vào kết quả bước', () => {
    const r = evalCommand(
      { hostId: 'h', command: 'env', contains: '' },
      { code: 1, stdout: 'API_KEY=abc123\n', stderr: '', timedOut: false },
      5
    )
    expect(r.output).toBe('API_KEY=••••')
  })
})

describe('biến {{x}} của runbook', () => {
  const steps = [
    step('s1', 'http', { url: 'https://{{host}}/health', expectStatus: [200], contains: '' }),
    step('s2', 'command', { hostId: 'h', command: 'curl {{host}} {{retries:3}}', contains: '' }),
    step('s3', 'k8s.rollout', { name: '{{app}}', nested: ['{{host}}'] })
  ]
  it('gom biến theo thứ tự, gộp trùng, giữ mặc định', () => {
    expect(runbookVariables(steps)).toEqual([
      { name: 'host', defaultValue: null },
      { name: 'retries', defaultValue: '3' },
      { name: 'app', defaultValue: null }
    ])
  })
  it('thay biến ở mọi chuỗi lồng nhau; thiếu giá trị bắt buộc thì báo', () => {
    expect(renderParams(steps[2]?.params, { app: 'web', host: 'h1' })).toEqual({
      name: 'web',
      nested: ['h1']
    })
    expect(() => renderParams(steps[0]?.params, {})).toThrow(/Missing value for: host/)
    expect(renderParams(steps[1]?.params, { host: 'h' })).toMatchObject({ command: 'curl h 3' })
  })
})

describe('schema', () => {
  it('HttpParams chỉ nhận http(s)://; mã trạng thái 100–599', () => {
    const ok = { url: 'https://a/b', expectStatus: [200], contains: '' }
    expect(HttpParams.safeParse(ok).success).toBe(true)
    expect(HttpParams.safeParse({ ...ok, url: 'file:///etc/passwd' }).success).toBe(false)
    expect(HttpParams.safeParse({ ...ok, url: 'ftp://x' }).success).toBe(false)
    expect(HttpParams.safeParse({ ...ok, expectStatus: [] }).success).toBe(false)
    expect(HttpParams.safeParse({ ...ok, expectStatus: [99] }).success).toBe(false)
  })
  it('RunbookInput: cần tên; tối đa 50 bước; loại bước đúng dạng', () => {
    const base = { name: 'After deploy', description: '', steps: [] }
    expect(RunbookInput.safeParse(base).success).toBe(true)
    expect(RunbookInput.safeParse({ ...base, name: '  ' }).success).toBe(false)
    const many = Array.from({ length: 51 }, (_, i) => step(`s${String(i)}`, 'http', {}))
    expect(RunbookInput.safeParse({ ...base, steps: many }).success).toBe(false)
    expect(RunbookInput.safeParse({ ...base, steps: [step('a', 'Bad Type', {})] }).success).toBe(
      false
    )
    expect(RunbookInput.safeParse({ ...base, steps: [step('a', 'k8s.rollout', {})] }).success).toBe(
      true
    )
  })
  it('mô tả một dòng và id bước mới', () => {
    expect(builtinSummary('http', { url: 'https://a', expectStatus: [200], contains: '' })).toBe(
      'GET https://a'
    )
    expect(builtinSummary('command', { hostId: 'h', command: 'ls\nwc', contains: '' })).toBe('ls')
    expect(builtinSummary('http', {})).toBe('HTTP (incomplete)')
    expect(newStepId(new Set(['s1', 's2']))).toBe('s3')
  })
})

describe('HttpParams', () => {
  it('bước HTTP lưu từ bản cũ (chỉ url / mã / chuỗi) vẫn hợp lệ với mặc định mới', () => {
    expect(
      HttpParams.parse({ url: 'https://x/health', expectStatus: [200], contains: '' })
    ).toEqual({ ...defaultHttp(), url: 'https://x/health' })
  })
  it('header bí mật chưa có giá trị trong vault → chưa đủ; tên header sai → chưa đủ', () => {
    const base = { ...defaultHttp(), url: 'https://x' }
    expect(
      HttpParams.safeParse({ ...base, headers: [{ name: 'X-Token', value: '', secret: true }] })
        .success
    ).toBe(false)
    expect(
      HttpParams.safeParse({
        ...base,
        headers: [{ name: 'X-Token', value: '', secret: true, secretId: 'a' }]
      }).success
    ).toBe(true)
    expect(
      HttpParams.safeParse({ ...base, headers: [{ name: 'Bad Name', value: 'x' }] }).success
    ).toBe(false)
  })
})

describe('xuất / nhập', () => {
  const steps: RunbookStep[] = [
    step('s1', 'http', {
      ...defaultHttp(),
      url: 'https://x',
      headers: [{ name: 'Authorization', value: '', secret: true, secretId: 'sec-1' }]
    }),
    step('s2', 'command', { hostId: 'h-1', command: 'uptime', contains: '' }),
    step('s3', 'docker.container', { source: 'h-2', container: 'web', expect: 'running' })
  ]
  const hosts: Record<string, { label: string; address: string }> = {
    'h-1': { label: 'web-1', address: 'ops@10.0.0.1' },
    'h-2': { label: 'docker-box', address: 'ops@10.0.0.2' }
  }

  it('file xuất không có bí mật; kèm nhãn / địa chỉ của host được nhắc tới', () => {
    const file = exportRunbooks([{ name: 'R', description: 'd', steps }], (id) => hosts[id])
    expect(JSON.stringify(file)).not.toContain('sec-1')
    expect(file.hosts).toEqual(hosts)
    expect(RunbookFile.parse(JSON.parse(JSON.stringify(file)))).toEqual(file)
    const header = (file.runbooks[0]?.steps[0]?.params as HttpParams).headers[0]
    expect(header).toEqual({ name: 'Authorization', value: '', secret: true })
  })

  it('nhập: ghép host theo nhãn + địa chỉ, rồi địa chỉ, rồi nhãn; không thấy thì báo', () => {
    const local = [
      { id: 'L-web', label: 'web-1 (new name)', address: 'ops@10.0.0.1' },
      { id: 'L-other', label: 'other', address: 'root@10.9.9.9' }
    ]
    const r = remapHosts(steps, hosts, local)
    expect((r.steps[1]?.params as { hostId: string }).hostId).toBe('L-web')
    expect((r.steps[2]?.params as { source: string }).source).toBe('h-2')
    expect(r.missing).toEqual(['docker-box (ops@10.0.0.2)'])
    // Chuỗi khác (URL, lệnh) không bị đụng tới.
    expect((r.steps[0]?.params as HttpParams).url).toBe('https://x')
  })

  it('stripSecretRefs bỏ mọi secretId ở mọi độ sâu', () => {
    expect(stripSecretRefs({ a: [{ secretId: 'x', keep: 1 }], secretId: 'y' })).toEqual({
      a: [{ keep: 1 }]
    })
  })

  it('uniqueName: thêm (2), (3)… không phân biệt hoa thường, không quá 100 ký tự', () => {
    expect(uniqueName('Deploy', [])).toBe('Deploy')
    expect(uniqueName('Deploy', ['deploy'])).toBe('Deploy (2)')
    expect(uniqueName('Deploy', ['Deploy', 'Deploy (2)'])).toBe('Deploy (3)')
    const long = 'x'.repeat(100)
    expect(uniqueName(long, [long])).toHaveLength(100)
  })
})
