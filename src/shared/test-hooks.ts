/** API chỉ có khi chạy với SHELLHOUSE_TEST_HOOKS=1 (E2E, benchmark). */
import type { ForwardSpec } from './forwards'
import type { SftpOp } from './sftp'

export interface ShellhouseTestHooks {
  tabIds(): string[]
  activeTabId(): string | null
  /** Toàn bộ nội dung buffer (đã bỏ khoảng trắng cuối dòng). */
  bufferText(tabId: string, lastLines?: number): string
  size(tabId: string): { cols: number; rows: number } | null
  renderer(tabId: string): 'webgl' | 'dom' | null
  /** Tuỳ chọn xterm đang áp dụng (kiểm tra cài đặt có được áp dụng ngay không). */
  terminalOptions(
    tabId: string
  ): { fontSize: number; background: string; cursorStyle: string } | null
  state(
    tabId: string
  ): 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited' | null
  sendInput(tabId: string, data: string): void
  /** Gõ từng ký tự và đo thời gian tới khi echo được vẽ ra (ms). */
  measureEchoLatency(tabId: string, samples: number): Promise<number[]>
  /** Chạy thao tác SFTP trên kết nối của tab (soak test). */
  sftp(tabId: string, op: SftpOp): Promise<unknown>
  startForward(tabId: string, spec: ForwardSpec): void
  /** Heap JS của renderer (byte), nếu Chromium cho đọc. */
  jsHeapBytes(): number | null
  /** Lần main thread bị chặn lâu nhất (độ trễ timer) kể từ lần reset gần nhất (ms). */
  maxLongTaskMs(reset?: boolean): number
}

export const TEST_HOOKS_GLOBAL = '__shellhouseTest'
