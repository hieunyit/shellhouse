-- Mạng theo tài khoản: bỏ qua kiểm tra chứng chỉ TLS (MinIO / Ceph tự ký, CA nội bộ) và kết nối
-- thẳng (không đi qua proxy của app — Settings › Network).
ALTER TABLE s3_accounts ADD COLUMN insecure_tls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE s3_accounts ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;
