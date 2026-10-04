// Phải là import đầu tiên: đặt ngôn ngữ trước khi module khác tính chuỗi giao diện.
import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { VaultGate } from './components/VaultGate'
import { ErrorBoundary } from './components/ErrorBoundary'
import { setAppInfo } from './lib/platform'
import { installTestHooks } from './test-hooks'
import './styles.css'
// Áp theme sáng/tối lên <html> ngay khi có cài đặt.
import './stores/appearance'
import { registerRendererModules, startModules } from '../../modules/registry/renderer-kit'
import { RENDERER_MODULES } from '../../modules/registry/all-renderer'
import { preloadTerminal } from './lazy'
import { applyTestDefaults } from './stores/sidebar-layout'

// Module chính thức (ADR-014): đăng ký trước lần vẽ đầu, trạng thái bật / tắt lấy từ main.
registerRendererModules(RENDERER_MODULES)
startModules()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

/**
 * Nạp font nhúng trước khi vẽ: xterm.js đo kích thước ô chữ một lần lúc mở terminal, nếu font chưa
 * sẵn sàng thì lưới chữ bị lệch. Font nằm trong app nên thường xong trong vài ms; tối đa chờ 1,5 s.
 */
function loadFonts(): Promise<unknown> {
  const fonts = [
    '400 13px "Inter Variable"',
    '600 13px "Inter Variable"',
    '400 14px "JetBrains Mono Variable"',
    '700 14px "JetBrains Mono Variable"'
  ]
  return Promise.race([
    Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ])
}

// Chunk terminal bắt đầu nạp ngay, song song với chờ font / thông tin app (không chặn lần vẽ đầu):
// tab local mở lúc khởi động thường đã có xterm sẵn. Lỗi nạp bỏ qua — lazy sẽ thử lại khi mount.
void preloadTerminal().catch(() => undefined)

void Promise.all([window.shellhouse.getInfo(), loadFonts()]).then(([info]) => {
  setAppInfo(info)
  // CSS chừa chỗ cho nút điều khiển cửa sổ theo nền tảng (cửa sổ không có thanh tiêu đề).
  document.documentElement.dataset['platform'] = info.platform
  if (info.testHooks) {
    installTestHooks()
    applyTestDefaults()
  }
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary label="window">
        <VaultGate>
          <App />
        </VaultGate>
      </ErrorBoundary>
    </StrictMode>
  )
})
