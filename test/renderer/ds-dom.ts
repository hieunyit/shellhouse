/**
 * Chuẩn bị jsdom cho test component của design system (Radix cần vài API trình duyệt jsdom không
 * có). Nhập ở đầu file test có `// @vitest-environment jsdom`.
 */
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const g = globalThis as Record<string, unknown>
g['ResizeObserver'] ??= ResizeObserverStub
g['IS_REACT_ACT_ENVIRONMENT'] = true

const proto = Element.prototype as unknown as Record<string, unknown>
proto['scrollIntoView'] ??= function scrollIntoView(): void {}
proto['hasPointerCapture'] ??= function hasPointerCapture(): boolean {
  return false
}
proto['releasePointerCapture'] ??= function releasePointerCapture(): void {}
proto['setPointerCapture'] ??= function setPointerCapture(): void {}

afterEach(() => {
  cleanup()
})
