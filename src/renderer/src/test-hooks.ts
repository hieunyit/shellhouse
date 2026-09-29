import { TEST_HOOKS_GLOBAL, type ShellhouseTestHooks } from '@shared/test-hooks'
import { useTabs } from './stores/tabs'
import { controllers } from './terminal/registry'

let maxLongTask = 0

/** Chỉ cài khi main báo testHooks = true (bản dev + SHELLHOUSE_TEST_HOOKS=1). */
export function installTestHooks(): void {
  // Đo độ trễ của timer: main thread bị chặn bao lâu thì timer trễ bấy nhiêu.
  // (PerformanceObserver 'longtask' không báo gì trong Electron khi chạy từ file://.)
  const INTERVAL = 20
  let last = performance.now()
  window.setInterval(() => {
    const now = performance.now()
    maxLongTask = Math.max(maxLongTask, now - last - INTERVAL)
    last = now
  }, INTERVAL)

  const hooks: ShellhouseTestHooks = {
    tabIds: () => useTabs.getState().tabs.map((t) => t.id),
    activeTabId: () => useTabs.getState().activeId,
    bufferText: (tabId, lastLines) => {
      const term = controllers.get(tabId)?.term
      if (!term) return ''
      const buffer = term.buffer.active
      const start = lastLines ? Math.max(0, buffer.length - lastLines) : 0
      const lines: string[] = []
      for (let i = start; i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
      }
      return lines.join('\n')
    },
    size: (tabId) => {
      const term = controllers.get(tabId)?.term
      return term ? { cols: term.cols, rows: term.rows } : null
    },
    renderer: (tabId) => controllers.get(tabId)?.renderer ?? null,
    reconnect: (tabId) => {
      controllers.get(tabId)?.reconnect()
    },
    terminalOptions: (tabId) => {
      const term = controllers.get(tabId)?.term
      if (!term) return null
      return {
        fontSize: term.options.fontSize ?? 0,
        background: term.options.theme?.background ?? '',
        cursorStyle: term.options.cursorStyle ?? ''
      }
    },
    state: (tabId) => controllers.get(tabId)?.connectionState ?? null,
    sendInput: (tabId, data) => {
      controllers.get(tabId)?.sendInput(data)
    },
    measureEchoLatency: async (tabId, samples) => {
      const controller = controllers.get(tabId)
      if (!controller) throw new Error(`No tab ${tabId}`)
      return controller.measureEchoLatency(samples)
    },
    sftp: (tabId, op) => {
      const controller = controllers.get(tabId)
      if (!controller) return Promise.reject(new Error(`No tab ${tabId}`))
      return controller.sftp(op)
    },
    startForward: (tabId, spec) => {
      controllers.get(tabId)?.startForward(spec)
    },
    jsHeapBytes: () => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return memory ? memory.usedJSHeapSize : null
    },
    maxLongTaskMs: (reset) => {
      const value = maxLongTask
      if (reset) maxLongTask = 0
      return value
    }
  }
  Object.defineProperty(window, TEST_HOOKS_GLOBAL, { value: hooks })
}
