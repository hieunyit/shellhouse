import { describe, expect, it } from 'vitest'
import {
  compareApiVersions,
  DEFAULT_API_VERSION,
  EngineError,
  MAX_API_VERSION,
  negotiateApiVersion,
  versionFromError
} from '../../session-host/engine'
import { isAnonymousVolume } from '../../session-host/backend'
import { parseLabels } from '../../session-host/cli-backend'
import { isTransportError } from '../../session-host/service'
import { DockerOp, DockerTerminalParams, RunSpec } from '../../shared/ops'
import { splitShellWords, trySplitShellWords } from '../../shared/shell-words'
import { confirmFor, groupProjects, namesText, sortList } from '../../shared/view-model'
import type { ContainerRow } from '../../shared/ops'

function row(name: string, extra: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: `${name}-id`,
    name,
    image: 'nginx',
    state: 'running',
    status: 'Up',
    health: null,
    created: 0,
    ports: [],
    project: null,
    service: null,
    composeDir: null,
    composeFiles: null,
    ...extra
  }
}

describe('phiên bản Engine API', () => {
  it('so sánh, thương lượng: min(server, bản mình hỗ trợ); server không báo → mặc định', () => {
    expect(compareApiVersions('1.44', '1.41')).toBeGreaterThan(0)
    expect(compareApiVersions('1.9', '1.10')).toBeLessThan(0)
    expect(compareApiVersions('v1.41', '1.41')).toBe(0)
    expect(negotiateApiVersion('1.52')).toBe(MAX_API_VERSION)
    expect(negotiateApiVersion('1.43')).toBe('1.43')
    expect(negotiateApiVersion('1.40')).toBe('1.40')
    expect(negotiateApiVersion('')).toBe(DEFAULT_API_VERSION)
    expect(negotiateApiVersion('rác')).toBe(DEFAULT_API_VERSION)
  })

  it('lỗi "client version … is too old / too new" → phiên bản server nêu; lỗi khác → null', () => {
    expect(
      versionFromError(
        400,
        'client version 1.41 is too old. Minimum supported API version is 1.44, please upgrade your client to a newer version'
      )
    ).toBe('1.44')
    expect(
      versionFromError(400, 'client version 1.47 is too new. Maximum supported API version is 1.40')
    ).toBe('1.40')
    expect(versionFromError(404, 'client version 1.41 is too old. Minimum … is 1.44')).toBeNull()
    expect(versionFromError(400, 'No such container')).toBeNull()
  })
})

describe('volume ẩn danh, nhãn CLI', () => {
  it('nhãn của Docker ≥ 23 hoặc tên 64 hex là ẩn danh; volume có tên thì không', () => {
    expect(isAnonymousVolume('data', { 'com.docker.volume.anonymous': '' })).toBe(true)
    expect(isAnonymousVolume('f'.repeat(64), null)).toBe(true)
    expect(isAnonymousVolume('shop_data', { 'com.docker.compose.project': 'shop' })).toBe(false)
    expect(isAnonymousVolume('F'.repeat(64), null)).toBe(false)
  })

  it('config_files nhiều file (có dấu phẩy) không mất file sau', () => {
    const labels = parseLabels(
      'com.docker.compose.project=shop,com.docker.compose.project.config_files=/srv/a.yml,/srv/b.override.yml,com.docker.compose.service=web'
    )
    expect(labels['com.docker.compose.project.config_files']).toBe('/srv/a.yml,/srv/b.override.yml')
    expect(labels['com.docker.compose.service']).toBe('web')
    expect(parseLabels('com.docker.volume.anonymous=')).toEqual({
      'com.docker.volume.anonymous': ''
    })
    expect(parseLabels('')).toEqual({})
  })
})

describe('schema', () => {
  it('id / tên bắt đầu bằng "-" bị chặn (không thành tuỳ chọn của CLI)', () => {
    for (const id of ['-f', '--rm', '-v=/:/host', '.hidden', '_x'])
      expect(DockerOp.safeParse({ op: 'action', id, action: 'remove' }).success).toBe(false)
    expect(DockerOp.safeParse({ op: 'action', id: 'web-1', action: 'remove' }).success).toBe(true)
    expect(DockerOp.safeParse({ op: 'volume.remove', name: '--all' }).success).toBe(false)
    expect(DockerTerminalParams.safeParse({ container: '-u' }).success).toBe(false)
    expect(DockerOp.safeParse({ op: 'compose', project: '-p', action: 'down' }).success).toBe(false)
  })

  it('run: --rm chỉ đi với restart "no"', () => {
    const base = {
      image: 'nginx',
      ports: [],
      env: [],
      volumes: [],
      pull: true
    }
    expect(RunSpec.safeParse({ ...base, restart: 'no', autoRemove: true }).success).toBe(true)
    expect(RunSpec.safeParse({ ...base, restart: 'always', autoRemove: false }).success).toBe(true)
    expect(
      RunSpec.safeParse({ ...base, restart: 'unless-stopped', autoRemove: true }).success
    ).toBe(false)
    expect(
      DockerOp.safeParse({ op: 'run', spec: { ...base, restart: 'always', autoRemove: true } })
        .success
    ).toBe(false)
  })
})

