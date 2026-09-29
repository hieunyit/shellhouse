-- Nhóm: giá trị mặc định cho host bên trong (JSON — username, port, keyId, jumpHostIds, color),
-- host kế thừa từ nhóm gần nhất có đặt giá trị đó. Xem ADR-010.
ALTER TABLE groups ADD COLUMN defaults TEXT NOT NULL DEFAULT '{}';
-- Host: đánh dấu yêu thích (mục Favorites trên sidebar) và thứ tự sắp xếp thủ công trong nhóm
-- (0 = chưa sắp, xếp theo tên).
ALTER TABLE hosts ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosts ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
