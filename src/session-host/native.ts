import { createRequire } from 'node:module'

const nodeRequire = createRequire(__filename)

/**
 * Nạp native module (CommonJS) bằng require thật.
 * `import()` động đi qua lớp ESM interop và làm mất các export gán động
 * (ví dụ hằng số của sodium-native), nên không dùng cho native module.
 */
export function loadNative(id: string): unknown {
  return nodeRequire(id)
}
