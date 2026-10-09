-- Giá trị bí mật của header HTTP (token, mật khẩu) — mã hoá bằng vault (ctx.secrets). Bước runbook chỉ
-- giữ id; giá trị không bao giờ về renderer và không có trong file xuất.
CREATE TABLE runbook_secrets (
  id TEXT PRIMARY KEY,
  value_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
