-- Tài khoản S3 / tương thích S3 cho trình quản lý S3. Secret key mã hoá bằng vault (như mật khẩu
-- host); access key ID không phải bí mật.
CREATE TABLE s3_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL,
  secret_enc BLOB,
  path_style INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
