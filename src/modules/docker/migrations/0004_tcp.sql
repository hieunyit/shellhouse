-- Engine Docker ở địa chỉ TCP + TLS (tcp://host:2376). CA, chứng chỉ client và khoá riêng nằm trong
-- vault (mã hoá như mật khẩu registry); hạn dùng và chủ thể là thông tin công khai của chứng chỉ,
-- lưu rõ để hiện ở danh sách mà không phải giải mã khoá.
CREATE TABLE docker_tcp (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  ca_enc BLOB,
  cert_enc BLOB,
  key_enc BLOB,
  cert_expires INTEGER,
  cert_subject TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
