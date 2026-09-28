import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Secret } from '../../src/node-shared/secret'

describe('Secret', () => {
  it('không lộ giá trị qua mọi cách chuyển sang chuỗi', () => {
    const s = Secret.fromString('hunter2-super-secret')
    const outputs = [
      String(s),
      JSON.stringify({ s }),
      inspect(s),
      inspect({ nested: { s } }, { depth: 5 })
    ]
    for (const out of outputs) expect(out).not.toContain('hunter2')
  })

  it('reveal trả giá trị; dispose ghi đè bằng 0', () => {
    const buf = Buffer.from('abc')
    const s = Secret.adopt(buf)
    expect(s.revealString()).toBe('abc')
    s.dispose()
    expect([...buf]).toEqual([0, 0, 0])
    expect(s.disposed).toBe(true)
    expect(() => s.reveal()).toThrow()
  })
})
