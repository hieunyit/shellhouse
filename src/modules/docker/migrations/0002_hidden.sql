-- Ẩn một nguồn khỏi thanh bên (distro WSL đang chạy được liệt kê tự động — người dùng có thể ẩn).
ALTER TABLE docker_endpoints ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
