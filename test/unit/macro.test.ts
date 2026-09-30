import { describe, expect, it } from 'vitest'
import { looksLikePrompt, parseMacro } from '@shared/macro'

describe('parseMacro', () => {
  it('dòng lệnh, # wait, # expect; bỏ ghi chú và dòng trống', () => {
    expect(
      parseMacro(
        [
          '# Cập nhật nginx trên mọi server',
          'sudo apt update',
          '# expect password for',
          'mật-khẩu',
          '',
          '# wait 2.5',
          'sudo systemctl reload nginx',
          ' '
        ].join('\n')
      )
    ).toEqual([
      { kind: 'send', line: 'sudo apt update' },
      { kind: 'expect', text: 'password for' },
      { kind: 'send', line: 'mật-khẩu' },
      { kind: 'wait', ms: 2500 },
      { kind: 'send', line: 'sudo systemctl reload nginx' },
      { kind: 'send', line: '' } // dòng chỉ có dấu cách = Enter trống
    ])
  })

  it('# wait có giới hạn trên', () => {
    expect(parseMacro('# wait 99999')).toEqual([{ kind: 'wait', ms: 600_000 }])
  })
})

describe('looksLikePrompt', () => {
  it.each([
    'user@host:~$ ',
    'root@db:/var/log# ',
    'router#',
    'switch>',
    'PS C:\\Users\\me> ',
    'me@mac ~ % ',
    '[admin@fw01] > ',
    'Password:',
    '[sudo] password for me: '
  ])('dấu nhắc: %j', (line) => {
    expect(looksLikePrompt(line)).toBe(true)
  })

  it.each(['', 'Reading package lists... Done', 'Downloading 42%', ' --More-- '])(
    'không phải dấu nhắc: %j',
    (line) => {
      expect(looksLikePrompt(line)).toBe(false)
    }
  )
})
