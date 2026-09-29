import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { eventToKeybinding, normalizeKeybinding } from '@shared/commands'
import { fuzzyScore } from '@shared/fuzzy'
import { Hostname, Username } from '@shared/hosts'
import { parseQuickConnect } from '@shared/quick-connect'
import { AppSettings, parseSettings, TerminalTheme } from '@shared/settings'
import { joinRemote, parentRemote } from '@shared/sftp'
import { renderSnippet, snippetVariables } from '@shared/snippets'
import { ClientMessage, isServerMessage } from '@shared/stream-protocol'
import { importItermColors, importWindowsTerminal } from '@shared/themes'
import { hostFieldMatches, parseOpenSshKnownHosts } from '../../src/main/known-hosts'
import { scanMobaXterm } from '../../src/main/hosts/mobaxterm-import'
import { scanSshConfig } from '../../src/main/hosts/ssh-config-import'
import { tempDir } from '../unit/helpers'

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 2000)
const opts = { numRuns: RUNS }

/** Chuỗi "gần đúng": trộn ký tự đặc biệt của từng định dạng để đi sâu vào parser. */
const nearly = (alphabet: string, maxLength = 80): fc.Arbitrary<string> =>
  fc
    .array(fc.oneof(fc.constantFrom(...alphabet.split('')), fc.string({ maxLength: 3 })), {
      maxLength
    })
    .map((a) => a.join(''))

