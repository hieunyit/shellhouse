-- Runbook: danh sách bước kiểm tra (JSON trong `steps`) do người dùng soạn. Không chứa bí mật —
-- bước chỉ mang địa chỉ, lệnh kiểm tra và tham chiếu tới host / cluster / endpoint đã lưu.
CREATE TABLE runbook_runbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
