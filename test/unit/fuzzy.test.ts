import { describe, expect, it } from 'vitest'
import { bestScore, fuzzyScore } from '@shared/fuzzy'

describe('fuzzyScore', () => {
  it('khớp theo thứ tự, không phân biệt hoa thường', () => {
    expect(fuzzyScore('pdb', 'Prod-DB-01')).not.toBeNull()
    expect(fuzzyScore('bdp', 'Prod-DB-01')).toBeNull()
    expect(fuzzyScore('', 'x')).toBe(0)
  })

  it('xếp hạng: trùng khít > tiền tố > đầu từ > rải rác', () => {
    const exact = fuzzyScore('web', 'web') ?? 0
    const prefix = fuzzyScore('web', 'web-01') ?? 0
    const word = fuzzyScore('web', 'prod-web') ?? 0
    const scattered = fuzzyScore('web', 'w-e-b-x') ?? 0
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(scattered)
  })

  it('bỏ dấu tiếng Việt ở cả hai phía', () => {
    expect(fuzzyScore('chao', 'Chào hỏi')).not.toBeNull()
    expect(fuzzyScore('dong', 'Đồng bộ')).not.toBeNull()
    expect(fuzzyScore('máy', 'may-chu-web')).not.toBeNull()
    expect(fuzzyScore('chao', 'chào')).toBe(fuzzyScore('chao', 'chao'))
  })

  it('bestScore lấy trường khớp tốt nhất', () => {
    expect(bestScore('10.0', ['web', '10.0.0.5'])).not.toBeNull()
    expect(bestScore('zzz', ['web', 'db'])).toBeNull()
  })
})
