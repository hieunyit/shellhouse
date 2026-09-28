import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { uuidv7 } from '../../src/node-shared/uuid'

describe('uuidv7', () => {
  it('đúng định dạng v7 và hợp lệ theo zod', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(z.uuid().safeParse(id).success).toBe(true)
  })

  it('sắp xếp theo thời gian và không trùng', () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)]
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000)
  })
})
