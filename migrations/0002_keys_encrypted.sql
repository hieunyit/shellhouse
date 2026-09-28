-- Đánh dấu private key có passphrase (để UI nhắc nhập passphrase).
ALTER TABLE keys ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
