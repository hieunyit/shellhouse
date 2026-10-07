-- Bỏ qua kiểm tra chứng chỉ TLS của API server cho context (khi kubeconfig không ghi
-- insecure-skip-tls-verify mà máy chủ dùng chứng chỉ tự ký / proxy công ty chặn TLS).
ALTER TABLE k8s_contexts ADD COLUMN insecure INTEGER NOT NULL DEFAULT 0;
