-- Thông tin đăng nhập registry (Docker Hub, GHCR, registry riêng) để kéo / đẩy image riêng tư.
-- Mật khẩu / token mã hoá bằng vault (như secret key S3); tên đăng nhập không phải bí mật.
CREATE TABLE docker_registries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server TEXT NOT NULL,
  username TEXT NOT NULL,
  secret_enc BLOB,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