describe('tách lệnh kiểu shell', () => {
  it('nháy kép / đơn giữ khoảng trắng; thoát; từ rỗng', () => {
    expect(splitShellWords('sh -c "echo a b"')).toEqual(['sh', '-c', 'echo a b'])
    expect(splitShellWords(`psql -U postgres -c 'select 1, 2'`)).toEqual([
      'psql',
      '-U',
      'postgres',
      '-c',
      'select 1, 2'
    ])
    expect(splitShellWords('echo a\\ b')).toEqual(['echo', 'a b'])
    expect(splitShellWords('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"'])
    expect(splitShellWords(`echo 'it''s'`)).toEqual(['echo', 'its'])
    expect(splitShellWords(`echo "a'b" 'c"d'`)).toEqual(['echo', "a'b", 'c"d'])
    expect(splitShellWords('echo "" x')).toEqual(['echo', '', 'x'])
    expect(splitShellWords('  a   b\t c\n')).toEqual(['a', 'b', 'c'])
    expect(splitShellWords('echo "$HOME \\$x"')).toEqual(['echo', '$HOME $x'])
    expect(splitShellWords("echo '\\n'")).toEqual(['echo', '\\n'])
    expect(splitShellWords('')).toEqual([])
  })

  it('nháy chưa đóng → lỗi (giao diện khoá nút)', () => {
    expect(() => splitShellWords('sh -c "echo')).toThrow(/double quote/)
    expect(trySplitShellWords("echo 'x")).toBeNull()
    expect(trySplitShellWords('ls -la')).toEqual(['ls', '-la'])
  })
})

describe('xác nhận thao tác nguy hiểm', () => {
  it('xoá container đang chạy nói rõ force; có tuỳ chọn volume ẩn danh', () => {
    const c = confirmFor('remove', [row('web'), row('job', { state: 'exited' })], false)
    expect(c?.danger).toBe(true)
    expect(c?.confirmLabel).toBe('Force remove')
    expect(c?.message).toMatch(/web is running and will be stopped first/)
    expect(c?.volumesOption).toBe(true)
    expect(confirmFor('remove', [row('job', { state: 'exited' })], false)?.confirmLabel).toBe(
      'Remove'
    )
  })

  it('stop / restart: hỏi khi bấm phím tắt, không hỏi khi bấm nút', () => {
    expect(confirmFor('stop', [row('web')], true)?.title).toBe('Stop web?')
    expect(confirmFor('restart', [row('web')], true)?.confirmLabel).toBe('Restart')
    expect(confirmFor('stop', [row('web')], false)).toBeNull()
    expect(confirmFor('start', [row('web')], true)).toBeNull()
    expect(confirmFor('kill', [row('web')], false)?.danger).toBe(true)
  })

  it('Production: stop / restart / pause luôn hỏi và là thao tác nguy hiểm (gõ tên); start thì không', () => {
    for (const action of ['stop', 'restart', 'pause'] as const) {
      const c = confirmFor(action, [row('web')], false, true)
      expect(c?.danger).toBe(true)
    }
    expect(confirmFor('stop', [row('web')], false, true)?.title).toBe('Stop web?')
    expect(confirmFor('start', [row('web')], false, true)).toBeNull()
    expect(confirmFor('unpause', [row('web')], false, true)).toBeNull()
    // Không phải Production: như cũ (phím tắt hỏi thường, nút thì không hỏi).
    expect(confirmFor('stop', [row('web')], true, false)?.danger).toBe(false)
    expect(confirmFor('pause', [row('web')], false, false)).toBeNull()
  })

  it('danh sách tên dài được rút gọn', () => {
    expect(namesText(['a', 'b'])).toBe('a, b')
    expect(namesText(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
  })
})

describe('danh sách tab Docker', () => {
  it('nhóm Compose theo project, lọc, sắp theo tên', () => {
    const list = [
      row('b1', { project: 'beta', service: 'web' }),
      row('a1', { project: 'alpha', service: 'db', state: 'exited' }),
      row('a2', { project: 'alpha', service: 'web' }),
      row('solo')
    ]
    const projects = groupProjects(list, '')
    expect(projects.map((p) => [p.name, p.services, p.running])).toEqual([
      ['alpha', 2, 1],
      ['beta', 1, 1]
    ])
    expect(groupProjects(list, 'bet').map((p) => p.name)).toEqual(['beta'])
  })

  it('sắp theo tên (số tự nhiên), ngày, số; đảo chiều', () => {
    const items = [
      { n: 'web10', t: 3, v: 1 },
      { n: 'web2', t: 1, v: 3 },
      { n: 'api', t: 2, v: 2 }
    ]
    const by = (key: 'name' | 'created' | 'cpu', dir: 'asc' | 'desc'): string[] =>
      sortList(
        items,
        { key, dir },
        (x) => x.n,
        (x) => x.t,
        { cpu: (x) => x.v }
      ).map((x) => x.n)
    expect(by('name', 'asc')).toEqual(['api', 'web2', 'web10'])
    expect(by('created', 'desc')).toEqual(['web10', 'api', 'web2'])
    expect(by('cpu', 'asc')).toEqual(['web10', 'api', 'web2'])
  })
})

describe('lỗi đường truyền', () => {
  it('socket mất / kênh SSH đóng là lỗi đường truyền; lỗi Docker (HTTP) thì không', () => {
    expect(isTransportError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(
      true
    )
    expect(isTransportError(new Error('socket hang up'))).toBe(true)
    expect(isTransportError(new EngineError(404, 'No such container'))).toBe(false)
    expect(isTransportError(new Error('pull access denied'))).toBe(false)
  })
})
