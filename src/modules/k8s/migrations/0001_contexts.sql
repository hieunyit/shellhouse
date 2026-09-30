-- Tuỳ chọn theo context (ADR-014 mục 7.3): tham chiếu (nguồn + tên context), host SSH làm bastion,
-- namespace mặc định, chỉ đọc, màu. Không lưu tài nguyên cluster.
CREATE TABLE k8s_contexts (
  key TEXT PRIMARY KEY,
  bastion_host_id TEXT,
  namespace TEXT,
  read_only INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  updated_at INTEGER NOT NULL
);

-- Kubeconfig người dùng import (dán vào): nội dung mã hoá bằng vault.
CREATE TABLE k8s_kubeconfigs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yaml_enc BLOB NOT NULL,
  added_at INTEGER NOT NULL
);
