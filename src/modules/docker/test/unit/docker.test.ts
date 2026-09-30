import { describe, expect, it } from 'vitest'
import { JsonLines, LogDemuxer } from '../../session-host/engine'
import { splitImageRef, toStatsSample } from '../../session-host/api-backend'
import { cliErrorText, composeArgs, parseSize } from '../../session-host/backend'
import { parseLabels, parsePorts } from '../../session-host/cli-backend'
import { execArgs, maskInspect } from '../../session-host/service'
import { localSocketCandidates, WINDOWS_PIPE } from '../../session-host'
import { DockerOp, isMutating, maskEnv } from '../../shared/ops'
import { LineBuffer, MAX_LINES } from '../../shared/log-buffer'

function frame(stream: number, text: string): Buffer {
  const data = Buffer.from(text)
  const h = Buffer.alloc(8)
  h[0] = stream
  h.writeUInt32BE(data.length, 4)
  return Buffer.concat([h, data])
}

describe('Docker — luồng', () => {
  it('LogDemuxer: mảnh cắt ngang header / dữ liệu ở mọi vị trí', () => {
    const all = Buffer.concat([frame(1, 'một\n'), frame(2, 'hai\n'), frame(1, '')])
    for (let cut = 0; cut <= all.length; cut++) {
      const got: string[] = []
      const d = new LogDemuxer((s, data) => got.push(`${s}:${data.toString()}`))
      d.push(all.subarray(0, cut))
      d.push(all.subarray(cut))
      expect(got).toEqual(['stdout:một\n', 'stderr:hai\n', 'stdout:'])
    }
  })

  it('JsonLines: đối tượng cắt ngang, ký tự UTF-8 cắt ngang, dòng hỏng bị bỏ qua', () => {
    const got: unknown[] = []
    const j = new JsonLines((v) => got.push(v))
    const text = Buffer.from('{"a":"ư"}\n{hỏng\n{"b":2}\r\n')
    j.push(text.subarray(0, 7))
    j.push(text.subarray(7))
    expect(got).toEqual([{ a: 'ư' }, { b: 2 }])
  })
})

describe('Docker — chuyển đổi', () => {
  it('ảnh: tách tag; registry có cổng; digest giữ nguyên', () => {
    expect(splitImageRef('nginx')).toEqual({ fromImage: 'nginx', tag: 'latest' })
    expect(splitImageRef('nginx:1.27')).toEqual({ fromImage: 'nginx', tag: '1.27' })
    expect(splitImageRef('reg.local:5000/app')).toEqual({
      fromImage: 'reg.local:5000/app',
      tag: 'latest'
    })
    expect(splitImageRef('ghcr.io/o/a@sha256:ab')).toEqual({ fromImage: 'ghcr.io/o/a@sha256:ab' })
  })

  it('stats: thiếu dữ liệu (mẫu đầu) → bỏ; cgroup v1 dùng cache', () => {
    expect(toStatsSample({})).toBeNull()
    const s = toStatsSample({
      cpu_stats: {
        cpu_usage: { total_usage: 200, percpu_usage: [1, 1, 1, 1] },
        system_cpu_usage: 1000
      },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
      memory_stats: { usage: 300, limit: 1000, stats: { cache: 100 } }
    })
    expect(s).toMatchObject({ cpuPercent: 80, memUsage: 200, memLimit: 1000 })
  })

  it('CLI: kích thước, cổng, nhãn; lỗi thường gặp thành câu dễ hiểu', () => {
    expect(parseSize('1.5GB')).toBe(1_500_000_000)
    expect(parseSize('12MiB')).toBe(12 * 1024 * 1024)
    expect(parseSize('0B')).toBe(0)
    expect(parseSize('rác')).toBe(0)
    expect(parsePorts('0.0.0.0:8000-8001->8000-8001/tcp, 53/udp')).toEqual([
      { ip: '0.0.0.0', publicPort: 8000, privatePort: 8000, type: 'tcp' },
      { ip: '', publicPort: null, privatePort: 53, type: 'udp' }
    ])
    expect(parseLabels('a=1,b=x=y,bad')).toEqual({ a: '1', b: 'x=y' })
    expect(
      cliErrorText(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        1
      )
    ).toMatch(/not running/)
  })

  it('compose, exec: đối số là mảng, không ghép chuỗi lệnh', () => {
    expect(composeArgs('p', 'down', null, 'a.yml,b.yml')).toEqual([
      'compose',
      '-p',
      'p',
      '-f',
      'a.yml',
      '-f',
      'b.yml',
      'down'
    ])
    expect(execArgs({ container: 'abc' })).toEqual([
      'exec',
      '-it',
      '-e',
      'TERM=xterm-256color',
      'abc',
      'sh',
      '-c',
      'command -v bash >/dev/null 2>&1 && exec bash || exec sh'
    ])
    expect(execArgs({ container: 'abc', user: 'root', command: ['psql'] })).toEqual([
      'exec',
      '-it',
      '-e',
      'TERM=xterm-256color',
      '-u',
      'root',
      'abc',
      'psql'
    ])
  })

  it('che biến môi trường bí mật; inspect không có Env giữ nguyên', () => {
    expect(maskEnv('API_TOKEN=abc')).toBe('API_TOKEN=••••••')
    expect(maskEnv('HOME=/root')).toBe('HOME=/root')
    expect(maskEnv('NOEQUALS')).toBe('NOEQUALS')
    expect(maskInspect({ Id: 'x' })).toEqual({ Id: 'x' })
  })

  it('socket trên máy: DOCKER_HOST trước; Windows chỉ named pipe', () => {
    expect(localSocketCandidates({ DOCKER_HOST: 'unix:///tmp/d.sock' }, 'linux', 1000)).toEqual([
      '/tmp/d.sock',
      '/var/run/docker.sock',
      '~/.docker/run/docker.sock',
      '/run/user/1000/docker.sock',
      '/run/user/1000/podman/podman.sock'
    ])
    expect(localSocketCandidates({}, 'win32', null)).toEqual([WINDOWS_PIPE])
  })

  it('schema: thao tác thay đổi được nhận diện; id có ký tự shell bị chặn', () => {
    expect(isMutating(DockerOp.parse({ op: 'prune', what: 'images', dryRun: true }))).toBe(false)
    expect(isMutating(DockerOp.parse({ op: 'compose', project: 'x', action: 'up' }))).toBe(true)
    expect(DockerOp.safeParse({ op: 'inspect', kind: 'container', id: '$(reboot)' }).success).toBe(
      false
    )
    expect(DockerOp.safeParse({ op: 'image.pull', ref: '-rf' }).success).toBe(false)
  })
})

describe('bộ đệm log của tab', () => {
  it('nối mảnh vào dòng dở, tách stderr, giới hạn số dòng', () => {
    const b = new LineBuffer()
    b.push('a', false)
    b.push('b\nc', false)
    b.push('e1\n', true)
    b.push('\r\n', false)
    expect(b.all().map((l) => `${l.err ? 'E' : 'O'}:${l.text}`)).toEqual([
      'O:ab',
      'O:c',
      'E:e1',
      'O:'
    ])
    const big = new LineBuffer()
    big.push('x\n'.repeat(MAX_LINES + 10), false)
    expect(big.all()).toHaveLength(MAX_LINES)
  })
})
