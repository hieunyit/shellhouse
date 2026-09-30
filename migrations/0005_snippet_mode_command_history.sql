-- Snippet: 'paste' = dán nguyên khối (như trước); 'macro' = gửi từng dòng, chờ dấu nhắc lệnh giữa
-- các dòng (chạy song song trên các terminal của MultiExec).
ALTER TABLE snippets ADD COLUMN mode TEXT NOT NULL DEFAULT 'paste';

-- Lịch sử lệnh theo đích kết nối (gợi ý lệnh khi gõ). target = id host đã lưu, "ssh:user@host:port"
-- (kết nối nhanh) hoặc "local:<shell>". Lệnh gõ trùng thì tăng count, cập nhật used_at.
CREATE TABLE command_history (
  target TEXT NOT NULL,
  command TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (target, command)
);
CREATE INDEX command_history_recent ON command_history (target, used_at DESC);
