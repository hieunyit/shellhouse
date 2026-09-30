-- Nguồn Docker người dùng đã thêm: 'local' (máy này) hoặc một host SSH đã lưu. Chỉ lưu tham chiếu
-- và tuỳ chọn — không có bí mật (kết nối SSH dùng thông tin của host).
CREATE TABLE docker_endpoints (
  id TEXT PRIMARY KEY,
  host_id TEXT,
  read_only INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
