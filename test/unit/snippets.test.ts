import { describe, expect, it } from 'vitest'
import { renderSnippet, snippetVariables } from '@shared/snippets'

describe('snippetVariables', () => {
  it('thứ tự xuất hiện, không trùng, lấy mặc định ở lần có ghi', () => {
    expect(
      snippetVariables('ssh {{user}}@{{host:db.local}} -p {{port:22}}; echo {{ user }} {{host}}')
    ).toEqual([
      { name: 'user', defaultValue: null },
      { name: 'host', defaultValue: 'db.local' },
      { name: 'port', defaultValue: '22' }
    ])
    expect(snippetVariables('không có biến {{ }} {x} {{1bad}}')).toEqual([])
  })

  it('mặc định có thể rỗng', () => {
    expect(snippetVariables('{{flag:}}')).toEqual([{ name: 'flag', defaultValue: '' }])
  })
})

describe('renderSnippet', () => {
  it('thay giá trị, dùng mặc định khi thiếu', () => {
    expect(renderSnippet('tail -n {{n:100}} {{file}}', { file: '/var/log/syslog' })).toBe(
      'tail -n 100 /var/log/syslog'
    )
    expect(renderSnippet('echo {{a}}{{a}}', { a: 'x' })).toBe('echo xx')
  })

  it('thiếu giá trị bắt buộc → lỗi rõ ràng', () => {
    expect(() => renderSnippet('rm {{path}}', {})).toThrow(/Missing value for: path/)
  })

  it('biến bắt buộc để trống → lỗi; muốn cho rỗng thì khai báo mặc định rỗng', () => {
    expect(() => renderSnippet('rm -rf /tmp/{{dir}}', { dir: '' })).toThrow(
      /Missing value for: dir/
    )
    expect(renderSnippet('ls {{opts:}}', { opts: '' })).toBe('ls ')
    expect(renderSnippet('ls {{opts:}}', {})).toBe('ls ')
  })

  it('giá trị chứa ký tự đặc biệt không bị hiểu thành biến lồng', () => {
    expect(renderSnippet('echo {{x}}', { x: '{{y}} $HOME' })).toBe('echo {{y}} $HOME')
  })
})