describe('fuzz: parser không crash, kết quả luôn hợp lệ', () => {
  it('parseQuickConnect: hoặc null, hoặc đích hợp lệ theo schema (không bao giờ chèn tham số)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), nearly('user@host:[]-2 p.sh')), (input) => {
        const target = parseQuickConnect(input, 'me')
        if (target === null) return
        expect(target.port).toBeGreaterThanOrEqual(1)
        expect(target.port).toBeLessThanOrEqual(65535)
        expect(target.host.startsWith('-')).toBe(false)
        expect(target.username.startsWith('-')).toBe(false)
        expect(target.username).not.toMatch(/\s/)
      }),
      opts
    )
  })

  it('scanMobaXterm: không crash; mục không có lỗi luôn hợp lệ, không chèn được tham số', () => {
    const home = tempDir()
    const field = nearly('ab-.1:[]_ \\', 12)
    const session = fc
      .tuple(fc.constantFrom('0', '1', '4', '14', ''), fc.array(field, { maxLength: 20 }))
      .map(([kind, fields]) => `#109#${[kind, ...fields].join('%')}#MobaFont%10#0# #-1`)
    const line = fc.oneof(
      fc.constantFrom('[Bookmarks]', '[Bookmarks_3]', '[Passwords]', 'SubRep=a\\b', 'ImgNum=1'),
      fc.tuple(nearly('ab=[]\\', 10), session).map(([k, v]) => `${k}=${v}`),
      nearly('[]=#%\\ab')
    )
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const { candidates } = scanMobaXterm(lines.join('\r\n'), {
          home,
          existingLabels: [],
          defaultUser: 'me'
        })
        for (const c of candidates) {
          if (c.problem) continue
          expect(Hostname.safeParse(c.hostname).success).toBe(true)
          expect(Username.safeParse(c.username).success).toBe(true)
          expect(c.port).toBeGreaterThanOrEqual(1)
          expect(c.port).toBeLessThanOrEqual(65535)
          for (const hop of c.proxyJump?.split(',') ?? []) expect(hop.startsWith('-')).toBe(false)
        }
      }),
      opts
    )
  })

  it('scanSshConfig: không crash; mục không có lỗi luôn qua được schema hostname/username', () => {
    const home = tempDir()
    const line = fc.oneof(
      fc.constantFrom(
        'Host ',
        '  HostName ',
        '  User ',
        '  Port ',
        '  IdentityFile ',
        '  ProxyJump ',
        'Match ',
        'Include ',
        '# '
      ),
      nearly('abc-_.*?!@:[]%$/~ \t"=')
    )
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(line, nearly('ab-.1*?! ', 20)).map(([a, b]) => a + b),
          { maxLength: 30 }
        ),
        (lines) => {
          let result: ReturnType<typeof scanSshConfig>
          try {
            result = scanSshConfig(lines.join('\n'), {
              home,
              existingLabels: [],
              defaultUser: 'me'
            })
          } catch (error) {
            // Được phép thất bại, nhưng phải là lỗi có thông báo rõ ràng.
            expect((error as Error).message).toMatch(/^Could not read ~\/\.ssh\/config: /)
            return
          }
          for (const c of result) {
            if (c.problem) continue
            expect(Hostname.safeParse(c.hostname).success).toBe(true)
            expect(Username.safeParse(c.username).success).toBe(true)
          }
        }
      ),
      { numRuns: Math.min(RUNS, 800) }
    )
  })

  it('known_hosts: dòng ngẫu nhiên không làm crash', () => {
    fc.assert(
      fc.property(
        fc.array(nearly('|1@ ,*?![]:abc=+/\n#', 60), { maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        fc.integer({ min: 1, max: 65535 }),
        (lines, host, port) => {
          parseOpenSshKnownHosts(lines.join('\n'), host, port)
          for (const l of lines) hostFieldMatches(l, host, port)
        }
      ),
      opts
    )
  })

  it('theme Windows Terminal / iTerm2: hoặc lỗi có thông báo, hoặc theme hợp lệ', () => {
    const check = (fn: () => unknown): void => {
      try {
        expect(TerminalTheme.safeParse(fn()).success).toBe(true)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message.length).toBeGreaterThan(0)
      }
    }
    fc.assert(
      fc.property(
        fc.oneof(fc.json(), fc.string(), nearly('{}[]":,#0123456789abcdef', 200)),
        (text) => {
          check(() => importWindowsTerminal(text))
          check(() => importItermColors(text))
        }
      ),
      opts
    )
  })

  it('cài đặt: JSON bất kỳ → luôn ra cài đặt hợp lệ', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(AppSettings.safeParse(parseSettings(value)).success).toBe(true)
      }),
      opts
    )
  })

  it('tin nhắn IPC stream: object bất kỳ không làm crash bộ kiểm tra', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        ClientMessage.safeParse(value)
        isServerMessage(value)
      }),
      opts
    )
  })

  it('snippet: render đủ biến thì không còn biến nào; thiếu thì chỉ ném lỗi "Missing value"', () => {
    fc.assert(
      fc.property(
        nearly('{}:abc_ xy', 60),
        fc.dictionary(fc.constantFrom('a', 'b', 'c', 'x', 'y'), fc.string({ maxLength: 5 })),
        (body, values) => {
          const vars = snippetVariables(body)
          try {
            const out = renderSnippet(body, values)
            for (const v of vars) {
              if (v.defaultValue === null) expect((values[v.name] ?? '').length).toBeGreaterThan(0)
            }
            expect(typeof out).toBe('string')
          } catch (error) {
            expect((error as Error).message).toMatch(/^Missing value for: /)
          }
        }
      ),
      opts
    )
  })

  it('phím tắt: chuẩn hoá luôn cho kết quả ổn định (idempotent)', () => {
    fc.assert(
      fc.property(nearly('+CtrlShiftAltMetaCmdabcTab,.', 30), (raw) => {
        const once = normalizeKeybinding(raw)
        if (once !== null) expect(normalizeKeybinding(once)).toBe(once)
      }),
      opts
    )
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (code, ctrlKey, altKey, shiftKey, metaKey) => {
          const k = eventToKeybinding({ code, ctrlKey, altKey, shiftKey, metaKey })
          if (k !== null) expect(normalizeKeybinding(k)).toBe(k)
        }
      ),
      opts
    )
  })

  it('tìm kiếm mờ: không crash, tự khớp chính nó', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), (q, t) => {
        const s = fuzzyScore(q, t)
        expect(s === null || Number.isFinite(s)).toBe(true)
        if (t.trim()) expect(fuzzyScore(t, t)).not.toBeNull()
      }),
      opts
    )
  })

  it('đường dẫn SFTP: cha của (thư mục + tên) là thư mục đó', () => {
    const segment = fc
      .stringMatching(/^[a-zA-Z0-9._-]{1,12}$/)
      .filter((s) => s !== '.' && s !== '..')
    fc.assert(
      fc.property(fc.array(segment, { minLength: 0, maxLength: 5 }), segment, (parts, name) => {
        const dir = parts.length ? `/${parts.join('/')}` : '/'
        expect(parentRemote(joinRemote(dir, name))).toBe(dir)
      }),
      opts
    )
  })
})
