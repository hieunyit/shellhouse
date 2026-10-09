// Phải là import đầu tiên: đặt ngôn ngữ trước khi module khác tính chuỗi giao diện.
import { loadCatalog } from './i18n'
import './styles.css'

// Từ điển trước, app sau (boot.tsx): mọi chuỗi — kể cả chuỗi tính lúc nạp module — đã được dịch.
void loadCatalog()
  // Không tải được từ điển: vẫn mở app (tiếng Anh) thay vì cửa sổ trắng.
  .catch(() => undefined)
  .then(() => import('./boot'))
