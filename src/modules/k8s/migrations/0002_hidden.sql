-- Ẩn context khỏi thanh bên (vẫn còn trong kubeconfig — như "hide" của Lens).
ALTER TABLE k8s_contexts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
