-- Khuôn module (ADR-014): lịch sử migration riêng của từng module. Bảng của module có tiền tố
-- `<id>_`; migration của module không nằm trong danh sách chung (user_version).
CREATE TABLE module_migrations (
  module_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (module_id, version)
);

-- S3 có từ trước khuôn module: bảng đã được migration 0006 / 0007 tạo (đã phát hành — không sửa),
-- nên ghi sẵn là module `s3` đã chạy v1 (accounts) và v2 (pins).
INSERT INTO module_migrations (module_id, version, name, applied_at) VALUES
  ('s3', 1, 'accounts', 0),
  ('s3', 2, 'pins', 0);

-- Người dùng cho / không cho module chạy một chương trình trên máy (ADR-014 mục 3.6). Nhớ theo
-- đường dẫn + hash file: chương trình bị thay → hỏi lại.
CREATE TABLE module_program_grants (
  module_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (module_id, path)
);
