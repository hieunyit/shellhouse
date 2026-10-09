import { registerCatalog } from '.'
import { vi } from './vi'

/**
 * Nạp từ điển tiếng Việt ngay (import đầu tiên của main, Session Host, setup test). Renderer KHÔNG
 * dùng file này — nạp lười khi cần (renderer/src/i18n.ts).
 */
registerCatalog('vi', vi)
